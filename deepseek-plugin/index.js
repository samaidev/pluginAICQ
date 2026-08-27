/**
 * dsh-aicq — AICQ End-to-end Encrypted Chat plugin for DeepSeek Harness
 * ======================================================================
 *
 * Function-form Cordis plugin (repo AGENTS.md contract):
 *   - named exports `name` / `inject` / `Config` / `apply`
 *   - NO default export (mixing forms makes the Loader drop the namespace)
 *
 * What it does
 *   1. Registers model-facing tools (`aicq_chat_send`, `aicq_friends_list`,
 *      `aicq_friend_add`, `aicq_chat_history`, `aicq_chat_send_file`,
 *      `aicq_status`) through `ctx.tools.register(defineTool(...))`.
 *   2. Keeps a WebSocket session with the AICQ signaling server so inbound
 *      messages arrive live; each message drives the agent via
 *      `agent.followup(createUserMessage(...))` and the agent's reply is
 *      routed back to the AICQ sender once the turn reaches idle.
 *
 * The protocol stack under lib/ is CommonJS and shared verbatim with the
 * openclaw/codex plugins (identity + sql.js store + NaCl E2EE + HTTP/WS
 * signaling + handshake + chat manager), so behaviour stays identical
 * across hosts.
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import url from 'node:url'

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

// ── CJS protocol stack (lib/package.json declares {"type":"commonjs"}) ──
const PluginDatabase = require(path.join(__dirname, 'lib', 'database'))
const IdentityManager = require(path.join(__dirname, 'lib', 'identity'))
const ServerClient = require(path.join(__dirname, 'lib', 'server-client'))
const HandshakeManager = require(path.join(__dirname, 'lib', 'handshake'))
const ChatManager = require(path.join(__dirname, 'lib', 'chat'))

export const name = 'aicq'
export const inject = ['tools', 'agents']

/** Fallback resident-agent model id (env-tunable; the AICQ shim accepts any id). */
const RESIDENT_MODEL = process.env.DSH_AICQ_MODEL || 'glm-4-plus'

export const Config = Schema.object({
  serverUrl: Schema.string().default('https://aicq.me')
    .description('AICQ signaling server URL'),
  dataDir: Schema.string().default('')
    .description('Directory for identity/db/files. Empty = ~/.dsh-aicq'),
  masterNumber: Schema.string().default('')
    .description('AICQ number to auto-add as friend on startup (e.g. "1000000")'),
  autoAcceptFriends: Schema.boolean().default(true)
    .description('Auto-accept incoming friend requests'),
  notifyAgentId: Schema.string().default('')
    .description('Session id of the agent that receives inbound AICQ messages. Empty = first registered agent.'),
})

const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || 'unknown'
  } catch {
    return 'unknown'
  }
})()

let _ready /* Promise<void> | undefined */
let _db, _identity, _serverClient, _handshake, _chat
let _agentId = 'dsh-aicq'
// [fix 2026-08-27] inbound callback must be attached the moment ChatManager
// exists -- WS traffic can arrive between connect() and apply()'s
// `.then(setOnNewMessage)` window, which previously dropped those messages.
let _onInbound = null

function log(msg) {
  console.error(`[dsh-aicq] ${msg}`)
}

async function ensureClient(config) {
  if (_ready) return _ready

  _ready = (async () => {
    const dataDir = config.dataDir && String(config.dataDir).trim()
      ? path.resolve(String(config.dataDir))
      : path.join(os.homedir(), '.dsh-aicq')
    const uploadsDir = path.join(dataDir, 'uploads')
    const userfilesDir = path.join(dataDir, 'userfiles')
    fs.mkdirSync(uploadsDir, { recursive: true })
    fs.mkdirSync(userfilesDir, { recursive: true })

    _db = new PluginDatabase(dataDir)
    await _db.init()
    log(`SQLite store ready at ${dataDir}`)

    _identity = new IdentityManager(_db)
    if (_identity.listAgents().length === 0) {
      _identity.createAgent(_agentId, 'AICQ DSH Agent')
    }
    const agents = _identity.listAgents()
    _agentId = agents.length > 0 ? agents[0].agent_id : _agentId

    _serverClient = new ServerClient(_identity, _db, config.serverUrl)
    _handshake = new HandshakeManager(_identity, _serverClient, _db)
    _chat = new ChatManager(_identity, _serverClient, _db, uploadsDir, userfilesDir)
    if (_onInbound) {
      _chat.setOnNewMessage(_onInbound)
    }

    await _serverClient.ensureAuth(_agentId)
    log(`authenticated as ${_agentId} @ ${config.serverUrl}`)

    if (typeof _serverClient.start === 'function') {
      await _serverClient.start(_agentId)
    } else {
      _serverClient.connectWS()
    }

    if (config.autoAcceptFriends && typeof _chat.setOnAutoAccept === 'function') {
      _chat.setOnAutoAccept(async (req) => {
        try {
          await _handshake.acceptRequest(_agentId, req.request_id ?? req.session_id ?? req.id)
        } catch (e) {
          log(`auto-accept failed: ${e.message}`)
        }
      })
    }

    if (config.masterNumber) {
      addFriendByNumber(config.masterNumber).catch((e) =>
        log(`auto-add master ${config.masterNumber} failed: ${e.message}`))
    }
    log(`client connected (plugin v${PLUGIN_VERSION})`)
  })()
  return _ready
}

function closeClient() {
  try {
    if (_serverClient) {
      if (typeof _serverClient.stop === 'function') _serverClient.stop()
      else if (typeof _serverClient.disconnect === 'function') _serverClient.disconnect()
    }
  } catch {}
  try {
    if (_db && typeof _db.close === 'function') _db.close()
  } catch {}
  _ready = undefined
  _db = _identity = _serverClient = _handshake = _chat = undefined
  log('client closed')
}

async function syncFriendsFromServer() {
  await _serverClient.ensureAuth(_agentId)
  const result = await _serverClient.listFriends()
  if (!result || !Array.isArray(result.friends)) return []
  for (const f of result.friends) {
    if (!_db.getFriend(_agentId, f.id)) {
      _db.addFriend({
        agent_id: _agentId,
        id: f.id,
        public_key: f.public_key || f.publicKey || '',
        fingerprint: f.fingerprint || '',
        friend_type: f.type || f.friend_type || 'ai',
        ai_name: f.agent_name || f.ai_name || f.displayName || '',
      })
    } else {
      _db.updateFriendOnline(_agentId, f.id, !!f.is_online)
    }
  }
  return result.friends
}

async function addFriendByNumber(aicqNumber, message) {
  await _serverClient.ensureAuth(_agentId)
  const result = await _serverClient.sendFriendRequest(
    String(aicqNumber),
    message || "Hi, I'd like to add you as a friend!",
  )
  if (result && result.status === 'accepted' && result.to_id) {
    _db.addFriend({
      agent_id: _agentId,
      id: result.to_id,
      public_key: '',
      fingerprint: '',
      friend_type: 'human',
      ai_name: '',
    })
  }
  return {
    success: true,
    request_id: result ? (result.id ?? result.request_id) : undefined,
    status: result ? result.status : undefined,
    to_id: result ? result.to_id : undefined,
  }
}

/**
 * Spawn a resident agent when none is live (web server / long-lived host).
 * Uses the configured default model (agent-default-model settings) so the
 * AICQ plugin can deliver inbound DMs as durable followup input.
 */
async function ensureResidentAgent(ctx, config) {
  if (!ctx.agents || typeof ctx.agents.create !== 'function') return null
  const sessionId = `aicq-${config.agentId || _agentId || 'resident'}-${Date.now().toString(36)}`
  try {
    // {{model}} prompt variable (deployment:persona section) resolves from
    // agentOptions.model — omit it and system-prompt assembly throws UNKNOWN.
    const defaultModel = config.model || RESIDENT_MODEL
    const agentOptions = defaultModel ? { model: defaultModel } : {}
    const published = await ctx.agents.create({ sessionId, agentOptions })
    // agents.create() resolves to { agent, dispose } — unwrap the live machine.
    const agent = (published && typeof published === 'object' && 'agent' in published)
      ? published.agent
      : published
    log(`spawned resident agent for AICQ routing: ${sessionId}`)
    return agent
  } catch (e) {
    log(`failed to spawn resident agent: ${e.message}`)
    return null
  }
}

/**
 * Route one inbound AICQ message into an agent's inbox as durable user input.
 * Reply routing happens on the agent's next idle transition.
 */
async function deliverToAgent(ctx, config, fromId, textForAgent) {
  let agent = null
  if (config.notifyAgentId) agent = ctx.agents.get?.(config.notifyAgentId) ?? null
  if (!agent && typeof ctx.agents.list === 'function') {
    agent = ctx.agents.list().find((a) => a.status === 'idle' || !a.status) ?? ctx.agents.list()[0] ?? null
  }
  if (!agent) {
    // No live agent yet — spawn a resident one instead of dropping the message.
    agent = await ensureResidentAgent(ctx, config)
    if (!agent) {
      log(`no agent available; message from ${fromId} kept locally only`)
      return
    }
  }
  const submittedAt = Date.now()
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: `[AICQ message from ${fromId}]\n${textForAgent}` }],
    source: { kind: 'plugin', plugin: name },
  }))

  const off = agent.ctx.on?.('agent/status', function onStatus(payload) {
    try {
      if (payload?.status !== 'idle') return
      const events = agent.session?.events ?? []
      const assistantTail = [...events].reverse()
        .find((ev) => ev.type === 'assistant/message' && ev.time >= submittedAt)
      off?.()
      if (!assistantTail) return
      const blocks = assistantTail.data?.message?.content ?? []
      const replyText = blocks
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
      if (!replyText) return
      _chat.sendMessage(_agentId, fromId, replyText, { isGroup: false })
        .catch((e) => log(`reply send failed: ${e.message}`))
    } catch (e) {
      log(`reply routing error: ${e.message}`)
    }
  })
}

/** Plugin entry point — Cordis waits for `inject` services before calling apply. */
export function apply(ctx, config) {
  ensureClient(config).catch((e) =>
    log(`startup deferred (${e.message}); tools will retry on first call`))

  // ── Model-facing tools ───────────────────────────────────────────────
  const runTool = async (fn) => {
    await ensureClient(config)
    return fn()
  }

  const jsonRender = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]

  ctx.tools.register(defineTool({
    name: 'aicq_status',
    description: 'Get AICQ encrypted-chat connection status and this agent\'s identity info.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
    async execute() {
      return runTool(async () => {
        const info = _identity.getInfo(_agentId) || {}
        return {
          connected: !!_serverClient?.connected,
          server_url: config.serverUrl,
          agent_id: _agentId,
          account_id: info.account_id || info.aicq_number || null,
          public_key: info.publicKey || info.public_key || null,
          fingerprint: info.fingerprint || null,
          version: PLUGIN_VERSION,
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'aicq_friends_list',
    description: 'List all AICQ friends (humans and AI agents) with online status.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
    async execute() {
      return runTool(async () => {
        await syncFriendsFromServer().catch(() => {})
        return {
          friends: _db.listFriends(_agentId).map((f) => ({
            id: f.id,
            name: f.ai_name || f.name || f.id,
            type: f.friend_type || f.type || 'unknown',
            online: !!f.is_online,
          })),
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'aicq_friend_add',
    description: 'Send an AICQ friend request by AICQ number (e.g. "1000008"), with optional greeting.',
    parameters: {
      aicq_number: { type: 'string', required: true, description: 'Target AICQ number' },
      message: { type: 'string', description: 'Optional friend request text' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
    async execute(args) {
      return runTool(() => addFriendByNumber(args.aicq_number, args.message))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'aicq_chat_send',
    description: 'Send a chat message to an AICQ friend by ID.',
    parameters: {
      target_id: { type: 'string', required: true, description: 'Recipient AICQ account ID' },
      content: { type: 'string', required: true, description: 'Message body (markdown renders client-side)' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
    async execute(args) {
      return runTool(async () => {
        const r = await _chat.sendMessage(_agentId, args.target_id, args.content, { isGroup: false })
        return { success: true, message_id: r?.message_id ?? null }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'aicq_chat_history',
    description: 'Read recent chat history with an AICQ friend from the local encrypted store.',
    parameters: {
      friend_id: { type: 'string', required: true, description: 'AICQ account ID of the friend' },
      limit: { type: 'number', description: 'Max messages (default 50)' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
    async execute(args) {
      return runTool(async () => ({
        messages: _db.getChatHistory(_agentId, args.friend_id, {
          limit: Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 50,
        }),
      }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'aicq_chat_send_file',
    description: 'Send a local file or image to an AICQ friend.',
    parameters: {
      target_id: { type: 'string', required: true, description: 'Recipient AICQ account ID' },
      file_path: { type: 'string', required: true, description: 'Absolute local file path' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
    async execute(args) {
      return runTool(async () => {
        if (!fs.existsSync(args.file_path)) throw new Error(`file not found: ${args.file_path}`)
        const buf = fs.readFileSync(args.file_path)
        const r = await _chat.handleFileUpload(_agentId, args.target_id, {
          buffer: buf,
          originalname: path.basename(args.file_path),
          size: buf.length,
        }, false)
        return { success: true, ...(r || {}) }
      })
    },
  }))

  // ── Inbound wiring + lifecycle cleanup ────────────────────────────────
  ctx.effect(() => {
    const retry = setInterval(() => {
      ensureClient(config).catch(() => {})
    }, 30_000)
    return () => clearInterval(retry)
  })

  ctx.effect(() => {
    _onInbound = async (msg) => {
      try {
        if (!msg || msg._outbound || msg._synthetic) return
        const fromId = msg.from_id || msg.from || msg.sender_id
        if (!fromId) return
        let text = msg.content || ''
        if (msg.local_path) {
          text += `\n[attachment saved locally: ${msg.local_path}]`
        }
        Promise.resolve(deliverToAgent(ctx, config, fromId, text))
          .catch((e) => log(`deliver failed: ${e.message}`))
      } catch (e) {
        log(`inbound handling failed: ${e.message}`)
      }
    }
    ensureClient(config)
      .then(() => {
        // Idempotent: re-attach in case client restarted with a new ChatManager.
        _chat?.setOnNewMessage(_onInbound)
      })
      .catch(() => {})
    return () => {
      _chat?.setOnNewMessage(undefined)
      _chat?.setOnAutoAccept(undefined)
    }
  })

  ctx.effect(closeClient)

  log(`registered aicq_* tools (v${PLUGIN_VERSION})`)
}

#!/usr/bin/env node
/**
 * AICQ Codex Plugin — stdio MCP server
 * =====================================
 * Exposes the AICQ end-to-end encrypted chat network to OpenAI Codex as
 * Model Context Protocol tools. Shipped as an Agent Plugins v1 bundle:
 *
 *   plugin.json   (https://agent-plugins.org/schemas/1.0.0)
 *   mcp.json      ({"mcpServers": {"aicq": {"type": "stdio", ...}}})
 *   lib/          CommonJS protocol stack reused verbatim from aicq-openclaw
 *                 (identity / sql.js database / NaCl E2EE crypto / HTTP+WS
 *                 signaling client / handshake / chat manager)
 *
 * Runtime model (Codex has no push channel):
 *   - The server keeps a WebSocket connection to the AICQ signaling server.
 *   - Every inbound message is decrypted and persisted into the local SQLite
 *     store by ChatManager regardless of any subscriber, so Codex pulls
 *     conversations with `aicq_chat_history` / `aicq_chat_read_unread`.
 *
 * Environment variables (forwarded by mcp.json env_vars):
 *   AICQ_SERVER_URL      default https://aicq.me
 *   AICQ_DATA_DIR        default ~/.aicq-codex
 *   AICQ_MASTER_NUMBER   auto-add this AICQ number as friend on startup
 *   AICQ_AUTO_ACCEPT     auto-accept friend requests, "true"/"false"
 */

import { createRequire } from "module";
import path from "path";
import os from "os";
import fs from "fs";
import url from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// ── CJS protocol stack (lib/ declares {"type":"commonjs"}) ────────────
const PluginDatabase = require(path.join(__dirname, "..", "lib", "database"));
const IdentityManager = require(path.join(__dirname, "..", "lib", "identity"));
const ServerClient = require(path.join(__dirname, "..", "lib", "server-client"));
const HandshakeManager = require(path.join(__dirname, "..", "lib", "handshake"));
const ChatManager = require(path.join(__dirname, "..", "lib", "chat"));

const SERVER_URL = process.env.AICQ_SERVER_URL || "https://aicq.me";
const DATA_DIR =
  process.env.AICQ_DATA_DIR || path.join(os.homedir(), ".aicq-codex");
const MASTER_NUMBER = process.env.AICQ_MASTER_NUMBER || "";
const AUTO_ACCEPT = (process.env.AICQ_AUTO_ACCEPT || "true").toLowerCase() === "true";
const AGENT_ID = "codex-default";

function log(msg) {
  // stderr only — stdout belongs to the MCP JSON-RPC transport.
  console.error(`[AICQ MCP] ${msg}`);
}

let _db, _identity, _serverClient, _handshake, _chat;
let _connected = false;

async function ensureInitialized() {
  if (_db) return;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const uploadsDir = path.join(DATA_DIR, "uploads");
  const userfilesDir = path.join(DATA_DIR, "userfiles");
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(userfilesDir, { recursive: true });

  _db = new PluginDatabase(DATA_DIR);
  await _db.init();
  log("SQLite database initialized");

  _identity = new IdentityManager(_db);
  if (_identity.listAgents().length === 0) {
    _identity.createAgent(AGENT_ID, "AICQ Codex");
    log(`Created agent identity: ${AGENT_ID}`);
  }

  _serverClient = new ServerClient(_identity, _db, SERVER_URL);
  _handshake = new HandshakeManager(_identity, _serverClient, _db);
  _chat = new ChatManager(_identity, _serverClient, _db, uploadsDir, userfilesDir);

  await _serverClient.ensureAuth(AGENT_ID);
  log(`Authenticated as ${AGENT_ID} against ${SERVER_URL}`);

  if (typeof _serverClient.start === "function") {
    await _serverClient.start(AGENT_ID);
  } else {
    _serverClient.connectWS();
  }
  log("WebSocket signaling connected");

  // Keep local history warm so pull-based tools see messages promptly.
  _chat.setOnNewMessage(async () => {});

  try {
    await syncFriendsFromServer();
  } catch (e) {
    log(`Initial friend sync failed: ${e.message}`);
  }

  if (MASTER_NUMBER) await addFriendByNumber(MASTER_NUMBER).catch((e) =>
    log(`Auto-add master ${MASTER_NUMBER} failed: ${e.message}`)
  );

  _connected = true;
  log(`Plugin runtime initialized (v${PLUGIN_VERSION})`);
}

async function syncFriendsFromServer() {
  await _serverClient.ensureAuth(AGENT_ID);
  const result = await _serverClient.listFriends();
  if (!result || !Array.isArray(result.friends)) return;
  for (const f of result.friends) {
    const existing = _db.getFriend(AGENT_ID, f.id);
    if (!existing) {
      _db.addFriend({
        agent_id: AGENT_ID,
        id: f.id,
        public_key: f.public_key || f.publicKey || "",
        fingerprint: f.fingerprint || "",
        friend_type: f.type || f.friend_type || "ai",
        ai_name: f.agent_name || f.ai_name || f.displayName || "",
      });
    } else {
      _db.updateFriendOnline(AGENT_ID, f.id, !!f.is_online);
    }
  }
}

async function addFriendByNumber(aicqNumber, message) {
  await _serverClient.ensureAuth(AGENT_ID);
  const result = await _serverClient.sendFriendRequest(
    String(aicqNumber),
    message || "Hi, I'd like to add you as a friend!"
  );
  if (result && result.status === "accepted" && result.to_id) {
    _db.addFriend({
      agent_id: AGENT_ID,
      id: result.to_id,
      public_key: "",
      fingerprint: "",
      friend_type: "human",
      ai_name: "",
    });
  }
  return {
    success: true,
    request_id: result && (result.id || result.request_id),
    status: result ? result.status : undefined,
    to_id: result ? result.to_id : undefined,
  };
}

// ── Tool registry ─────────────────────────────────────────────────────

const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
    ).version || "unknown";
  } catch {
    return "unknown";
  }
})();

const TOOLS = [
  {
    name: "aicq_status",
    description:
      "Get the current AICQ encrypted-chat connection status and identity info. Call before other aicq_* tools if unsure.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const info = _identity.getInfo(AGENT_ID) || {};
      const agents = _identity.listAgents();
      return {
        connected: _connected,
        server_url: SERVER_URL,
        data_dir: DATA_DIR,
        agent_id: agents.length > 0 ? agents[0].agent_id : AGENT_ID,
        account_id: info.account_id || info.aicq_number || null,
        public_key: info.publicKey || info.public_key || null,
        fingerprint: info.fingerprint || null,
        version: PLUGIN_VERSION,
      };
    },
  },
  {
    name: "aicq_friends_list",
    description: "List all AICQ friends (humans and AI agents) with online status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      await syncFriendsFromServer().catch(() => {});
      const friends = _db.listFriends(AGENT_ID);
      return {
        friends: friends.map((f) => ({
          id: f.id,
          name: f.ai_name || f.name || f.id,
          type: f.friend_type || f.type || "unknown",
          online: !!f.is_online,
          fingerprint: f.fingerprint || null,
        })),
      };
    },
  },
  {
    name: "aicq_friend_add",
    description:
      "Send an AICQ friend request by AICQ number (e.g. '1000008'). Optionally attach a greeting message.",
    inputSchema: {
      type: "object",
      properties: {
        aicq_number: { type: "string", description: "Target AICQ number" },
        message: { type: "string", description: "Optional friend request text" },
      },
      required: ["aicq_number"],
      additionalProperties: false,
    },
    async run(args) {
      return await addFriendByNumber(args.aicq_number, args.message);
    },
  },
  {
    name: "aicq_chat_send",
    description:
      "Send a text message to an AICQ friend by ID. Content supports plain text; markdown renders on recipients' clients.",
    inputSchema: {
      type: "object",
      properties: {
        target_id: { type: "string", description: "Recipient AICQ account ID" },
        content: { type: "string", description: "Message body to send" },
      },
      required: ["target_id", "content"],
      additionalProperties: false,
    },
    async run(args) {
      const result = await _chat.sendMessage(AGENT_ID, args.target_id, args.content, {
        isGroup: false,
      });
      return { success: true, message_id: result?.message_id ?? null };
    },
  },
  {
    name: "aicq_chat_send_file",
    description:
      "Send a local file or image to an AICQ friend. Reads bytes from file_path and uploads through the AICQ server.",
    inputSchema: {
      type: "object",
      properties: {
        target_id: { type: "string", description: "Recipient AICQ account ID" },
        file_path: { type: "string", description: "Absolute path of the local file" },
      },
      required: ["target_id", "file_path"],
      additionalProperties: false,
    },
    async run(args) {
      if (!fs.existsSync(args.file_path)) {
        throw new Error(`file not found: ${args.file_path}`);
      }
      const buf = fs.readFileSync(args.file_path);
      const result = await _chat.handleFileUpload(AGENT_ID, args.target_id, {
        buffer: buf,
        originalname: path.basename(args.file_path),
        size: buf.length,
      }, false);
      return { success: true, ...(result || {}) };
    },
  },
  {
    name: "aicq_chat_history",
    description:
      "Read chat history with a friend from the local encrypted store. Omit friend_id to get the most recent messages across all chats.",
    inputSchema: {
      type: "object",
      properties: {
        friend_id: { type: "string", description: "AICQ account ID of the friend" },
        limit: { type: "integer", description: "Max messages (default 50)" },
      },
      additionalProperties: false,
    },
    async run(args) {
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 50;
      if (args.friend_id) {
        return { messages: _db.getChatHistory(AGENT_ID, args.friend_id, { limit }) };
      }
      return { messages: _db.getRecentMessages(AGENT_ID, { limit }) };
    },
  },
  {
    name: "aicq_chat_refresh",
    description:
      "Pull each friend's recent conversation from the AICQ server so aicq_chat_history sees anything sent while this server was disconnected. Run before listing history after startup or long idle periods. Optionally mark a friend's conversation as read afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        friend_id: { type: "string", description: "Sync only this friend; omit to sync all friends" },
        mark_read: { type: "boolean", description: "Mark synced conversations as read on the server (default false)" },
      },
      additionalProperties: false,
    },
    async run(args) {
      await _serverClient.ensureAuth(AGENT_ID);
      const friends = _db.listFriends(AGENT_ID);
      const targets = args.friend_id
        ? [args.friend_id]
        : friends.map((f) => f.id);
      let synced = 0;
      const failures = [];
      for (const id of targets) {
        try {
          const conv = await _serverClient.getConversation(id, 50);
          const msgs =
            conv && Array.isArray(conv.messages)
              ? conv.messages
              : conv && Array.isArray(conv.data)
                ? conv.data
                : [];
          for (const m of msgs) {
            if (m._outbound || m.from_id === AGENT_ID) continue;
            const existing = typeof _db.getMessage === "function"
              ? _db.getMessage(m.id || m.message_id)
              : null;
            if (existing) continue;
            _db.saveMessage({
              agent_id: AGENT_ID,
              target_id: id,
              from_id: m.from_id || id,
              to_id: m.to_id || AGENT_ID,
              type: m.type || "text",
              content:
                typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
              file_url: m.file_url || null,
              file_name: m.file_name || null,
              is_group: 0,
              status: "delivered",
            });
          }
          if (args.mark_read) await _serverClient.markRead(id).catch(() => {});
          synced++;
        } catch (e) {
          failures.push({ friend_id: id, error: e.message });
        }
      }
      return { synced_friends: synced, failures };
    },
  },
  {
    name: "aicq_groups_list",
    description: "List AICQ group chats the agent belongs to.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      await _serverClient.ensureAuth(AGENT_ID);
      return await _serverClient.listGroups();
    },
  },
  {
    name: "aicq_group_messages",
    description: "Fetch recent messages from an AICQ group chat.",
    inputSchema: {
      type: "object",
      properties: {
        group_id: { type: "string" },
        limit: { type: "integer", description: "Default 50" },
      },
      required: ["group_id"],
      additionalProperties: false,
    },
    async run(args) {
      await _serverClient.ensureAuth(AGENT_ID);
      return await _serverClient.getGroupMessages(args.group_id, args.limit || 50);
    },
  },
  {
    name: "aicq_group_send",
    description: "Send a text message to an AICQ group chat.",
    inputSchema: {
      type: "object",
      properties: {
        group_id: { type: "string" },
        content: { type: "string" },
      },
      required: ["group_id", "content"],
      additionalProperties: false,
    },
    async run(args) {
      await _chat.sendMessage(AGENT_ID, args.group_id, args.content, { isGroup: true });
      return { success: true };
    },
  },
];

// ── MCP plumbing ──────────────────────────────────────────────────────

// ── stdout protocol guard (MUST run before any lib import logs) ─────────
// The MCP stdio transport reserves stdout exclusively for JSON-RPC frames.
// Library modules still use console.log; route every such line to stderr so
// strict parsers (rmcp) never see non-protocol bytes on the wire.
const __stderrWrite = process.stderr.write.bind(process.stderr);
const __stdoutWrite = process.stdout.write.bind(process.stdout);
console.log = (...args) => {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  __stderrWrite(`[AICQ MCP][out] ${line}\n`);
};

async function main() {
  let ready = false;

  // Single-flight init lock: concurrent tool calls must not race the
  // bootstrap sequence (module-level _db/_identity/_chat get assigned
  // progressively; a second entrant sees _db set and skips ahead).
  // Single-flight shared by BOTH the background bootstrap and every lazy
  // tool call. Two independent entry points used to race each other: a tool
  // could observe `_db` already set while `_chat` was still undefined and
  // skip ahead ("Cannot read properties of undefined (sendMessage)").
  let initPromise = null;
  function startBootstrap() {
    if (!initPromise) {
      initPromise = (async () => {
        try {
          await ensureInitialized();
          ready = true;
          log(`Plugin runtime initialized (v${PLUGIN_VERSION})`);
        } catch (e) {
          initPromise = null; // allow retry on next tool call
          log(`Initialization deferred (${e.message}); tools will retry lazily.`);
        }
      })();
    }
    return initPromise;
  }
  function ensureReadyOnce() {
    if (ready && _connected) return Promise.resolve();
    return startBootstrap();
  }

  const server = new Server(
    { name: "aicq-codex", version: PLUGIN_VERSION },
    { capabilities: { tools: {} } }
  );

  // FIX (startup handshake race): handlers registered BEFORE connect, and
  // connect happens BEFORE heavy E2EE/network bootstrap so the MCP client's
  // `initialize` / `tools/list` are answered immediately. CallTool retries
  // initialization lazily via the `ready` flag.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({
      name, description, inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      await ensureReadyOnce();
      const result = await tool.run(req.params.arguments || {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      log(`tool ${name} failed: ${e.message}`);
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`stdio transport attached; bootstrapping runtime in background`);
  // fire-and-forget; failures reported via log()
  void startBootstrap();
}

main().catch((e) => {
  console.error("[AICQ MCP] fatal:", e);
  process.exit(1);
});

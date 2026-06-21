/**
 * AICQ Chat Plugin — Channel Plugin Entry Point
 *
 * Architecture: Channel (in-process, no independent port)
 * - Runs inside the OpenClaw process
 * - Uses defineChannelPluginEntry from the official Channel Plugin SDK
 * - Provides Gateway RPC methods for the SPA UI and agent tools
 * - No sidecar process needed
 *
 * ESM module — this file IS the openclaw extension entry.
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { aicqChatPlugin, runtime } from "./src/channel.js";
import { createRequire } from "module";
import path from "path";
import os from "os";
import fs from "fs";

// ── CJS interop — lib/ modules are CommonJS ──────────────────────────
const require = createRequire(import.meta.url);

// ── Configuration ────────────────────────────────────────────────────
const DATA_DIR = process.env.AICQ_DATA_DIR || path.join(os.homedir(), ".aicq-plugin");
const SERVER_URL = process.env.AICQ_SERVER_URL || "https://aicq.me";
const AUTO_ADD_FRIENDS = process.env.AICQ_AUTO_ADD_FRIENDS
  ? process.env.AICQ_AUTO_ADD_FRIENDS.split(",").map(s => s.trim()).filter(Boolean)
  : ["1000000"];  // Default: auto-add user 1000000
const AUTO_ACCEPT_FRIENDS = process.env.AICQ_AUTO_ACCEPT_FRIENDS !== "false"; // default true

fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Lazy-loaded CJS modules (need async db init) ────────────────────
let _db = null;
let _identity = null;
let _serverClient = null;
let _handshake = null;
let _chat = null;

/**
 * Initialize all plugin components (async, called once from registerFull).
 */
async function ensureInitialized() {
  if (runtime._initialized) return;

  const PluginDatabase = require("./lib/database");
  const IdentityManager = require("./lib/identity");
  const ServerClient = require("./lib/server-client");
  const HandshakeManager = require("./lib/handshake");
  const ChatManager = require("./lib/chat");

  // Initialize database
  _db = new PluginDatabase(DATA_DIR);
  await _db.init();
  console.log("[AICQ Channel] Database initialized");

  // Initialize managers
  _identity = new IdentityManager(_db);
  _serverClient = new ServerClient(_identity, _db, SERVER_URL);
  _handshake = new HandshakeManager(_identity, _serverClient, _db);
  const uploadsDir = path.join(DATA_DIR, "uploads");
  const userfilesDir = path.join(DATA_DIR, "userfiles");
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(userfilesDir, { recursive: true });

  _chat = new ChatManager(_identity, _serverClient, _db, uploadsDir, userfilesDir);

  // Populate the shared runtime store so channel adapters can use it
  runtime.db = _db;
  runtime.identity = _identity;
  runtime.serverClient = _serverClient;
  runtime.handshake = _handshake;
  runtime.chat = _chat;
  runtime.dataDir = DATA_DIR;
  runtime.userfilesDir = userfilesDir;
  runtime.uploadsDir = uploadsDir;
  runtime.serverUrl = SERVER_URL;
  runtime.handleGateway = handleGatewayMethod;
  runtime.ensureInitialized = ensureInitialized;
  runtime.autoAddFriends = AUTO_ADD_FRIENDS;
  runtime.autoAcceptFriends = AUTO_ACCEPT_FRIENDS;

  // Periodic cleanup
  setInterval(() => _db.cleanup(), 3600000);

  // SPEC 合规: 探活 aicq-sdk (Step 1)
  // 这里仅检查 aicq-sdk 是否可加载, 不强制使用。
  // 后续 Step 2+ 会逐步将 lib/server-client.js 的方法委托给 aicq-sdk-adapter。
  try {
    const { isSdkAvailable, getSdkVersion } = require('./lib/aicq-sdk-adapter');
    if (isSdkAvailable()) {
      console.log(`[AICQ Channel] aicq-sdk available: v${getSdkVersion()} (adapter wired, ready for Step 2 migration)`);
    } else {
      console.warn('[AICQ Channel] aicq-sdk not available — plugin runs in legacy mode (self-implemented protocol stack). npm install aicq-sdk@>=1.0.0');
    }
  } catch (e) {
    console.warn(`[AICQ Channel] aicq-sdk-adapter not loadable: ${e.message}`);
  }

  runtime._initialized = true;
  console.log("[AICQ Channel] Plugin runtime initialized");
}

// ── Sync helpers ─────────────────────────────────────────────────────
async function syncFriendsFromServer(agentId) {
  try {
    await _serverClient.ensureAuth(agentId);
    const result = await _serverClient.listFriends();
    if (result.friends) {
      for (const f of result.friends) {
        const existing = _db.getFriend(agentId, f.id);
        if (!existing) {
          _db.addFriend({
            agent_id: agentId,
            id: f.id,
            public_key: f.public_key || f.publicKey || "",
            fingerprint: f.fingerprint || "",
            friend_type: f.type || f.friend_type || "ai",
            ai_name: f.agent_name || f.ai_name || f.displayName || "",
          });
        } else {
          _db.updateFriendOnline(agentId, f.id, f.is_online || f.isOnline || false);
        }
      }
    }
  } catch (e) {
    console.error("[AICQ Channel] Sync friends failed:", e.message);
  }
}

async function syncGroupsFromServer(agentId) {
  try {
    await _serverClient.ensureAuth(agentId);
    const result = await _serverClient.listGroups();
    if (result.groups) {
      for (const g of result.groups) {
        _db.addGroup({
          agent_id: agentId,
          id: g.id,
          name: g.name,
          owner_id: g.owner_id || g.ownerId || "",
          members_json: g.members || g.members_json || "[]",
          description: g.description || "",
        });
      }
    }
  } catch (e) {
    console.error("[AICQ Channel] Sync groups failed:", e.message);
  }
}

// ── Gateway method handler ───────────────────────────────────────────
async function handleGatewayMethod(method, kwargs = {}) {
  const agents = _identity.listAgents();
  const currentAgentId = agents.length > 0 ? agents[0].agent_id : null;

  switch (method) {
    case "aicq.status":
      return {
        state: _serverClient.connected ? "connected" : "disconnected",
        agent_id: currentAgentId,
        version: "3.7.0",
        architecture: "channel",
      };
    case "aicq.friends.list":
      return { friends: _db.listFriends(currentAgentId) };
    case "aicq.friends.add":
      return await _handshake.addFriendByCode(currentAgentId, kwargs.temp_number);
    case "aicq.friends.addByNumber": {
      // Add friend by AICQ number directly (e.g., "1000000")
      if (!kwargs.number && !kwargs.aicq_number)
        return { error: "number or aicq_number is required" };
      try {
        await _serverClient.ensureAuth(currentAgentId);
        const aicqNumber = kwargs.number || kwargs.aicq_number;
        const result = await _serverClient.sendFriendRequest(aicqNumber, kwargs.message || 'Hi, I\'d like to add you as a friend!');
        // If the request was accepted immediately, also add locally
        if (result.status === 'accepted' && result.to_id) {
          _db.addFriend({
            agent_id: currentAgentId,
            id: result.to_id,
            public_key: '',
            fingerprint: '',
            friend_type: 'human',
            ai_name: kwargs.nickname || '',
          });
        }
        return { success: true, request_id: result.id, status: result.status, to_id: result.to_id };
      } catch (e) {
        return { error: e.message };
      }
    }
    case "aicq.friends.remove":
      _db.removeFriend(currentAgentId, kwargs.friend_id);
      return { success: true };
    case "aicq.friends.requests":
      return { requests: await _handshake.getPendingRequests(currentAgentId) };
    case "aicq.friends.acceptRequest":
      return await _handshake.acceptRequest(currentAgentId, kwargs.request_id);
    case "aicq.friends.rejectRequest":
      return await _handshake.rejectRequest(currentAgentId, kwargs.request_id);
    case "aicq.identity.info":
      return _identity.getInfo(currentAgentId) || {};
    case "aicq.agent.create":
      _identity.createAgent(kwargs.agent_id, kwargs.nickname);
      return { success: true };
    case "aicq.agent.delete":
      _identity.deleteAgent(kwargs.agent_id);
      return { success: true };
    case "aicq.chat.send":
      return await _chat.sendMessage(currentAgentId, kwargs.targetId, kwargs.content, {
        isGroup: kwargs.isGroup,
      });
    case "aicq.chat.history":
      return {
        messages: _db.getChatHistory(currentAgentId, kwargs.targetId, {
          limit: kwargs.limit || 50,
        }),
      };
    case "aicq.chat.delete":
      _db.deleteMessage(currentAgentId, kwargs.message_id);
      return { success: true };
    case "aicq.chat.userUpload": {
      // Save a file from a user to the userfiles directory and notify the AI agent
      if (!kwargs.file_data && !kwargs.file_path)
        return { error: "file_data (base64) or file_path is required" };
      if (!kwargs.from_id && !kwargs.targetId)
        return { error: "from_id or targetId is required" };
      const uploadFromId = kwargs.from_id || kwargs.targetId;
      const isGroupUpload = !!kwargs.isGroup;
      let uploadResult;
      if (kwargs.file_data) {
        // Base64 file data
        const fileBuffer = Buffer.from(kwargs.file_data, 'base64');
        uploadResult = await _chat.handleUserFileUpload(currentAgentId, uploadFromId, {
          buffer: fileBuffer,
          originalname: kwargs.file_name || kwargs.fileName || 'file.bin',
          size: fileBuffer.length,
        }, isGroupUpload);
      } else {
        // File path — copy to userfiles
        const srcPath = kwargs.file_path;
        if (!fs.existsSync(srcPath)) return { error: "File not found: " + srcPath };
        const fileBuffer = fs.readFileSync(srcPath);
        uploadResult = await _chat.handleUserFileUpload(currentAgentId, uploadFromId, {
          buffer: fileBuffer,
          originalname: kwargs.file_name || path.basename(srcPath),
          size: fileBuffer.length,
        }, isGroupUpload);
      }
      return { success: true, localPath: uploadResult.localPath, originalName: uploadResult.originalName };
    }
    case "aicq.chat.userfiles": {
      // List user files
      const userfilesDir = runtime.userfilesDir;
      if (!userfilesDir || !fs.existsSync(userfilesDir)) return { files: [] };
      const userFiles = fs.readdirSync(userfilesDir)
        .filter(f => fs.statSync(path.join(userfilesDir, f)).isFile())
        .map(f => {
          const fp = path.join(userfilesDir, f);
          const stat = fs.statSync(fp);
          return { name: f, path: fp, size: stat.size, modified: stat.mtime.toISOString() };
        })
        .sort((a, b) => b.modified.localeCompare(a.modified));
      return { files: userFiles };
    }
    case "aicq.chat.streamChunk": {
      if (!kwargs.friend_id && !kwargs.targetId)
        return { error: "friend_id or targetId is required" };
      if (!kwargs.data) return { error: "data is required" };
      const chunkType = kwargs.chunk_type || kwargs.chunkType || "text";
      const ALLOWED_CHUNK_TYPES = [
        "text",
        "reasoning",
        "thinking",
        "clear_text",
        "tool_call",
        "tool_result",
      ];
      if (!ALLOWED_CHUNK_TYPES.includes(chunkType))
        return {
          error: `Invalid chunk_type: ${chunkType}. Allowed: ${ALLOWED_CHUNK_TYPES.join(", ")}`,
        };
      const streamTarget = kwargs.friend_id || kwargs.targetId;
      const sent = _serverClient.sendWS({
        type: "stream_chunk",
        to: streamTarget,
        chunkType,
        data: kwargs.data,
      });
      if (!sent) return { error: "Not connected to server", success: false };
      return { success: true };
    }
    case "aicq.chat.streamEnd": {
      if (!kwargs.friend_id && !kwargs.targetId)
        return { error: "friend_id or targetId is required" };
      const endTarget = kwargs.friend_id || kwargs.targetId;
      const msgId =
        kwargs.message_id ||
        kwargs.messageId ||
        "msg_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6);
      const endSent = _serverClient.sendWS({
        type: "stream_end",
        to: endTarget,
        messageId: msgId,
      });
      if (!endSent) return { error: "Not connected to server", success: false };
      return { success: true, messageId: msgId };
    }
    case "aicq.groups.list":
      return { groups: _db.listGroups(currentAgentId) };
    case "aicq.groups.create": {
      await _serverClient.ensureAuth(currentAgentId);
      const result = await _serverClient.createGroup(kwargs.name, kwargs.description);
      if (result.id) {
        _db.addGroup({
          agent_id: currentAgentId,
          id: result.id,
          name: kwargs.name,
          owner_id: currentAgentId,
          members_json: result.members || "[]",
          description: kwargs.description || "",
        });
      }
      return { success: true, group: result };
    }
    case "aicq.groups.join":
      await _serverClient.ensureAuth(currentAgentId);
      return await _serverClient.inviteGroupMember(kwargs.group_id, currentAgentId);
    case "aicq.groups.messages": {
      await _serverClient.ensureAuth(currentAgentId);
      return await _serverClient.getGroupMessages(kwargs.group_id, kwargs.limit || 50);
    }
    case "aicq.groups.silent":
      _db.setGroupSilentMode(currentAgentId, kwargs.group_id, !!kwargs.silent);
      return { success: true, silent: !!kwargs.silent };
    case "aicq.sessions.list":
      return { sessions: [] };
    default:
      return { error: `Unknown method: ${method}` };
  }
}

// ── CLI metadata registration (lightweight, no runtime init) ─────────
function registerCliMetadata(api) {
  api.registerCli(
    ({ program }) => {
      program
        .command("aicq-chat")
        .description("AICQ Encrypted Chat management");
    },
    {
      descriptors: [
        {
          name: "aicq-chat",
          description: "AICQ Encrypted Chat management",
          hasSubcommands: false,
        },
      ],
    }
  );
}

// ── Full runtime registration ────────────────────────────────────────
async function registerFull(api) {
  // Expose ensureInitialized on the runtime store immediately so that
  // startAccount (called by the channel loader) can trigger init even
  // if no gateway method has been invoked yet.
  runtime.ensureInitialized = ensureInitialized;

  // Register gateway RPC methods — each wraps handleGatewayMethod
  const GATEWAY_METHODS = [
    "aicq.status",
    "aicq.friends.list",
    "aicq.friends.add",
    "aicq.friends.addByNumber",
    "aicq.friends.remove",
    "aicq.friends.requests",
    "aicq.friends.acceptRequest",
    "aicq.friends.rejectRequest",
    "aicq.identity.info",
    "aicq.agent.create",
    "aicq.agent.delete",
    "aicq.chat.send",
    "aicq.chat.history",
    "aicq.chat.delete",
    "aicq.chat.userUpload",
    "aicq.chat.userfiles",
    "aicq.chat.streamChunk",
    "aicq.chat.streamEnd",
    "aicq.groups.list",
    "aicq.groups.create",
    "aicq.groups.join",
    "aicq.groups.messages",
    "aicq.groups.silent",
    "aicq.sessions.list",
  ];

  for (const method of GATEWAY_METHODS) {
    api.registerGatewayMethod(method, async (opts) => {
      try {
        await ensureInitialized();
        const result = await handleGatewayMethod(method, opts.params || {});
        opts.respond(true, result);
      } catch (e) {
        opts.respond(false, undefined, { message: e.message, code: "AICQ_ERROR" });
      }
    });
  }

  // Register HTTP routes for the SPA UI and REST API.
  // Lazy-loaded to keep the entry narrow — the ui-routes module pulls in
  // qrcode and multer which are not needed during setup-only registration.
  try {
    const { registerHttpRoutes } = await import("./src/ui-routes.js");
    registerHttpRoutes(api, { ensureInitialized, runtime, DATA_DIR, SERVER_URL });
  } catch (e) {
    console.error("[AICQ Channel] Failed to register HTTP routes:", e.message);
  }

  // ── Register agent tools ──────────────────────────────────────────
  // These tools let the AI agent manage friends (chat-friend), send
  // messages (chat-send), and export its identity key (chat-export-key)
  // via tool calls. The tool definitions are in src/tools.js.
  try {
    if (typeof api.registerTool === "function") {
      const { createAicqTools } = await import("./src/tools.js");
      const tools = createAicqTools(runtime);
      for (const tool of tools) {
        api.registerTool(tool);
      }
      console.log(`[AICQ Channel] Registered ${tools.length} agent tools: ${tools.map(t => t.name).join(", ")}`);
    } else {
      console.warn("[AICQ Channel] api.registerTool not available — agent tools not registered");
    }
  } catch (e) {
    console.error("[AICQ Channel] Failed to register agent tools:", e.message);
  }
}

// ── Export the entry point ───────────────────────────────────────────
export default defineChannelPluginEntry({
  id: "aicq-chat",
  name: "AICQ Encrypted Chat",
  description:
    "End-to-end encrypted chat channel plugin for OpenClaw agents — NaCl (X25519 + XSalsa20-Poly1305)",
  plugin: aicqChatPlugin,
  registerCliMetadata,
  registerFull,
});

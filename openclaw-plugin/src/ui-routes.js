/**
 * AICQ Channel Plugin — Gateway HTTP Routes
 *
 * Provides HTTP route handlers for the OpenClaw Gateway.
 * These routes serve the SPA UI and REST API endpoints.
 *
 * Strategy: We create an Express sub-app with all routes (defined
 * relative to the /plugins/aicq-chat mount point), then register it
 * via api.registerHttpRoute(). The OpenClaw gateway runs Express
 * internally and uses app.use(path, handler), so the mount prefix
 * is stripped before the request reaches our sub-app.
 *
 * ESM module — imported by index.js registerFull() to register routes
 * on the OpenClaw plugin API.
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const QRCode = require("qrcode");
const multer = require("multer");
const express = require("express");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Create and return the Express sub-app with all AICQ routes.
 *
 * Routes are defined RELATIVE to the /plugins/aicq-chat mount point.
 * For example, the API route /plugins/aicq-chat/api/status is
 * defined as /api/status in the sub-app.
 *
 * @param {object} ctx - Plugin context { ensureInitialized, runtime, DATA_DIR, SERVER_URL }
 * @returns {import('express').Express} Express sub-app
 */
function createAicqExpressApp(ctx) {
  const { ensureInitialized, runtime, DATA_DIR, SERVER_URL } = ctx;
  const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

  // Ensure uploads directory exists
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });

  const app = express();

  // Parse JSON bodies
  app.use(express.json());

  // Parse URL-encoded bodies
  app.use(express.urlencoded({ extended: true }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
  });

  /**
   * Helper to get current agent ID from a request
   */
  function getAgentId(req) {
    return (
      req.query?.agent_id ||
      req.body?.agent_id ||
      (runtime.identity && runtime.identity.listAgents()[0]?.agent_id)
    );
  }

  // ── Serve SPA static files ────────────────────────────────────────
  // NOTE: The mount point /plugins/aicq-chat is stripped by Express,
  // so our sub-app sees /ui/... for requests to /plugins/aicq-chat/ui/...
  const publicDir = path.join(__dirname, "..", "public");

  app.use("/ui", (req, res, next) => {
    const filePath = path.join(publicDir, req.path === "/" ? "index.html" : req.path);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.sendFile(filePath);
    } else {
      // SPA fallback: serve index.html for all unknown routes
      res.sendFile(path.join(publicDir, "index.html"));
    }
  });

  // ── API Routes ────────────────────────────────────────────────────
  // All paths are relative to the /plugins/aicq-chat mount point.

  // Status
  app.get("/api/status", (req, res) => {
    res.json({
      status: "running",
      version: "3.7.0",
      architecture: "channel",
      connected: runtime.serverClient?.connected || false,
      serverUrl: SERVER_URL,
    });
  });

  // Agents
  app.get("/api/agents", async (req, res) => {
    await ensureInitialized();
    res.json({ agents: runtime.identity.listAgents() });
  });

  app.post("/api/agents", async (req, res) => {
    await ensureInitialized();
    try {
      const { agent_id, nickname } = req.body;
      if (!agent_id) return res.status(400).json({ error: "agent_id is required" });
      const agent = runtime.identity.createAgent(agent_id, nickname);
      try {
        await runtime.serverClient.start(agent_id);
      } catch (e) {
        console.error("[AICQ] Server registration failed:", e.message);
      }
      res.json({ success: true, agent });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/agents/:id", async (req, res) => {
    await ensureInitialized();
    runtime.identity.deleteAgent(req.params.id);
    res.json({ success: true });
  });

  // Friends
  app.get("/api/friends", async (req, res) => {
    await ensureInitialized();
    const agentId = getAgentId(req);
    res.json({ friends: runtime.db.listFriends(agentId) });
  });

  app.post("/api/friends/add", async (req, res) => {
    await ensureInitialized();
    try {
      const { temp_number, friend_code, agent_id } = req.body;
      const agentId = agent_id || getAgentId(req);
      const code = temp_number || friend_code;
      if (!code)
        return res.status(400).json({ error: "temp_number or friend_code is required" });
      const result = await runtime.handshake.addFriendByCode(agentId, code);
      res.json({ success: true, result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/friends/:id", async (req, res) => {
    await ensureInitialized();
    try {
      const agentId = getAgentId(req);
      runtime.db.removeFriend(agentId, req.params.id);
      try {
        await runtime.serverClient.removeFriend(req.params.id);
      } catch (e) {}
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/friends/requests", async (req, res) => {
    await ensureInitialized();
    try {
      const agentId = getAgentId(req);
      let serverRequests = [];
      try {
        await runtime.serverClient.ensureAuth(agentId);
        const result = await runtime.serverClient.listFriendRequests();
        serverRequests = result.sent || [];
        serverRequests = serverRequests.concat(result.received || []);
      } catch (e) {}
      const localRequests = runtime.db.getPendingRequests(agentId);
      res.json({ requests: [...localRequests, ...serverRequests] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/friends/requests/:id/accept", async (req, res) => {
    await ensureInitialized();
    try {
      const agentId = getAgentId(req);
      const result = await runtime.handshake.acceptRequest(agentId, req.params.id);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/friends/requests/:id/reject", async (req, res) => {
    await ensureInitialized();
    try {
      const agentId = getAgentId(req);
      const result = await runtime.handshake.rejectRequest(agentId, req.params.id);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Groups
  app.get("/api/groups", async (req, res) => {
    await ensureInitialized();
    const agentId = getAgentId(req);
    res.json({ groups: runtime.db.listGroups(agentId) });
  });

  app.post("/api/groups", async (req, res) => {
    await ensureInitialized();
    try {
      const agentId = getAgentId(req);
      const { name, description } = req.body;
      if (!name) return res.status(400).json({ error: "name is required" });
      await runtime.serverClient.ensureAuth(agentId);
      const result = await runtime.serverClient.createGroup(name, description);
      if (result.id) {
        runtime.db.addGroup({
          agent_id: agentId,
          id: result.id,
          name,
          owner_id: agentId,
          members_json: result.members || "[]",
          description: description || "",
        });
      }
      res.json({ success: true, group: result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/groups/:id/join", async (req, res) => {
    await ensureInitialized();
    try {
      const agentId = getAgentId(req);
      await runtime.serverClient.ensureAuth(agentId);
      const result = await runtime.serverClient.inviteGroupMember(req.params.id, agentId);
      res.json({ success: true, result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/groups/:id/messages", async (req, res) => {
    await ensureInitialized();
    try {
      const agentId = getAgentId(req);
      const limit = parseInt(req.query.limit || "50", 10);
      const before = req.query.before || null;
      try {
        await runtime.serverClient.ensureAuth(agentId);
        const result = await runtime.serverClient.getGroupMessages(
          req.params.id,
          limit,
          before
        );
        if (result.messages && result.messages.length > 0) {
          return res.json({ messages: result.messages });
        }
      } catch (e) {}
      const messages = runtime.db.getChatHistory(agentId, req.params.id, {
        limit,
        before,
      });
      res.json({ messages });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put("/api/groups/:id/silent", async (req, res) => {
    await ensureInitialized();
    const agentId = getAgentId(req);
    const { silent } = req.body;
    runtime.db.setGroupSilentMode(agentId, req.params.id, !!silent);
    res.json({ success: true, silent: !!silent });
  });

  // Chat
  app.get("/api/chat/:targetId", async (req, res) => {
    await ensureInitialized();
    const agentId = getAgentId(req);
    const limit = parseInt(req.query.limit || "50", 10);
    const before = req.query.before || null;
    const messages = runtime.db.getChatHistory(agentId, req.params.targetId, {
      limit,
      before,
    });
    res.json({ messages });
  });

  app.post("/api/chat/send", async (req, res) => {
    await ensureInitialized();
    try {
      const {
        agent_id,
        targetId,
        content,
        type,
        isGroup,
        mentions,
        file_url,
        file_name,
      } = req.body;
      const agentId = agent_id || getAgentId(req);
      if (!targetId || !content)
        return res.status(400).json({ error: "targetId and content are required" });
      const msg = await runtime.chat.sendMessage(agentId, targetId, content, {
        type: type || "text",
        isGroup: !!isGroup,
        mentions: mentions || [],
        file_url,
        file_name,
      });
      res.json({ success: true, message: msg });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/chat/:messageId", async (req, res) => {
    await ensureInitialized();
    const agentId = getAgentId(req);
    runtime.db.deleteMessage(agentId, req.params.messageId);
    res.json({ success: true });
  });

  // Streaming endpoints
  app.post("/api/chat/stream-chunk", async (req, res) => {
    await ensureInitialized();
    try {
      const { targetId, friend_id, chunk_type, chunkType, data } = req.body;
      const streamTarget = targetId || friend_id;
      if (!streamTarget)
        return res.status(400).json({ error: "targetId or friend_id is required" });
      if (!data) return res.status(400).json({ error: "data is required" });
      const type = chunk_type || chunkType || "text";
      const ALLOWED_CHUNK_TYPES = [
        "text",
        "reasoning",
        "thinking",
        "clear_text",
        "tool_call",
        "tool_result",
      ];
      if (!ALLOWED_CHUNK_TYPES.includes(type)) {
        return res
          .status(400)
          .json({
            error: `Invalid chunk_type: ${type}. Allowed: ${ALLOWED_CHUNK_TYPES.join(", ")}`,
          });
      }
      const sent = runtime.serverClient.sendWS({
        type: "stream_chunk",
        to: streamTarget,
        chunkType: type,
        data: data,
      });
      if (!sent)
        return res.status(503).json({ error: "Not connected to server", success: false });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/chat/stream-end", async (req, res) => {
    await ensureInitialized();
    try {
      const { targetId, friend_id, message_id, messageId } = req.body;
      const streamTarget = targetId || friend_id;
      if (!streamTarget)
        return res.status(400).json({ error: "targetId or friend_id is required" });
      const msgId =
        message_id ||
        messageId ||
        "msg_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6);
      const sent = runtime.serverClient.sendWS({
        type: "stream_end",
        to: streamTarget,
        messageId: msgId,
      });
      if (!sent)
        return res.status(503).json({ error: "Not connected to server", success: false });
      res.json({ success: true, messageId: msgId });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // File upload
  app.post("/api/upload", upload.single("file"), async (req, res) => {
    await ensureInitialized();
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const agentId = getAgentId(req);
      const targetId = req.body.targetId;
      const isGroup = req.body.isGroup === "true" || req.body.isGroup === "1";
      const msg = await runtime.chat.handleFileUpload(agentId, targetId, req.file, isGroup);
      res.json({ success: true, message: msg });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // User file upload — saves to userfiles dir and notifies AI agent
  app.post("/api/user-upload", upload.single("file"), async (req, res) => {
    await ensureInitialized();
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const agentId = getAgentId(req);
      const fromId = req.body.fromId || req.body.from_id || agentId;
      const isGroup = req.body.isGroup === "true" || req.body.isGroup === "1";
      const result = await runtime.chat.handleUserFileUpload(agentId, fromId, req.file, isGroup);
      res.json({ success: true, message: result.msg, localPath: result.localPath, originalName: result.originalName });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // List user files
  app.get("/api/userfiles", async (req, res) => {
    await ensureInitialized();
    try {
      const userfilesDir = runtime.userfilesDir;
      if (!userfilesDir || !fs.existsSync(userfilesDir)) {
        return res.json({ files: [] });
      }
      const files = fs.readdirSync(userfilesDir)
        .filter(f => fs.statSync(path.join(userfilesDir, f)).isFile())
        .map(f => {
          const filePath = path.join(userfilesDir, f);
          const stat = fs.statSync(filePath);
          return {
            name: f,
            path: filePath,
            size: stat.size,
            modified: stat.mtime.toISOString(),
          };
        })
        .sort((a, b) => b.modified.localeCompare(a.modified));
      res.json({ files });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Serve user files
  app.get("/api/userfiles/:filename", (req, res) => {
    const USERFILES_DIR = runtime.userfilesDir || path.join(DATA_DIR, "userfiles");
    const filePath = path.join(USERFILES_DIR, req.params.filename);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.sendFile(filePath);
    } else {
      res.status(404).json({ error: "File not found" });
    }
  });

  app.get("/api/files/:fileId", (req, res) => {
    const filePath = path.join(UPLOADS_DIR, req.params.fileId);
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res.status(404).json({ error: "File not found" });
    }
  });

  // Identity
  app.get("/api/identity", async (req, res) => {
    await ensureInitialized();
    const agentId = getAgentId(req);
    res.json(runtime.identity.getInfo(agentId) || {});
  });

  app.post("/api/identity/nickname", async (req, res) => {
    await ensureInitialized();
    const { agent_id, nickname } = req.body;
    const agentId = agent_id || getAgentId(req);
    runtime.identity.updateNickname(agentId, nickname);
    res.json({ success: true });
  });

  app.post("/api/identity/friend-code", async (req, res) => {
    await ensureInitialized();
    try {
      const agentId = req.body.agent_id || getAgentId(req);
      await runtime.serverClient.ensureAuth(agentId);
      const result = await runtime.handshake.generateFriendCode(agentId);
      res.json({
        success: true,
        code: result.number,
        expires_at: result.expiresAt || result.expires_at,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/identity/qr", async (req, res) => {
    await ensureInitialized();
    try {
      const agentId = getAgentId(req);
      const info = runtime.identity.getInfo(agentId);
      if (!info) return res.status(404).json({ error: "Agent not found" });
      const qrData = JSON.stringify({
        type: "aicq-friend",
        agent_id: info.agent_id,
        public_key: info.signing_public_key,
        exchange_public_key: info.exchange_public_key,
        fingerprint: info.fingerprint,
      });
      const qrImage = await QRCode.toDataURL(qrData);
      res.json({ qr: qrImage, data: qrData, info });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/identity/rotate-keys", async (req, res) => {
    await ensureInitialized();
    try {
      const agentId = req.body.agent_id || getAgentId(req);
      runtime.identity.rotateKeys(agentId);
      res.json({ success: true, info: runtime.identity.getInfo(agentId) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/identity/keys", async (req, res) => {
    await ensureInitialized();
    const agentId = getAgentId(req);
    const info = runtime.identity.loadAgent(agentId);
    if (!info) return res.status(404).json({ error: "Agent not found" });
    // SECURITY: Only return public keys. Secret keys must never be exposed over
    // HTTP — anyone with the secret key can impersonate the agent and decrypt
    // messages. Use the dedicated export endpoint with extra auth if needed.
    res.json({
      agent_id: info.agent_id,
      nickname: info.nickname,
      signing_public_key: info.signing_public_key,
      exchange_public_key: info.exchange_public_key,
      fingerprint: info.fingerprint,
      has_secret_keys: Boolean(info.signing_secret_key && info.exchange_secret_key),
    });
  });

  // Sync endpoint
  app.post("/api/sync", async (req, res) => {
    await ensureInitialized();
    try {
      const agentId = req.body.agent_id || getAgentId(req);
      await runtime.serverClient.ensureAuth(agentId);
      // Sync friends
      const friendResult = await runtime.serverClient.listFriends();
      if (friendResult.friends) {
        for (const f of friendResult.friends) {
          const existing = runtime.db.getFriend(agentId, f.id);
          if (!existing) {
            runtime.db.addFriend({
              agent_id: agentId,
              id: f.id,
              public_key: f.public_key || f.publicKey || "",
              fingerprint: f.fingerprint || "",
              friend_type: f.type || f.friend_type || "ai",
              ai_name: f.agent_name || f.ai_name || f.displayName || "",
            });
          } else {
            runtime.db.updateFriendOnline(
              agentId,
              f.id,
              f.is_online || f.isOnline || false
            );
          }
        }
      }
      // Sync groups
      const groupResult = await runtime.serverClient.listGroups();
      if (groupResult.groups) {
        for (const g of groupResult.groups) {
          runtime.db.addGroup({
            agent_id: agentId,
            id: g.id,
            name: g.name,
            owner_id: g.owner_id || g.ownerId || "",
            members_json: g.members || g.members_json || "[]",
            description: g.description || "",
          });
        }
      }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Gateway proxy endpoint (for backward compatibility)
  app.post("/api/gateway", async (req, res) => {
    await ensureInitialized();
    try {
      // This endpoint provides backward compatibility for SPA calls
      // that use the gateway RPC protocol. New code should prefer
      // the REST API endpoints above.
      const { method, kwargs } = req.body;
      if (!method) return res.status(400).json({ error: "method is required" });

      // Delegate to the gateway method handler in index.js
      // (imported via the ensureInitialized runtime store)
      const result = await runtime.handleGateway(method, kwargs || {});
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return app;
}

/**
 * Register all HTTP routes on the OpenClaw plugin API.
 *
 * Creates an Express sub-app with all AICQ routes and registers it
 * as a handler for the /plugins/aicq-chat path prefix.
 *
 * @param {object} api - OpenClawPluginApi instance
 * @param {object} ctx - Plugin context { ensureInitialized, runtime, DATA_DIR, SERVER_URL }
 */
export function registerHttpRoutes(api, ctx) {
  const app = createAicqExpressApp(ctx);

  // Register the Express sub-app for all /plugins/aicq-chat requests.
  // The gateway uses app.use(path, handler), so the mount prefix is
  // stripped before the request reaches our sub-app.
  if (typeof api.registerHttpRoute === "function") {
    api.registerHttpRoute({
      path: "/plugins/aicq-chat",
      auth: "plugin",
      handler: app,
    });
  } else {
    console.warn(
      "[AICQ Channel] api.registerHttpRoute not available — HTTP UI routes not registered. " +
      "The SPA UI will not be accessible until the gateway supports plugin HTTP routes."
    );
  }
}

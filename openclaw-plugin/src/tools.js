/**
 * AICQ Plugin — Agent Tool Definitions
 *
 * These tools let the OpenClaw AI agent manage friends and send messages
 * via the AICQ encrypted chat network. The tools are registered via
 * api.registerTool() in the channel plugin's registerFull() callback.
 *
 * Tools:
 *   1. chat-friend    — Friend management (add/accept/reject/list/remove)
 *   2. chat-send      — Send messages (private or group)
 *   3. chat-export-key — Export the agent's public key
 */

/**
 * Create the three AICQ agent tools.
 * @param {object} runtime — The plugin runtime store (has chat, handshake, identity, serverClient, db, handleGateway)
 * @returns {Array} Array of tool definition objects
 */
export function createAicqTools(runtime) {
  // Helper: get the current agent id (always "main" for now)
  function getCurrentAgentId() {
    if (runtime.identity) {
      const agents = runtime.identity.listAgents();
      if (agents.length > 0) return agents[0].agent_id;
    }
    return "main";
  }

  // Helper: format tool result
  function ok(text, details) {
    return {
      content: [{ type: "text", text: typeof text === "string" ? text : JSON.stringify(text, null, 2) }],
      details: details || text,
    };
  }
  function err(text) {
    return {
      content: [{ type: "text", text: `Error: ${text}` }],
      details: { error: text },
    };
  }

  // ── Tool 1: chat-friend ──────────────────────────────────────────
  const chatFriendTool = {
    name: "chat-friend",
    label: "AICQ Friend Management",
    description:
      "Manage AICQ friends: add (send friend request by account ID), accept, reject, list (show all friends), or remove. " +
      "Use action 'list' to see all friends with their online status. " +
      "Use action 'add' with account_id to send a friend request.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["add", "accept", "reject", "list", "remove"],
          description: "Friend management action",
        },
        account_id: {
          type: "string",
          description: "Target account ID (for add/accept/reject/remove). e.g. '1000008'",
        },
        friend_name: {
          type: "string",
          description: "Optional friend nickname for add",
        },
      },
      required: ["action"],
    },
    execute: async (_toolCallId, params) => {
      try {
        const agentId = getCurrentAgentId();
        const action = params.action;
        const accountId = params.account_id || "";

        switch (action) {
          case "list": {
            const result = await runtime.handleGateway("aicq.friends.list", {});
            const friends = result.friends || [];
            if (friends.length === 0) return ok("You have no friends yet.");
            const lines = friends.map((f) =>
              `  ${f.id} (${f.friend_type || "unknown"}) ${f.ai_name || ""} ${f.is_online ? "[online]" : "[offline]"}`
            );
            return ok(`Friends (${friends.length}):\n${lines.join("\n")}`, { count: friends.length, friends });
          }

          case "add": {
            if (!accountId) return err("account_id is required for 'add' action");
            await runtime.serverClient.ensureAuth(agentId);
            const result = await runtime.serverClient.sendFriendRequest(accountId, `Hi, I'd like to add you as a friend!`);
            return ok(`Friend request sent to ${accountId}. Status: ${result.status || "pending"}`, result);
          }

          case "accept": {
            if (!accountId) return err("account_id (request_id) is required for 'accept' action");
            const result = await runtime.handleGateway("aicq.friends.acceptRequest", { request_id: accountId });
            return ok(`Friend request ${accountId} accepted.`, result);
          }

          case "reject": {
            if (!accountId) return err("account_id (request_id) is required for 'reject' action");
            const result = await runtime.handleGateway("aicq.friends.rejectRequest", { request_id: accountId });
            return ok(`Friend request ${accountId} rejected.`, result);
          }

          case "remove": {
            if (!accountId) return err("account_id is required for 'remove' action");
            runtime.db.removeFriend(agentId, accountId);
            return ok(`Friend ${accountId} removed.`);
          }

          default:
            return err(`Unknown action: ${action}. Use add/accept/reject/list/remove.`);
        }
      } catch (e) {
        return err(e.message);
      }
    },
  };

  // ── Tool 2: chat-send ────────────────────────────────────────────
  const chatSendTool = {
    name: "chat-send",
    label: "AICQ Send Message",
    description:
      "Send a message to a friend or group via AICQ encrypted chat. " +
      "Use type 'private' for direct messages (requires friend's account_id as 'to') " +
      "or type 'group' for group messages (requires group_id as 'to').",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        to: { type: "string", description: "Recipient account ID (private) or group ID (group). e.g. '1000008'" },
        content: { type: "string", description: "Message content to send" },
        type: {
          type: "string",
          enum: ["private", "group"],
          description: "Message type: private (default) or group",
        },
      },
      required: ["to", "content"],
    },
    execute: async (_toolCallId, params) => {
      try {
        const agentId = getCurrentAgentId();
        const targetId = params.to;
        const content = params.content;
        const isGroup = params.type === "group";

        if (!targetId) return err("'to' (recipient) is required");
        if (!content) return err("'content' (message body) is required");

        await runtime.chat.sendMessage(agentId, targetId, content, { isGroup });
        return ok(`Message sent to ${targetId} (${isGroup ? "group" : "private"}): ${content.substring(0, 100)}`, {
          to: targetId,
          type: isGroup ? "group" : "private",
          length: content.length,
        });
      } catch (e) {
        return err(e.message);
      }
    },
  };

  // ── Tool 3: chat-export-key ──────────────────────────────────────
  const chatExportKeyTool = {
    name: "chat-export-key",
    label: "AICQ Export Identity Key",
    description:
      "Export the AI agent's public key for friend verification. " +
      "The public key can be shared with friends so they can verify your identity. " +
      "Supports hex (default) or base64 format.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        format: {
          type: "string",
          enum: ["hex", "base64"],
          description: "Output format: hex (default) or base64",
        },
      },
    },
    execute: async (_toolCallId, params) => {
      try {
        const agentId = getCurrentAgentId();
        const format = params.format || "hex";
        const info = runtime.identity.getInfo(agentId);
        if (!info) return err("Agent identity not found");

        let publicKey = info.signing_public_key || "";
        if (format === "base64") {
          const buf = Buffer.from(publicKey, "hex");
          publicKey = buf.toString("base64");
        }

        return ok(
          `Agent: ${agentId}\nPublic Key (${format}): ${publicKey}\nFingerprint: ${info.fingerprint || "N/A"}`,
          { agent_id: agentId, public_key: publicKey, format, fingerprint: info.fingerprint }
        );
      } catch (e) {
        return err(e.message);
      }
    },
  };

  return [chatFriendTool, chatSendTool, chatExportKeyTool];
}


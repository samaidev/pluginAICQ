/**
 * AICQ Channel Plugin — Core Channel Logic
 *
 * Uses the official OpenClaw Channel Plugin SDK:
 *   createChatChannelPlugin + createChannelPluginBase
 *
 * Architecture: In-process Channel (no sidecar, no independent port)
 *
 * The runtime store is a mutable object populated by registerFull() in
 * index.js. This keeps the channel-plugin object safe to import during
 * setup-only / discovery modes without pulling in transport clients or
 * database handles.
 */

import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";

// ── Mutable runtime store ────────────────────────────────────────────
// Populated lazily by the registerFull() callback in index.js.
// Adapters that need runtime state check these before acting.
export const runtime = {
  db: null,
  identity: null,
  serverClient: null,
  handshake: null,
  chat: null,
  dataDir: null,
  serverUrl: null,
  handleGateway: null,
  _initialized: false,
};

// ── Template variable resolver ───────────────────────────────────────
// OpenClaw stores accountId as-is (e.g. "{{agent.id}}") in config.
// Plugins must resolve template variables at runtime.
//
// The default agent ID in OpenClaw is "main" (DEFAULT_AGENT_ID).
// When cfg.agents.list is empty/undefined (no explicit agent config),
// the implicit default agent "main" is used.

const OPENCLAW_DEFAULT_AGENT_ID = "main";

function resolveTemplateVar(cfg, value) {
  if (typeof value !== "string") return value;
  const match = value.match(/^\{\{(\w[\w.]*)\}\}$/);
  if (!match) return value;

  const tmplPath = match[1]; // e.g. "agent.id"
  if (tmplPath === "agent.id") {
    // Strategy: look for explicit agents in config first
    const agents = cfg.agents?.list;
    if (Array.isArray(agents) && agents.length > 0) {
      // Use the default=true agent, or the first one
      const defaultAgent = agents.find((a) => a.default) || agents[0];
      if (defaultAgent?.id) return defaultAgent.id;
    }
    // Fallback: OpenClaw's implicit default agent ID
    return OPENCLAW_DEFAULT_AGENT_ID;
  }

  return value; // unknown template — return as-is
}

// ── Resolved account type ────────────────────────────────────────────
// This is the object returned by resolveAccount() and consumed by
// security / pairing / outbound adapters.

/**
 * Read the AICQ channel section from OpenClaw config and return a typed
 * account object.  This is the setup-safe resolver — no network or DB
 * side effects.
 */
function resolveAccount(cfg, accountId) {
  const section = (cfg.channels || {})["aicq-chat"] || {};
  const rawAccountId = accountId || section.accountId || null;

  if (!rawAccountId) {
    throw new Error(
      "aicq-chat: accountId is required (set channels.aicq-chat.accountId)"
    );
  }

  // Resolve template variables like {{agent.id}}
  const resolvedAccountId = resolveTemplateVar(cfg, rawAccountId);

  // Resolve allowFrom entries (may contain {{agent.id}} or friend IDs)
  const rawAllowFrom = section.allowFrom || [];
  const resolvedAllowFrom = Array.isArray(rawAllowFrom)
    ? rawAllowFrom.map((entry) => resolveTemplateVar(cfg, entry))
    : rawAllowFrom;

  return {
    accountId: resolvedAccountId,
    serverUrl: section.serverUrl || "https://aicq.me",
    autoAcceptFriends: section.autoAcceptFriends ?? true,
    autoAddFriends: section.autoAddFriends || [],
    enabled: section.enabled ?? true,
    dmPolicy: section.dmPolicy || "allowlist",
    allowFrom: resolvedAllowFrom,
  };
}

/**
 * Lightweight account inspection for status / health / setup surfaces.
 * Must not materialise secrets or start transports.
 */
function inspectAccount(cfg, accountId) {
  const section = (cfg.channels || {})["aicq-chat"] || {};
  const hasAccountId = Boolean(section.accountId || accountId);
  return {
    enabled: hasAccountId && section.enabled !== false,
    configured: hasAccountId,
    accountStatus: hasAccountId ? "available" : "missing",
  };
}

// ── Build the channel plugin ─────────────────────────────────────────

const _plugin = createChatChannelPlugin({
  base: createChannelPluginBase({
    id: "aicq-chat",

    setup: {
      /**
       * Resolve the account ID from setup input.
       * Called by the setup wizard when a user configures the channel.
       */
      resolveAccountId(params) {
        const { cfg, accountId, input } = params;
        return accountId || input?.accountId || resolveTemplateVar(cfg, "{{agent.id}}");
      },

      /**
       * Apply the account config after the setup wizard completes.
       * Must return the updated OpenClawConfig.
       */
      applyAccountConfig(params) {
        const { cfg, accountId, input } = params;
        const section = (cfg.channels || {})["aicq-chat"] || {};
        return {
          ...cfg,
          channels: {
            ...(cfg.channels || {}),
            "aicq-chat": {
              ...section,
              accountId: accountId || input?.accountId || "{{agent.id}}",
              serverUrl: input?.serverUrl || section.serverUrl || "https://aicq.me",
              autoAcceptFriends: input?.autoAcceptFriends ?? section.autoAcceptFriends ?? true,
              enabled: true,
              dmPolicy: input?.dmPolicy || section.dmPolicy || "allowlist",
              allowFrom: input?.allowFrom || section.allowFrom || [],
            },
          },
        };
      },

      /**
       * Validate setup input before applying.
       * Return an error message string or null if valid.
       */
      validateInput(params) {
        return null;
      },
    },

    // Gateway method descriptors — these are the method names the plugin
    // will register via registerFull(). Declaring them here lets OpenClaw
    // surface them in discovery / status surfaces before full activation.
    gatewayMethodDescriptors: [
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
    ],
  }),

  // ── DM Security ──────────────────────────────────────────────────
  security: {
    dm: {
      channelKey: "aicq-chat",
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: "allowlist",
    },
  },

  // ── Pairing ──────────────────────────────────────────────────────
  pairing: {
    text: {
      idLabel: "AICQ Friend Code",
      message: "Share this pairing code with the other party:",
      notify: async ({ target, code }) => {
        // AICQ pairing codes are shared out-of-band by the operator.
        // No automatic notification is sent to the peer.
      },
    },
  },

  // ── Threading ────────────────────────────────────────────────────
  threading: {
    topLevelReplyToMode: "reply",
  },

  // ── Outbound ─────────────────────────────────────────────────────
  outbound: {
    attachedResults: {
      channel: "aicq-chat",

      sendText: async (params) => {
        if (!runtime.chat) {
          throw new Error("AICQ runtime not initialized — cannot send text");
        }
        const fromId =
          params.from ||
          params.accountId ||
          (runtime.identity && runtime.identity.listAgents()[0]?.agent_id);
        const result = await runtime.chat.sendMessage(
          fromId,
          params.to,
          params.text,
          { isGroup: false }
        );
        return { messageId: result?.message_id || result?.id || "sent" };
      },
    },

    base: {
      sendMedia: async (params) => {
        if (!runtime.chat) {
          throw new Error("AICQ runtime not initialized — cannot send media");
        }
        const fromId =
          params.from ||
          params.accountId ||
          (runtime.identity && runtime.identity.listAgents()[0]?.agent_id);
        await runtime.chat.sendMessage(
          fromId,
          params.to,
          params.mediaUrl || params.filePath,
          { type: params.mediaType || "file", isGroup: false }
        );
      },
    },
  },
});

// ── Gateway adapter: startAccount / stopAccount ───────────────────────
// OpenClaw calls startAccount when the channel is activated (on startup
// or when re-enabled).  This is where we initialise the runtime, connect
// to the AICQ signalling server, and wire up inbound message delivery
// via the channelRuntime helpers.

_plugin.gateway = {
  /**
   * Start the channel account — connect to the AICQ server and begin
   * listening for inbound messages.
   */
  async startAccount(ctx) {
    const { cfg, accountId, account, setStatus, log, abortSignal } = ctx;

    const logger = log || console;
    logger.info?.(`[AICQ Channel] startAccount called for ${accountId}`) || console.log(`[AICQ Channel] startAccount called for ${accountId}`);

    // Ensure the runtime (DB, identity, transport) is initialised.
    // The runtime is populated by registerFull() in index.js, but startAccount
    // may be called before any gateway method is invoked, so we must ensure
    // initialization here too.
    if (!runtime._initialized && typeof runtime.ensureInitialized === "function") {
      try {
        await runtime.ensureInitialized();
        logger.info?.("[AICQ Channel] Runtime initialized via startAccount") || console.log("[AICQ Channel] Runtime initialized via startAccount");
      } catch (e) {
        console.error("[AICQ Channel] Runtime initialization failed:", e.message);
        setStatus({
          accountId,
          enabled: true,
          configured: true,
          running: false,
          lastError: `Initialization failed: ${e.message}`,
        });
        return;
      }
    }

    // Resolve the agent ID: prefer the resolved accountId from
    // resolveAccount (which already handles {{agent.id}}), then
    // fall back to the OpenClaw default agent ID.
    const agents = cfg.agents?.list;
    const agentId = account?.accountId || accountId || OPENCLAW_DEFAULT_AGENT_ID;

    // Ensure we have an identity in the plugin DB
    if (runtime.identity) {
      const existing = runtime.identity.listAgents();
      if (existing.length === 0) {
        const agentName = (Array.isArray(agents) && agents.length > 0 && agents[0]?.name)
          ? agents[0].name
          : "AICQ Agent";
        runtime.identity.createAgent(agentId, agentName);
        console.log(`[AICQ Channel] Created agent identity: ${agentId}`);
      }
    }

    // Connect to the AICQ server
    if (runtime.serverClient) {
      try {
        await runtime.serverClient.ensureAuth(agentId);
        console.log(`[AICQ Channel] Authenticated as ${agentId}`);

        // Connect WebSocket for real-time messages
        if (typeof runtime.serverClient.start === "function") {
          await runtime.serverClient.start(agentId);
          console.log("[AICQ Channel] WebSocket connected");
        } else if (typeof runtime.serverClient.connectWS === "function") {
          runtime.serverClient.connectWS();
          console.log("[AICQ Channel] WebSocket connecting");
        }

        // Sync friends and groups from server
        if (runtime.handleGateway) {
          try {
            await runtime.handleGateway("aicq.friends.list", {});
            await runtime.handleGateway("aicq.groups.list", {});
          } catch (e) {
            console.warn("[AICQ Channel] Initial sync failed:", e.message);
          }
        }

        // Auto-add friends from config (autoAddFriends list)
        const autoAddFriends = account?.autoAddFriends || cfg?.channels?.["aicq-chat"]?.autoAddFriends || [];
        if (Array.isArray(autoAddFriends) && autoAddFriends.length > 0) {
          console.log(`[AICQ Channel] Auto-adding ${autoAddFriends.length} friend(s) from config...`);
          for (const friendEntry of autoAddFriends) {
            try {
              const aicqNumber = typeof friendEntry === 'string' ? friendEntry : friendEntry.number;
              const friendMsg = typeof friendEntry === 'object' ? friendEntry.message : undefined;
              if (!aicqNumber) continue;
              const result = await runtime.handleGateway("aicq.friends.addByNumber", {
                number: aicqNumber,
                message: friendMsg || 'Hi, I\'d like to add you!',
              });
              if (result.error) {
                console.warn(`[AICQ Channel] Auto-add friend ${aicqNumber} failed: ${result.error}`);
              } else {
                console.log(`[AICQ Channel] Auto-add friend ${aicqNumber}: ${result.status}`);
              }
            } catch (e) {
              console.warn(`[AICQ Channel] Auto-add friend failed:`, e.message);
            }
          }
        }

        // Auto-accept pending friend requests if autoAcceptFriends is true
        if (account?.autoAcceptFriends && runtime.handleGateway) {
          try {
            const pendingResult = await runtime.handleGateway("aicq.friends.requests", {});
            if (pendingResult.requests && pendingResult.requests.length > 0) {
              for (const req of pendingResult.requests) {
                try {
                  await runtime.handleGateway("aicq.friends.acceptRequest", { request_id: req.session_id });
                  console.log(`[AICQ Channel] Auto-accepted friend request from ${req.requester_id}`);
                } catch (e) {
                  console.warn(`[AICQ Channel] Auto-accept failed:`, e.message);
                }
              }
            }
          } catch (e) {
            console.warn("[AICQ Channel] Auto-accept check failed:", e.message);
          }
        }
      } catch (e) {
        console.error("[AICQ Channel] Failed to connect:", e.message);
      }
    }

    // Wire up inbound message handling via channelRuntime if available
    if (ctx.channelRuntime) {
      const { reply, routing } = ctx.channelRuntime;
      if (reply && routing) {
        console.log("[AICQ Channel] channelRuntime available — AI dispatch enabled");

        // Set up the onNewMessage callback for the ChatManager
        // This handles both regular text messages and synthetic file notifications
        if (runtime.chat) {
          runtime.chat.setOnNewMessage(async (msg) => {
            try {
              // Skip stream and presence events — not user messages
              if (msg.type === 'stream_chunk' || msg.type === 'stream_end') return;

              const resolvedAgentId = agentId;
              const fromId = msg.from_id || msg.from || msg.sender_id;
              const isGroup = !!(msg.is_group || msg.isGroup);
              const isFileMsg = !!(msg.local_path || msg._synthetic);
              let textContent = msg.content || msg.text || "";

              // For file messages, include the local path info in the dispatch text
              if (isFileMsg && msg.local_path) {
                // The content already includes file info (from the synthetic message
                // generated in chat.js), so we just pass it through to the AI
              }

              const routeResult = await routing.resolveAgentRoute({
                channelId: "aicq-chat",
                accountId,
                fromId,
                chatType: isGroup ? "group" : "dm",
              });

              if (routeResult?.agentId) {
                await reply.dispatchReplyWithBufferedBlockDispatcher({
                  ctx: {
                    channelId: "aicq-chat",
                    accountId,
                    fromId,
                    text: textContent,
                    chatType: isGroup ? "group" : "dm",
                  },
                  cfg,
                  dispatcherOptions: {
                    deliver: async (payload) => {
                      if (runtime.chat && payload.text) {
                        await runtime.chat.sendMessage(
                          resolvedAgentId,
                          fromId,
                          payload.text,
                          { isGroup }
                        );
                      }
                    },
                  },
                });
              }
            } catch (e) {
              console.error("[AICQ Channel] Inbound message handling error:", e.message);
            }
          });
        }
      }
    } else {
      console.log("[AICQ Channel] channelRuntime not available — running in standalone mode");
    }

    // Update health status
    setStatus({
      accountId,
      enabled: true,
      configured: true,
      running: true,
      lastStartAt: Date.now(),
      lastError: null,
    });

    console.log(`[AICQ Channel] Account ${accountId} started successfully`);

    // ── Keep startAccount alive until abort signal ──────────────────
    // OpenClaw expects startAccount to be a long-lived task. If it
    // resolves immediately, the gateway treats it as an unexpected
    // exit and enters a restart loop. We wait on the abort signal.
    await new Promise((resolve) => {
      if (abortSignal?.aborted) { resolve(); return; }
      const onAbort = () => { cleanup(); resolve(); };
      const cleanup = () => { abortSignal?.removeEventListener("abort", onAbort); };
      abortSignal?.addEventListener("abort", onAbort, { once: true });
    });
  },

  /**
   * Stop the channel account — disconnect and clean up.
   */
  async stopAccount(ctx) {
    const { accountId } = ctx;
    console.log(`[AICQ Channel] stopAccount called for ${accountId}`);

    if (runtime.serverClient) {
      try {
        if (typeof runtime.serverClient.stop === "function") {
          runtime.serverClient.stop();
        } else if (typeof runtime.serverClient.disconnect === "function") {
          runtime.serverClient.disconnect();
        }
        console.log("[AICQ Channel] WebSocket disconnected");
      } catch (e) {
        console.warn("[AICQ Channel] Disconnect error:", e.message);
      }
    }
  },
};

// ── Add config helpers (required by OpenClaw channel loader) ──────────
// createChatChannelPlugin does not auto-attach config helpers,
// but the OpenClaw loader requires plugin.config.listAccountIds
// and plugin.config.resolveAccount for channel registration.

// resolveTemplateVar is defined at the top of this file.

_plugin.config = {
  /**
   * List all account IDs configured for this channel.
   * Resolves template variables like {{agent.id}}.
   *
   * Signature: (cfg: OpenClawConfig) => string[]
   */
  listAccountIds(cfg) {
    const section = (cfg.channels || {})["aicq-chat"] || {};
    if (section.accountId) {
      const resolved = resolveTemplateVar(cfg, section.accountId);
      return [resolved];
    }
    return [];
  },

  /**
   * Resolve an account from config. Reuses the setup resolver.
   *
   * Signature: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount
   */
  resolveAccount,

  /**
   * Lightweight account inspection.
   *
   * Signature: (cfg: OpenClawConfig, accountId?: string | null) => unknown
   */
  inspectAccount,

  /**
   * Default account ID for this channel.
   *
   * Signature: (cfg: OpenClawConfig) => string
   */
  defaultAccountId(cfg) {
    const section = (cfg.channels || {})["aicq-chat"] || {};
    if (section.accountId) {
      return resolveTemplateVar(cfg, section.accountId);
    }
    return OPENCLAW_DEFAULT_AGENT_ID;
  },

  /**
   * Check if the account is enabled.
   *
   * IMPORTANT: OpenClaw calls this with (account, cfg) where `account`
   * is the RESOLVED account object from resolveAccount(), not the config.
   *
   * Signature: (account: ResolvedAccount, cfg: OpenClawConfig) => boolean
   */
  isEnabled(account, cfg) {
    return account.enabled !== false;
  },

  /**
   * Check if the channel account is configured.
   *
   * IMPORTANT: OpenClaw calls this with (account, cfg) where `account`
   * is the RESOLVED account object from resolveAccount(), not the config.
   * Our old code had isConfigured(cfg) which received the account object
   * as `cfg`, causing it to always return false — this was the root cause
   * of the "not-running" bug.
   *
   * Signature: (account: ResolvedAccount, cfg: OpenClawConfig) => boolean
   */
  isConfigured(account, cfg) {
    return Boolean(account && account.accountId);
  },

  /**
   * Return the reason the channel is not configured.
   *
   * Signature: (account: ResolvedAccount, cfg: OpenClawConfig) => string
   */
  unconfiguredReason(account, cfg) {
    if (!account || !account.accountId) {
      return "accountId is required — set channels.aicq-chat.accountId in openclaw.json";
    }
    return null;
  },

  /**
   * Describe the account for status surfaces.
   *
   * IMPORTANT: OpenClaw calls this with (account, cfg) where `account`
   * is the RESOLVED account object, not the config.
   *
   * Signature: (account: ResolvedAccount, cfg: OpenClawConfig) => ChannelAccountSnapshot
   */
  describeAccount(account, cfg) {
    return {
      accountId: account?.accountId || null,
      label: "AICQ Encrypted Chat",
      enabled: account?.enabled !== false,
    };
  },
};

export const aicqChatPlugin = _plugin;

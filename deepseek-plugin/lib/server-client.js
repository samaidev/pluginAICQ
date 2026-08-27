/**
 * AICQ Server Client — REST + WebSocket communication
 */
const WebSocket = require('ws');
const fetch = require('node-fetch');
const { signMessage, computeFingerprint } = require('./crypto');

class ServerClient {
  constructor(identityManager, db, serverUrl = 'https://aicq.me') {
    this.identity = identityManager;
    this.db = db;
    this.serverUrl = serverUrl;
    this.apiUrl = `${serverUrl}/api/v1`;
    this.wsUrl = serverUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws';
    this.jwtToken = null;
    this.ws = null;
    this.connected = false;
    this.currentAgentId = null;
    this._messageHandlers = {};
    this._reconnectTimer = null;
    this._backoff = 1000;
    this._running = false;
  }

  // ─── REST API ─────────────────────────────────────────────────────

  async _request(method, path, body = null, headers = {}) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    if (this.jwtToken) {
      opts.headers['Authorization'] = `Bearer ${this.jwtToken}`;
    }
    if (body) {
      opts.body = JSON.stringify(body);
    }
    const resp = await fetch(`${this.apiUrl}${path}`, opts);
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error || data.message || `HTTP ${resp.status}`);
    }
    return data;
  }

  /**
   * Register an AI agent on the server
   */
  async registerAgent(agentId) {
    const identity = this.identity.loadAgent(agentId);
    if (!identity) throw new Error('Agent identity not found');
    const data = await this._request('POST', '/auth/register/ai', {
      public_key: identity.signing_public_key,
      agent_name: identity.nickname || agentId,
    });
    if (data.access_token || data.accessToken) {
      this.jwtToken = data.access_token || data.accessToken;
      this.currentAgentId = agentId;
      // Store server-side account ID for WS auth (nodeId must match JWT sub)
      if (data.account && data.account.id) {
        this.serverAccountId = data.account.id;
      }
    }
    return data;
  }

  /**
   * Get auth challenge and login
   */
  async loginAgent(agentId) {
    const identity = this.identity.loadAgent(agentId);
    if (!identity) throw new Error('Agent identity not found');

    // Get challenge
    const challengeData = await this._request('POST', '/auth/challenge', {
      public_key: identity.signing_public_key,
    });
    const challenge = challengeData.challenge;

    // Sign challenge
    const signature = signMessage(challenge, identity.signing_secret_key);

    // Login with signed challenge
    const loginData = await this._request('POST', '/auth/login/agent', {
      public_key: identity.signing_public_key,
      signature,
      challenge,
    });

    if (loginData.access_token || loginData.accessToken) {
      this.jwtToken = loginData.access_token || loginData.accessToken;
      this.currentAgentId = agentId;
      // Store server-side account ID for WS auth (nodeId must match JWT sub)
      if (loginData.account && loginData.account.id) {
        this.serverAccountId = loginData.account.id;
      }
    }
    return loginData;
  }

  /**
   * Ensure we're authenticated, try register then login
   */
  async ensureAuth(agentId) {
    this.currentAgentId = agentId;
    try {
      return await this.loginAgent(agentId);
    } catch (e) {
      // If login fails, try registering first
      try {
        await this.registerAgent(agentId);
        return await this.loginAgent(agentId);
      } catch (e2) {
        throw new Error(`Auth failed: ${e2.message}`);
      }
    }
  }

  // ─── Friend API ──────────────────────────────────────────────────

  async listFriends() {
    return this._request('GET', '/friends');
  }

  async sendFriendRequest(toId, message = '') {
    const body = { to_id: toId };
    if (message) body.message = message;
    return this._request('POST', '/friends/request', body);
  }

  async listFriendRequests() {
    return this._request('GET', '/friends/requests');
  }

  async acceptFriendRequest(requestId) {
    return this._request('POST', `/friends/requests/${requestId}/accept`);
  }

  async rejectFriendRequest(requestId) {
    return this._request('POST', `/friends/requests/${requestId}/reject`);
  }

  async removeFriend(friendId) {
    return this._request('DELETE', `/friends/${friendId}`);
  }

  // ─── Group API ───────────────────────────────────────────────────

  async listGroups() {
    return this._request('GET', '/groups');
  }

  async createGroup(name, description = '') {
    return this._request('POST', '/groups', { name, description });
  }

  async getGroupMessages(groupId, limit = 50, before = null) {
    let path = `/groups/${groupId}/messages?limit=${limit}`;
    if (before) path += `&before=${before}`;
    return this._request('GET', path);
  }

  async inviteGroupMember(groupId, accountId) {
    return this._request('POST', `/groups/${groupId}/members`, { account_id: accountId });
  }

  // ─── Chat / Message API ──────────────────────────────────────────

  /**
   * Fetch conversation history with a friend from the server.
   * GET /api/v1/chat/conversation/:friendId?limit=50
   */
  async getConversation(friendId, limit = 50, before = null) {
    let path = `/chat/conversation/${friendId}?limit=${limit}`;
    if (before) path += `&before=${encodeURIComponent(before)}`;
    return this._request('GET', path);
  }

  /**
   * Send a message to a friend via REST API.
   * POST /api/v1/chat/messages
   */
  async sendChatMessage(toId, content, msgType = 'text', extra = {}) {
    const body = {
      to: toId,
      data: {
        type: msgType,
        content,
        ...extra,
      },
    };
    return this._request('POST', '/chat/messages', body);
  }

  /**
   * Mark messages from a friend as read.
   * POST /api/v1/chat/mark-read
   */
  async markRead(friendId) {
    return this._request('POST', '/chat/mark-read', { friend_id: friendId });
  }

  // ─── Temp Number / Handshake API ─────────────────────────────────

  async generateTempNumber() {
    return this._request('POST', '/temp-number');
  }

  async resolveTempNumber(number) {
    return this._request('GET', `/temp-number/${number}`);
  }

  async initiateHandshake(tempNumber) {
    return this._request('POST', '/handshake/initiate', { temp_number: tempNumber });
  }

  async respondHandshake(sessionId, responseData) {
    return this._request('POST', '/handshake/respond', { session_id: sessionId, response_data: responseData });
  }

  async confirmHandshake(sessionId, confirmData) {
    return this._request('POST', '/handshake/confirm', { session_id: sessionId, confirm_data: confirmData });
  }

  async getPendingHandshakes() {
    return this._request('GET', '/handshake/pending');
  }

  // ─── WebSocket ───────────────────────────────────────────────────

  connectWS() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    const identity = this.identity.loadAgent(this.currentAgentId);
    if (!identity || !this.jwtToken) {
      console.error('[WS] No identity or token for WebSocket connection');
      return;
    }

    try {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', () => {
        console.log('[WS] Connected, sending auth...');
        this.ws.send(JSON.stringify({
          type: 'online',
          nodeId: this.serverAccountId || this.currentAgentId,
          token: this.jwtToken,
        }));

        // Send periodic ping to keep WS alive (aicq.me server closes idle
        // connections after ~60s). Server responds to {type:"ping"} with
        // {type:"pong"} — see handler/ws.go.
        if (this._pingTimer) clearInterval(this._pingTimer);
        this._pingTimer = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
              this.ws.send(JSON.stringify({ type: 'ping' }));
            } catch (e) {
              console.warn('[WS] Ping send failed:', e.message);
            }
          }
        }, 25000); // every 25s — well under the 60s idle timeout
      });

      this.ws.on('message', (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          this._handleWSMessage(data);
        } catch (e) {
          console.error('[WS] Parse error:', e.message);
        }
      });

      this.ws.on('close', () => {
        console.log('[WS] Disconnected');
        this.connected = false;
        if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
        this._scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        console.error('[WS] Error:', err.message);
        this.connected = false;
      });
    } catch (e) {
      console.error('[WS] Connect error:', e.message);
      this._scheduleReconnect();
    }
  }

  _handleWSMessage(data) {
    const type = data.type;

    if (type === 'online_ack') {
      this.connected = true;
      this._backoff = 1000;
      console.log('[WS] Authenticated as', data.nodeId);
      // Notify reconnect handlers so ChatManager can fetch missed messages
      const reconnectHandlers = this._messageHandlers['_reconnected'] || [];
      for (const handler of reconnectHandlers) {
        try { handler(data); } catch (e) { console.error('[WS] Reconnect handler error:', e); }
      }
      // Don't return here — let handlers (e.g. unread_counts) process too
    }

    if (type === 'error') {
      console.error('[WS] Server error:', data.message || data.code);
      // Don't return — let handlers see the error too
    }

    // Dispatch to registered handlers
    const handlers = this._messageHandlers[type] || [];
    for (const handler of handlers) {
      try {
        const result = handler(data);
        if (result && typeof result.catch === 'function') {
          result.catch(e => console.error(`[WS] Async handler error for ${type}:`, e.message));
        }
      } catch (e) { console.error(`[WS] Handler error for ${type}:`, e); }
    }

    // Wildcard handlers
    const wildcards = this._messageHandlers['*'] || [];
    for (const handler of wildcards) {
      try { handler(data); } catch (e) { console.error(`[WS] Wildcard handler error:`, e); }
    }
  }

  onMessage(type, handler) {
    if (!this._messageHandlers[type]) this._messageHandlers[type] = [];
    this._messageHandlers[type].push(handler);
  }

  sendWS(data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(data));
    return true;
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      console.log(`[WS] Reconnecting (backoff ${this._backoff}ms)...`);
      this._backoff = Math.min(this._backoff * 2, 60000);
      this.connectWS();
    }, this._backoff);
  }

  /**
   * Start the server client: authenticate and connect WebSocket
   */
  async start(agentId) {
    try {
      await this.ensureAuth(agentId);
      this.connectWS();
      this._running = true;
      console.log('[ServerClient] Started for agent:', agentId);
    } catch (e) {
      console.error('[ServerClient] Start failed:', e.message);
      this._scheduleReconnect();
    }
  }

  /**
   * Switch to a different agent
   */
  async switchAgent(agentId) {
    this.disconnect();
    await this.start(agentId);
  }

  disconnect() {
    if (this.ws) {
      // SPEC 合规: offline 消息必须带 nodeId 字段
      // 见 aicqSDK/SPEC.md 第 215-219 行
      try {
        const nodeId = this.currentAgentId || (this.identity && this.identity.currentAgentId) || '';
        this.ws.send(JSON.stringify({ type: 'offline', nodeId }));
      } catch (e) {}
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  stop() {
    this._running = false;
    this.disconnect();
  }

  /**
   * Get the current JWT access token for a given agent
   */
  getAccessToken(agentId) {
    return this.jwtToken || '';
  }
}

module.exports = ServerClient;

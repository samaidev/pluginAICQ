/**
 * AICQ Handshake Manager — P2P handshake via temp numbers
 */
const { computeFingerprint } = require('./crypto');
const crypto = require('crypto');

class HandshakeManager {
  constructor(identityManager, serverClient, db) {
    this.identity = identityManager;
    this.server = serverClient;
    this.db = db;
  }

  /**
   * Generate a temp number and return it for sharing
   */
  async generateFriendCode(agentId) {
    await this.server.ensureAuth(agentId);
    const result = await this.server.generateTempNumber();
    if (result.number) {
      this.db.saveTempNumber({
        agent_id: agentId,
        number: result.number,
        expires_at: result.expiresAt || result.expires_at,
      });
    }
    return result;
  }

  /**
   * Add a friend using their temp number / friend code
   */
  async addFriendByCode(agentId, tempNumber) {
    await this.server.ensureAuth(agentId);
    // Resolve the temp number
    const resolved = await this.server.resolveTempNumber(tempNumber);
    if (!resolved) throw new Error('Invalid or expired friend code');

    // Initiate handshake
    const result = await this.server.initiateHandshake(tempNumber);

    // If we got the peer's public key, derive session and add friend
    if (resolved.node_id || resolved.public_key) {
      const peerId = resolved.node_id || resolved.id;
      const peerPublicKey = resolved.public_key;

      // Derive session key
      let sessionKey = null;
      try {
        const identity = this.identity.loadAgent(agentId);
        if (identity && peerPublicKey) {
          const { deriveSessionKey } = require('./crypto');
          sessionKey = deriveSessionKey(identity.exchange_secret_key, peerPublicKey);
        }
      } catch (e) {
        console.error('[Handshake] Session key derivation failed:', e.message);
      }

      // Add friend locally
      if (peerId) {
        this.db.addFriend({
          agent_id: agentId,
          id: peerId,
          public_key: peerPublicKey || '',
          fingerprint: peerPublicKey ? computeFingerprint(peerPublicKey) : '',
          friend_type: 'ai',
        });

        // Save session if we have a key
        if (sessionKey) {
          this.db.saveSession({
            agent_id: agentId,
            peer_id: peerId,
            session_key: sessionKey,
          });
        }
      }
    }

    return result;
  }

  /**
   * List pending handshake requests.
   *
   * Tries the server first (aicq.me-style friend_requests table).
   * Falls back to local pending_requests table for legacy mode.
   */
  async getPendingRequests(agentId) {
    try {
      await this.server.ensureAuth(agentId);
      const result = await this.server.listFriendRequests();
      const received = Array.isArray(result?.received) ? result.received : [];
      // Normalise to the same shape as local pending_requests rows.
      return received
        .filter((r) => r.status === 'pending')
        .map((r) => ({
          agent_id: agentId,
          session_id: r.id, // server request id
          requester_id: r.from_id,
          requester_public_key: r.from_public_key || '',
          timestamp: r.created_at,
          message: r.message || '',
          _source: 'server',
        }));
    } catch (e) {
      console.warn('[Handshake] getPendingRequests: server query failed, falling back to local DB:', e.message);
      return this.db.getPendingRequests(agentId);
    }
  }

  /**
   * Accept a pending friend request.
   *
   * Acceptance goes through the server's
   * POST /friends/requests/:id/accept endpoint so that the server
   * creates the bidirectional friendship and notifies the requester.
   * After acceptance we also add the friend locally.
   */
  async acceptRequest(agentId, requestId) {
    if (!requestId) throw new Error('request_id is required');

    // Try to fetch the requester's public key from server response
    let requesterPublicKey = '';
    let requesterId = '';
    try {
      const pending = await this.getPendingRequests(agentId);
      const found = pending.find((r) => r.session_id === requestId);
      if (found) {
        requesterPublicKey = found.requester_public_key || '';
        requesterId = found.requester_id || '';
      }
    } catch (e) {
      console.warn('[Handshake] acceptRequest: failed to look up pending request:', e.message);
    }

    // Call server accept API
    await this.server.ensureAuth(agentId);
    await this.server.acceptFriendRequest(requestId);

    // Derive session key (best-effort — only if we have the peer's public key)
    let sessionKey = null;
    try {
      const identity = this.identity.loadAgent(agentId);
      if (identity && requesterPublicKey) {
        const { deriveSessionKey } = require('./crypto');
        sessionKey = deriveSessionKey(identity.exchange_secret_key, requesterPublicKey);
      }
    } catch (e) {
      console.warn('[Handshake] Session key derivation failed:', e.message);
    }

    // Add friend locally (server already added bidirectionally)
    if (requesterId) {
      const { computeFingerprint } = require('./crypto');
      // Don't duplicate
      const exists = this.db.listFriends(agentId).find((f) => f.id === requesterId);
      if (!exists) {
        this.db.addFriend({
          agent_id: agentId,
          id: requesterId,
          public_key: requesterPublicKey,
          fingerprint: requesterPublicKey ? computeFingerprint(requesterPublicKey) : '',
          friend_type: 'human',
        });
      }
      if (sessionKey) {
        this.db.saveSession({
          agent_id: agentId,
          peer_id: requesterId,
          session_key: sessionKey,
        });
      }
    }

    // Remove from local pending_requests (if it was stored there)
    this.db.removePendingRequest(agentId, requestId);

    return { success: true, friend_id: requesterId };
  }

  /**
   * Reject a pending friend request.
   *
   * Calls server's POST /friends/requests/:id/reject endpoint.
   */
  async rejectRequest(agentId, requestId) {
    if (!requestId) throw new Error('request_id is required');
    try {
      await this.server.ensureAuth(agentId);
      await this.server.rejectFriendRequest(requestId);
    } catch (e) {
      console.warn('[Handshake] rejectRequest: server call failed:', e.message);
    }
    this.db.removePendingRequest(agentId, requestId);
    return { success: true };
  }
}

module.exports = HandshakeManager;

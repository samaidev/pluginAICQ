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
   * List pending handshake requests
   */
  async getPendingRequests(agentId) {
    return this.db.getPendingRequests(agentId);
  }

  /**
   * Accept a pending handshake request
   */
  async acceptRequest(agentId, sessionId) {
    const request = this.db.getPendingRequests(agentId).find(r => r.session_id === sessionId);
    if (!request) throw new Error('Request not found');

    // Derive session key
    let sessionKey = null;
    try {
      const identity = this.identity.loadAgent(agentId);
      if (identity && request.requester_public_key) {
        const { deriveSessionKey } = require('./crypto');
        sessionKey = deriveSessionKey(identity.exchange_secret_key, request.requester_public_key);
      }
    } catch (e) {
      console.error('[Handshake] Session key derivation failed:', e.message);
    }

    // Add friend
    this.db.addFriend({
      agent_id: agentId,
      id: request.requester_id,
      public_key: request.requester_public_key,
      fingerprint: computeFingerprint(request.requester_public_key),
      friend_type: 'ai',
    });

    // Save session
    if (sessionKey) {
      this.db.saveSession({
        agent_id: agentId,
        peer_id: request.requester_id,
        session_key: sessionKey,
      });
    }

    // Respond to server
    await this.server.respondHandshake(sessionId, {
      public_key: this.identity.loadAgent(agentId).exchange_public_key,
    });

    // Remove pending request
    this.db.removePendingRequest(agentId, sessionId);

    return { success: true, friend_id: request.requester_id };
  }

  /**
   * Reject a pending handshake request
   */
  async rejectRequest(agentId, sessionId) {
    this.db.removePendingRequest(agentId, sessionId);
    return { success: true };
  }
}

module.exports = HandshakeManager;

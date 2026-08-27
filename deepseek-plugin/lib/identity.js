/**
 * AICQ Identity Manager — Ed25519 + X25519 key management
 */
const crypto = require('./crypto');

class IdentityManager {
  constructor(db) {
    this.db = db;
    this._cache = {}; // agent_id -> identity
  }

  /**
   * Create a new agent identity
   */
  createAgent(agentId, nickname = '') {
    const signing = crypto.generateSigningKeypair();
    const exchange = crypto.generateExchangeKeypair();
    const fingerprint = crypto.computeFingerprint(signing.publicKey);

    this.db.saveIdentity({
      agent_id: agentId,
      nickname: nickname || agentId,
      signing_public_key: signing.publicKey,
      signing_secret_key: signing.secretKey,
      exchange_public_key: exchange.publicKey,
      exchange_secret_key: exchange.secretKey,
    });

    this._cache[agentId] = {
      agent_id: agentId,
      nickname: nickname || agentId,
      signing_public_key: signing.publicKey,
      signing_secret_key: signing.secretKey,
      exchange_public_key: exchange.publicKey,
      exchange_secret_key: exchange.secretKey,
      fingerprint,
    };

    return this._cache[agentId];
  }

  /**
   * Load an existing identity into cache
   */
  loadAgent(agentId) {
    if (this._cache[agentId]) return this._cache[agentId];
    const row = this.db.loadIdentity(agentId);
    if (!row) return null;
    row.fingerprint = crypto.computeFingerprint(row.signing_public_key);
    this._cache[agentId] = row;
    return row;
  }

  /**
   * Get current identity (load first one if agentId not specified)
   */
  getCurrent(agentId) {
    if (agentId) return this.loadAgent(agentId);
    const identities = this.db.listIdentities();
    if (identities.length === 0) return null;
    return this.loadAgent(identities[0].agent_id);
  }

  /**
   * List all agent identities
   */
  listAgents() {
    return this.db.listIdentities();
  }

  /**
   * Delete an agent identity
   */
  deleteAgent(agentId) {
    delete this._cache[agentId];
    this.db.deleteIdentity(agentId);
  }

  /**
   * Update agent nickname
   */
  updateNickname(agentId, nickname) {
    this.db.updateNickname(agentId, nickname);
    if (this._cache[agentId]) {
      this._cache[agentId].nickname = nickname;
    }
  }

  /**
   * Sign a message with the agent's signing key
   */
  sign(agentId, message) {
    const identity = this.loadAgent(agentId);
    if (!identity) throw new Error('Identity not found');
    return crypto.signMessage(message, identity.signing_secret_key);
  }

  /**
   * Derive a session key with a peer
   */
  deriveSessionKey(agentId, peerExchangePublicKeyB64) {
    const identity = this.loadAgent(agentId);
    if (!identity) throw new Error('Identity not found');
    return crypto.deriveSessionKey(identity.exchange_secret_key, peerExchangePublicKeyB64);
  }

  /**
   * Rotate keys for an agent
   */
  rotateKeys(agentId) {
    const oldIdentity = this.loadAgent(agentId);
    if (!oldIdentity) throw new Error('Identity not found');

    const signing = crypto.generateSigningKeypair();
    const exchange = crypto.generateExchangeKeypair();

    this.db.saveIdentity({
      agent_id: agentId,
      nickname: oldIdentity.nickname,
      signing_public_key: signing.publicKey,
      signing_secret_key: signing.secretKey,
      exchange_public_key: exchange.publicKey,
      exchange_secret_key: exchange.secretKey,
    });

    this._cache[agentId] = {
      ...oldIdentity,
      signing_public_key: signing.publicKey,
      signing_secret_key: signing.secretKey,
      exchange_public_key: exchange.publicKey,
      exchange_secret_key: exchange.secretKey,
      fingerprint: crypto.computeFingerprint(signing.publicKey),
    };

    return this._cache[agentId];
  }

  /**
   * Update agent avatar
   */
  updateAvatar(agentId, avatarUrl) {
    this.db.updateAvatar(agentId, avatarUrl);
    if (this._cache[agentId]) {
      this._cache[agentId].avatar = avatarUrl;
    }
  }

  /**
   * Get identity info (public keys only, no secrets)
   */
  getInfo(agentId) {
    const identity = this.loadAgent(agentId);
    if (!identity) return null;
    return {
      agent_id: identity.agent_id,
      nickname: identity.nickname,
      avatar: identity.avatar || null,
      signing_public_key: identity.signing_public_key,
      exchange_public_key: identity.exchange_public_key,
      fingerprint: identity.fingerprint,
    };
  }
}

module.exports = IdentityManager;

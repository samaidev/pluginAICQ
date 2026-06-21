/**
 * AICQ Plugin Database — SQLite via sql.js (pure WASM, no native compilation)
 *
 * This replaces better-sqlite3 with sql.js to avoid C++ native binding issues
 * when installed via `openclaw plugins install`.
 *
 * Usage:
 *   const db = new PluginDatabase(dataDir);
 *   await db.init();   // MUST call init() before using any methods
 *   ... use db methods (all synchronous after init) ...
 *   db.close();
 */
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

class PluginDatabase {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.db = null;
    this.dbPath = path.join(dataDir, 'aicq-plugin.db');
    this._dirty = false;
    this._saveTimer = null;
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // ── Async initialization ────────────────────────────────────────────
  async init() {
    const SQL = await initSqlJs();

    // Load existing database or create new
    if (fs.existsSync(this.dbPath)) {
      try {
        const buffer = fs.readFileSync(this.dbPath);
        this.db = new SQL.Database(buffer);
      } catch (e) {
        console.error('[AICQ DB] Failed to load database, creating new one:', e.message);
        this.db = new SQL.Database();
      }
    } else {
      this.db = new SQL.Database();
    }

    this.db.run('PRAGMA foreign_keys = ON');
    this._initSchema();
    this._save(); // Persist initial schema
  }

  // ── Persist database to disk ────────────────────────────────────────
  _save() {
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
      this._dirty = false;
    } catch (e) {
      console.error('[AICQ DB] Save failed:', e.message);
    }
  }

  // Debounced save — coalesces multiple writes within 500ms
  _scheduleSave() {
    this._dirty = true;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._save(), 500);
  }

  // ── Schema ──────────────────────────────────────────────────────────
  _initSchema() {
    this._execScript(`
      CREATE TABLE IF NOT EXISTS identity (
        agent_id            TEXT PRIMARY KEY,
        nickname            TEXT NOT NULL DEFAULT '',
        avatar              TEXT NOT NULL DEFAULT '',
        signing_public_key  TEXT NOT NULL,
        signing_secret_key  TEXT NOT NULL,
        exchange_public_key TEXT NOT NULL,
        exchange_secret_key TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        updated_at          TEXT
      );

      CREATE TABLE IF NOT EXISTS friends (
        id            TEXT PRIMARY KEY,
        agent_id      TEXT NOT NULL,
        public_key    TEXT NOT NULL,
        fingerprint   TEXT NOT NULL,
        added_at      TEXT NOT NULL,
        last_seen     TEXT,
        is_online     INTEGER NOT NULL DEFAULT 0,
        permissions   TEXT NOT NULL DEFAULT '["chat"]',
        friend_type   TEXT NOT NULL DEFAULT 'ai',
        ai_name       TEXT NOT NULL DEFAULT '',
        ai_avatar     TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS groups (
        id            TEXT PRIMARY KEY,
        agent_id      TEXT NOT NULL,
        name          TEXT NOT NULL,
        owner_id      TEXT NOT NULL,
        members_json  TEXT NOT NULL DEFAULT '[]',
        description   TEXT,
        silent_mode   INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        peer_id          TEXT PRIMARY KEY,
        agent_id         TEXT NOT NULL,
        session_key      TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        message_count    INTEGER NOT NULL DEFAULT 0,
        last_rotation    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_history (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        target_id   TEXT NOT NULL,
        from_id     TEXT NOT NULL,
        to_id       TEXT NOT NULL,
        type        TEXT NOT NULL DEFAULT 'text',
        content     TEXT NOT NULL DEFAULT '',
        file_url    TEXT,
        file_name   TEXT,
        is_group    INTEGER NOT NULL DEFAULT 0,
        mentions    TEXT NOT NULL DEFAULT '[]',
        timestamp   TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending'
      );

      CREATE TABLE IF NOT EXISTS pending_requests (
        session_id            TEXT PRIMARY KEY,
        agent_id              TEXT NOT NULL,
        requester_id          TEXT NOT NULL,
        requester_public_key  TEXT NOT NULL,
        timestamp             TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS temp_numbers (
        number      TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS offline_queue (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id    TEXT NOT NULL,
        target_id   TEXT NOT NULL,
        data        TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS group_settings (
        group_id    TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        silent_mode INTEGER NOT NULL DEFAULT 0
      );
    `);

    // Create indexes (must be separate statements)
    this.db.run('CREATE INDEX IF NOT EXISTS idx_friends_agent ON friends(agent_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_groups_agent ON groups(agent_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_chat_agent_target ON chat_history(agent_id, target_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON chat_history(agent_id, target_id, timestamp)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_offline_target ON offline_queue(agent_id, target_id)');
  }

  // Execute multiple SQL statements (like db.exec in better-sqlite3)
  _execScript(sql) {
    // sql.js db.exec() can handle multiple statements but returns results.
    // For DDL statements we just use run() for each.
    const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of statements) {
      try {
        this.db.run(stmt);
      } catch (e) {
        // Ignore "already exists" errors for CREATE TABLE/INDEX
        if (!e.message.includes('already exists')) {
          console.error('[AICQ DB] Schema error:', e.message, 'SQL:', stmt.substring(0, 80));
        }
      }
    }
  }

  // ── Query helpers ───────────────────────────────────────────────────

  // Run a parameterized write query, then schedule save
  _run(sql, params) {
    this.db.run(sql, params || []);
    this._scheduleSave();
  }

  // Get a single row as an object
  _get(sql, params) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params || []);
    let row = null;
    if (stmt.step()) {
      row = stmt.getAsObject();
    }
    stmt.free();
    return row;
  }

  // Get all rows as objects
  _all(sql, params) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params || []);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  // ─── Identity ──────────────────────────────────────────────────────

  saveIdentity({ agent_id, nickname, signing_public_key, signing_secret_key, exchange_public_key, exchange_secret_key }) {
    const now = new Date().toISOString();
    this._run(
      `INSERT OR REPLACE INTO identity (agent_id, nickname, signing_public_key, signing_secret_key, exchange_public_key, exchange_secret_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [agent_id, nickname || '', signing_public_key, signing_secret_key, exchange_public_key, exchange_secret_key, now, now]
    );
  }

  loadIdentity(agentId) {
    return this._get('SELECT * FROM identity WHERE agent_id = ?', [agentId]);
  }

  listIdentities() {
    return this._all('SELECT agent_id, nickname, signing_public_key, exchange_public_key, created_at FROM identity');
  }

  deleteIdentity(agentId) {
    this._run('DELETE FROM identity WHERE agent_id = ?', [agentId]);
    this._run('DELETE FROM friends WHERE agent_id = ?', [agentId]);
    this._run('DELETE FROM groups WHERE agent_id = ?', [agentId]);
    this._run('DELETE FROM chat_history WHERE agent_id = ?', [agentId]);
    this._run('DELETE FROM sessions WHERE agent_id = ?', [agentId]);
  }

  updateNickname(agentId, nickname) {
    const now = new Date().toISOString();
    this._run('UPDATE identity SET nickname = ?, updated_at = ? WHERE agent_id = ?', [nickname, now, agentId]);
  }

  updateAvatar(agentId, avatarUrl) {
    const now = new Date().toISOString();
    try {
      this._run('UPDATE identity SET avatar = ?, updated_at = ? WHERE agent_id = ?', [avatarUrl, now, agentId]);
    } catch (e) {
      if (e.message && e.message.includes('no column named avatar')) {
        this.db.run('ALTER TABLE identity ADD COLUMN avatar TEXT NOT NULL DEFAULT ""');
        this._run('UPDATE identity SET avatar = ?, updated_at = ? WHERE agent_id = ?', [avatarUrl, now, agentId]);
      } else {
        throw e;
      }
    }
  }

  // ─── Friends ───────────────────────────────────────────────────────

  addFriend({ agent_id, id, public_key, fingerprint, friend_type = 'ai', ai_name = '', permissions = ['chat'] }) {
    const now = new Date().toISOString();
    this._run(
      `INSERT OR REPLACE INTO friends (id, agent_id, public_key, fingerprint, added_at, is_online, permissions, friend_type, ai_name, ai_avatar)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, '')`,
      [id, agent_id, public_key, fingerprint, now, JSON.stringify(permissions), friend_type, ai_name]
    );
  }

  removeFriend(agentId, friendId) {
    this._run('DELETE FROM friends WHERE agent_id = ? AND id = ?', [agentId, friendId]);
    this._run('DELETE FROM sessions WHERE agent_id = ? AND peer_id = ?', [agentId, friendId]);
  }

  getFriend(agentId, friendId) {
    return this._get('SELECT * FROM friends WHERE agent_id = ? AND id = ?', [agentId, friendId]);
  }

  listFriends(agentId) {
    return this._all('SELECT * FROM friends WHERE agent_id = ? ORDER BY added_at DESC', [agentId]);
  }

  updateFriendOnline(agentId, friendId, isOnline) {
    const now = isOnline ? new Date().toISOString() : null;
    // COALESCE equivalent: if now is null, keep existing last_seen
    this._run(
      'UPDATE friends SET is_online = ?, last_seen = COALESCE(?, last_seen) WHERE agent_id = ? AND id = ?',
      [isOnline ? 1 : 0, now, agentId, friendId]
    );
  }

  // ─── Groups ────────────────────────────────────────────────────────

  addGroup({ agent_id, id, name, owner_id, members_json = '[]', description = '' }) {
    const now = new Date().toISOString();
    this._run(
      `INSERT OR REPLACE INTO groups (id, agent_id, name, owner_id, members_json, description, silent_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [id, agent_id, name, owner_id, typeof members_json === 'string' ? members_json : JSON.stringify(members_json), description, now, now]
    );
  }

  listGroups(agentId) {
    return this._all('SELECT * FROM groups WHERE agent_id = ? ORDER BY created_at DESC', [agentId]);
  }

  getGroup(agentId, groupId) {
    return this._get('SELECT * FROM groups WHERE agent_id = ? AND id = ?', [agentId, groupId]);
  }

  setGroupSilentMode(agentId, groupId, silent) {
    this._run(
      'INSERT OR REPLACE INTO group_settings (group_id, agent_id, silent_mode) VALUES (?, ?, ?)',
      [groupId, agentId, silent ? 1 : 0]
    );
  }

  getGroupSilentMode(agentId, groupId) {
    const row = this._get('SELECT silent_mode FROM group_settings WHERE group_id = ? AND agent_id = ?', [groupId, agentId]);
    return row ? !!row.silent_mode : false;
  }

  // ─── Sessions ──────────────────────────────────────────────────────

  saveSession({ agent_id, peer_id, session_key }) {
    const now = new Date().toISOString();
    this._run(
      `INSERT OR REPLACE INTO sessions (peer_id, agent_id, session_key, created_at, message_count, last_rotation)
       VALUES (?, ?, ?, ?, 0, ?)`,
      [peer_id, agent_id, session_key, now, now]
    );
  }

  loadSession(agentId, peerId) {
    return this._get('SELECT * FROM sessions WHERE agent_id = ? AND peer_id = ?', [agentId, peerId]);
  }

  incrementSessionMessageCount(agentId, peerId) {
    this._run('UPDATE sessions SET message_count = message_count + 1 WHERE agent_id = ? AND peer_id = ?', [agentId, peerId]);
  }

  // ─── Chat History ──────────────────────────────────────────────────

  saveMessage({ agent_id, target_id, from_id, to_id, type = 'text', content = '', file_url = null, file_name = null, is_group = 0, mentions = [], status = 'pending' }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this._run(
      `INSERT INTO chat_history (id, agent_id, target_id, from_id, to_id, type, content, file_url, file_name, is_group, mentions, timestamp, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, agent_id, target_id, from_id, to_id, type, content, file_url, file_name, is_group, JSON.stringify(mentions), now, status]
    );
    // Return the full message object so channel.js callback can read
    // from_id / content / type / etc.
    return {
      id,
      agent_id,
      target_id,
      from_id,
      to_id,
      type,
      content,
      file_url,
      file_name,
      is_group,
      timestamp: now,
      status,
    };
  }

  getChatHistory(agentId, targetId, { limit = 50, before = null } = {}) {
    if (before) {
      return this._all(
        'SELECT * FROM chat_history WHERE agent_id = ? AND target_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?',
        [agentId, targetId, before, limit]
      );
    }
    return this._all(
      'SELECT * FROM chat_history WHERE agent_id = ? AND target_id = ? ORDER BY timestamp DESC LIMIT ?',
      [agentId, targetId, limit]
    );
  }

  deleteMessage(agentId, messageId) {
    this._run('DELETE FROM chat_history WHERE agent_id = ? AND id = ?', [agentId, messageId]);
  }

  updateMessageStatus(agentId, messageId, status) {
    this._run('UPDATE chat_history SET status = ? WHERE agent_id = ? AND id = ?', [status, agentId, messageId]);
  }

  // ─── Pending Requests ──────────────────────────────────────────────

  savePendingRequest({ agent_id, session_id, requester_id, requester_public_key }) {
    const now = new Date().toISOString();
    this._run(
      `INSERT OR REPLACE INTO pending_requests (session_id, agent_id, requester_id, requester_public_key, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
      [session_id, agent_id, requester_id, requester_public_key, now]
    );
  }

  getPendingRequests(agentId) {
    return this._all('SELECT * FROM pending_requests WHERE agent_id = ? ORDER BY timestamp DESC', [agentId]);
  }

  removePendingRequest(agentId, sessionId) {
    this._run('DELETE FROM pending_requests WHERE agent_id = ? AND session_id = ?', [agentId, sessionId]);
  }

  // ─── Temp Numbers ──────────────────────────────────────────────────

  saveTempNumber({ agent_id, number, expires_at }) {
    const now = new Date().toISOString();
    this._run(
      'INSERT OR REPLACE INTO temp_numbers (number, agent_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      [number, agent_id, expires_at, now]
    );
  }

  // ─── Offline Queue ─────────────────────────────────────────────────

  enqueueOffline({ agent_id, target_id, data }) {
    const now = new Date().toISOString();
    this._run(
      'INSERT INTO offline_queue (agent_id, target_id, data, created_at) VALUES (?, ?, ?, ?)',
      [agent_id, target_id, data, now]
    );
  }

  dequeueOffline(agentId, targetId, limit = 100) {
    const rows = this._all(
      'SELECT * FROM offline_queue WHERE agent_id = ? AND target_id = ? ORDER BY created_at ASC LIMIT ?',
      [agentId, targetId, limit]
    );
    if (rows.length > 0) {
      const ids = rows.map(r => r.id);
      const placeholders = ids.map(() => '?').join(',');
      this._run(`DELETE FROM offline_queue WHERE id IN (${placeholders})`, ids);
    }
    return rows;
  }

  // ─── Cleanup ───────────────────────────────────────────────────────

  cleanup() {
    const now = new Date().toISOString();
    this._run("DELETE FROM temp_numbers WHERE expires_at < ?", [now]);
    this._run("DELETE FROM pending_requests WHERE timestamp < datetime(?, '-48 hours')", [now]);
    this._run("DELETE FROM offline_queue WHERE created_at < datetime(?, '-7 days')", [now]);
  }

  close() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
    }
    this._save(); // Final save before closing
    this.db.close();
  }
}

module.exports = PluginDatabase;

/**
 * aicq-sdk-adapter.js — AICQ SDK (Node.js) 适配层
 *
 * 本文件是 openclaw-plugin 接入 aicq-sdk (npm) 的过渡层。
 *
 * 长期目标：将 lib/identity.js、lib/server-client.js、lib/chat.js 中
 * 重复实现的 AICQ 协议逻辑替换为对 aicq-sdk 的调用，逐步删除重复代码。
 *
 * 迁移进度（详见 MIGRATION_TO_SDK.md）：
 *   Step 1 ✅ 引入 aicq-sdk，创建本适配层（当前文件）
 *   Step 2 ⏳ 计划中：迁移 IdentityManager
 *   Step 3 ⏳ 计划中：迁移 ServerClient
 *   Step 4 ⏳ 计划中：迁移 ChatManager
 *   Step 5 ⏳ 计划中：删除重复的 lib/ 模块
 *
 * 当前阶段（Step 1）：
 *   - 提供 AICQAdapter 类，封装 aicq-sdk 的 AICQClient
 *   - 暴露与 ServerClient 相似的方法签名，便于逐步替换
 *   - 不改变现有 ServerClient / IdentityManager / ChatManager 的行为
 *
 * 设计原则：
 *   - 适配层只做"格式转换 + 调用委托"，不重新实现协议
 *   - openclaw 现有 identity 格式（agentId + Ed25519 私钥 hex）与 aicq-sdk 的
 *     Agent 格式通过本层转换
 *   - 后续 Step 2+ 会将 server-client.js 的方法逐个改为调用本适配层
 */

'use strict';

let aicqSdk;
let sdkAvailable = false;
let sdkVersion = '0.0.0-unavailable';

try {
  aicqSdk = require('aicq-sdk');
  sdkAvailable = true;
  sdkVersion = require('aicq-sdk/package.json').version || 'unknown';
} catch (err) {
  // aicq-sdk 未安装 — 适配层仍可加载，但所有调用会抛错
  // 由 isSdkAvailable() 让调用方决定是否启用
  aicqSdk = null;
}

/**
 * AICQAdapter — 把 openclaw 的 identity 格式桥接到 aicq-sdk 的 Agent 格式。
 *
 * 生命周期：
 *   1. constructor: 创建 AICQClient 实例（不连接）
 *   2. importIdentity: 从 IdentityManager 注入 Ed25519 私钥 + token
 *   3. login: 调用 SDK 的 challenge-response login
 *   4. connect: 建立 WebSocket 连接，注册回调
 *   5. sendMessage / listFriends / ...: 委托给 SDK
 *   6. disconnect: 优雅断开（SDK 自动发送 offline 消息）
 */
class AICQAdapter {
  /**
   * @param {Object} options
   * @param {string} [options.server='https://aicq.me'] - AICQ server URL
   * @param {string} [options.dbPath] - optional SQLite DB path
   */
  constructor(options = {}) {
    if (!sdkAvailable) {
      throw new Error(
        `aicq-sdk ${sdkVersion} not available. ` +
        `Install with: npm install aicq-sdk@>=1.0.0`
      );
    }
    const { AICQClient } = aicqSdk;
    this.serverUrl = (options.server || 'https://aicq.me').replace(/\/$/, '');
    this._sdk = new AICQClient(this.serverUrl);
    this._imported = false;
    // 优先使用 openclaw-plugin 内置 logger，找不到时退化为 console
    try {
      const loggerMod = require('./logger');
      this._logger = loggerMod && typeof loggerMod.createLogger === 'function'
        ? loggerMod.createLogger('aicq-adapter')
        : console;
    } catch (_e) {
      this._logger = console;
    }
    this._logger.info(`AICQAdapter initialized (aicq-sdk ${sdkVersion}, server=${this.serverUrl})`);
  }

  /** 直接暴露底层 AICQClient，供高级用法使用。 */
  get sdk() {
    return this._sdk;
  }

  get isImported() {
    return this._imported;
  }

  // ─── Identity 注入（Step 2 会用本方法替代 identity.js） ──────────

  /**
   * 将 openclaw IdentityManager 管理的密钥注入 aicq-sdk。
   *
   * @param {Object} params
   * @param {string} params.agentId - openclaw 内部 agent ID
   * @param {string} params.signingKeyHex - 128-char Ed25519 private key hex
   * @param {string} params.publicKeyHex - 64-char Ed25519 public key hex
   * @param {string} [params.accessToken] - existing JWT access token
   * @param {string} [params.refreshToken] - existing JWT refresh token
   * @param {string} [params.accountId] - server-assigned account ID
   */
  async importIdentity({ agentId, signingKeyHex, publicKeyHex, accessToken, refreshToken, accountId }) {
    // aicq-sdk 的 AICQClient 当前没有公开的 importAgent 方法
    // （这与 Python/Go SDK 不同）。临时方案：用 createAgent + login。
    // 长期方案：在 aicq-sdk 中添加 importAgent 方法（与 Go SDK 对齐）。
    //
    // 这里我们仅记录意图，实际迁移在 Step 2 完成。
    this._pendingIdentity = { agentId, signingKeyHex, publicKeyHex, accessToken, refreshToken, accountId };
    this._logger.debug(`Identity pending import for agent=${agentId} (account=${accountId || agentId})`);
    // 标记为已导入以便后续 connect/send 调用知道身份可用
    this._imported = true;
  }

  // ─── 协议委托（后续 Step 3+ 会逐个迁移 server-client.js 的方法） ──

  /** 调用 SDK 的 challenge-response login，返回 access_token。 */
  async login() {
    if (!this._imported) {
      throw new Error('Must call importIdentity() before login()');
    }
    return await this._sdk.login();
  }

  /** 建立 WebSocket 连接。回调通过 onMessage/onGroupMessage 等注册。 */
  async connect() {
    await this._sdk.connect();
  }

  /** 优雅断开 — SDK 自动发送 offline 消息。 */
  async disconnect() {
    if (typeof this._sdk.disconnect === 'function') {
      await this._sdk.disconnect();
    } else if (typeof this._sdk.close === 'function') {
      await this._sdk.close();
    }
  }

  /** 发送私聊消息（委托给 SDK）。 */
  async sendMessage(friendId, content) {
    return await this._sdk.sendMessage(friendId, content);
  }

  /** 发送群组消息。 */
  async sendGroupMessage(groupId, content) {
    return await this._sdk.sendGroupMessage(groupId, content);
  }

  /** 列出好友。 */
  async listFriends() {
    return await this._sdk.listFriends();
  }

  /** 发送好友请求。 */
  async addFriend(publicKey) {
    return await this._sdk.addFriend(publicKey);
  }

  /** 上传文件。 */
  async uploadFile(fileName, fileData, mimeType) {
    return await this._sdk.uploadFile(fileName, fileData, mimeType);
  }

  // ─── 回调注册（Step 4 会用本方法替代 chat.js 的轮询） ─────────────

  /** 注册私聊消息回调。 */
  onMessage(callback) {
    this._sdk.onMessage(callback);
  }

  /** 注册群组消息回调。 */
  onGroupMessage(callback) {
    this._sdk.onGroupMessage(callback);
  }

  /** 注册流式输出 chunk 回调。 */
  onStreamChunk(callback) {
    this._sdk.onStreamChunk(callback);
  }

  /** 注册流式输出结束回调（aicq-sdk 1.0+ 新增）。 */
  onStreamEnd(callback) {
    if (typeof this._sdk.onStreamEnd === 'function') {
      this._sdk.onStreamEnd(callback);
    } else {
      this._logger.warn('aicq-sdk onStreamEnd not available (need >=1.0.0)');
    }
  }
}

/**
 * 检查 aicq-sdk 是否可加载。
 * @returns {boolean}
 */
function isSdkAvailable() {
  return sdkAvailable;
}

/**
 * 返回 aicq-sdk 版本字符串（不可用则返回 '0.0.0-unavailable'）。
 * @returns {string}
 */
function getSdkVersion() {
  return sdkVersion;
}

module.exports = {
  AICQAdapter,
  isSdkAvailable,
  getSdkVersion,
};

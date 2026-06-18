# openclaw-plugin → aicq-sdk (Node.js) 迁移指南

## 背景

openclaw-plugin 在 `lib/` 目录下自行实现了完整的 AICQ 通信栈
（~1,500 行），与官方 `aicq-sdk` npm 包（~2,000 行）严重重复。
本次已完成的修复：

- ✅ 移除死代码 `lib/file-transfer.js`（272 行无效代码）
- ✅ 移除 `lib/crypto.js` 中的死函数（encryptWithPassword /
  decryptWithPassword / convertEd25519ToX25519）
- ✅ 统一版本号到 3.7.0（之前有 6 个不同版本）
- ✅ 修复 `/api/identity/keys` 端点不再暴露私钥
- ✅ `package.json` 添加 `aicq-sdk` 依赖
- ✅ Homepage URL 从 `aicq.online` 修正为 `aicq.me`

## 后续迁移步骤

### Step 1 ⏳ 引入 aicq-sdk，创建适配层

创建 `lib/aicq-sdk-adapter.js`，将现有的 `lib/identity.js`、
`lib/server-client.js`、`lib/chat.js` 内部委托给 `aicq-sdk`：

```javascript
// lib/aicq-sdk-adapter.js
const { AICQClient, AICQAgentClient } = require('aicq-sdk');

class AICQAdapter {
  constructor(options) {
    this.sdk = new AICQClient({
      server: options.server || 'https://aicq.me',
      dbPath: options.dbPath,
    });
  }

  async init(identity) {
    // 从现有 identity 格式加载到 SDK
    await this.sdk.loadAgent(identity.agent_id);
    await this.sdk.login();
  }

  async sendMessage(friendId, content) {
    return this.sdk.sendMessage(friendId, content);
  }

  // ... 其他方法委托
}

module.exports = { AICQAdapter };
```

### Step 2 ⏳ 迁移 IdentityManager

将 `lib/identity.js`（165 行）的密钥管理委托给 SDK：

| 现有方法 | 替换为 SDK 方法 |
|----------|-----------------|
| `loadAgent()` | `sdk.loadAgent()` |
| `saveAgent()` | `sdk.createAgent()` + DB 持久化 |
| `generateKeypair()` | `sdk.crypto.generateSigningKeypair()` |
| `computeFingerprint()` | `sdk.crypto.computeFingerprint()` |

### Step 3 ⏳ 迁移 ServerClient

将 `lib/server-client.js`（381 行）的 REST + WS 调用委托给 SDK：

| 现有方法 | 替换为 SDK 方法 |
|----------|-----------------|
| `register()` | `sdk.createAgent()` |
| `login()` | `sdk.login()` |
| `connectWS()` | `sdk.connect()` |
| `sendMessage()` | `sdk.sendMessage()` |
| `sendGroupMessage()` | `sdk.sendGroupMessage()` |
| `listFriends()` | `sdk.listFriends()` |
| `addFriend()` | `sdk.addFriend()` |
| `uploadFile()` | `sdk.uploadFile()` |

### Step 4 ⏳ 迁移 ChatManager

将 `lib/chat.js`（855 行）的消息分发委托给 SDK 的回调系统：

```javascript
// 之前：自行管理 WS 消息分发
chatManager.onMessage = (msg) => { ... };

// 之后：使用 SDK 回调
sdk.onMessage((msg) => { ... });
sdk.onGroupMessage((msg) => { ... });
sdk.onStreamChunk((chunk) => { ... });
sdk.onStreamEnd((data) => { ... });  // SDK 0.9+ 新增
```

### Step 5 ⏳ 删除重复的 lib/ 模块

迁移完成并充分测试后，删除：
- `lib/identity.js`（165 行）
- `lib/server-client.js`（381 行）
- `lib/chat.js`（855 行）
- `lib/handshake.js`（如果 SDK 提供等价功能）
- `lib/database.js`（如果 SDK 的 DB 满足需求）

保留：
- `lib/crypto.js`（仅保留 SDK 不提供的辅助函数）
- `lib/package.json`（CommonJS 标记）

预计可删除 ~1,500 行重复代码。

## 验证清单

- [ ] `npm install` 成功，包含 aicq-sdk
- [ ] `npm test`（如有）通过
- [ ] 插件加载到 OpenClaw 后正常初始化
- [ ] 创建新 identity 正常
- [ ] 好友请求发送/接受/拒绝
- [ ] 私聊消息收发
- [ ] 群组消息收发
- [ ] 文件上传/发送
- [ ] 流式输出
- [ ] 断网重连

## E2EE 注意事项

当前 openclaw-plugin 的 E2EE 是部分实现（有 session key 时加密，
否则静默降级为明文）。迁移到 SDK 后：

- SDK 提供完整的 NaCl crypto 原语
- 但 SDK 的 `sendMessage()` 仍发送明文（与 hermes-plugin 一样）
- 完整 E2EE 需要在 SDK 层实现自动加密

建议：
1. 短期：移除文档中的 "End-to-end Encrypted" 声明，改为 "Encrypted Transport"
2. 长期：在 aicq-sdk 中实现自动 E2EE，所有项目共享

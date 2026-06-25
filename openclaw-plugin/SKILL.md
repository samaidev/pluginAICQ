---
name: aicq-chat
description: AICQ End-to-end Encrypted Chat Channel Plugin for OpenClaw — Official Channel Plugin SDK with friend management, group chat, file transfer, and AI agent communication
license: MIT
metadata:
  author: AICQ
  version: "3.7.0"
---

# AICQ Encrypted Chat

AICQ 是一个端到端加密聊天频道插件，基于 OpenClaw Channel Plugin SDK，直接在 OpenClaw 进程内运行。支持好友管理、群组聊天、文件传输和 AI Agent 通信。

## 架构变更 (v3.7)

从 plain-capability 自定义架构升级为官方 Channel Plugin SDK：

| 维度 | 旧版 (v3.7) | 新版 (v3.7) |
|------|-------------|-------------|
| 模块格式 | CommonJS | ESM |
| 入口方式 | register/activate/handleTool/handleGateway | defineChannelPluginEntry |
| 插件形状 | plain-capability | channel (SDK) |
| 频道注册 | 自定义 channel 对象 | createChatChannelPlugin + createChannelPluginBase |
| Setup 入口 | 无 | defineSetupPluginEntry |
| 频道检测 | installed, not configured | 正确配置和启用 |

## 功能特性

- **端到端加密 (E2EE)** — 基于 NaCl (libsodium) 的加密体系，消息仅通信双方可读
- **Channel SDK** — 使用官方 Channel Plugin SDK，正确注册频道
- **好友管理** — 好友码添加、QR 码扫描、好友列表同步
- **群组聊天** — 创建群组、邀请成员、静默模式
- **消息功能** — Markdown/LaTeX 渲染、图片/文件上传、@提及、流式消息
- **密钥管理** — 公钥/私钥显示、密钥轮换、指纹验证
- **DM 安全策略** — 仅好友列表中的联系人可发送 DM

## 一键启动

```bash
# 安装插件
openclaw plugins install aicq-openclaw

# 配置频道
openclaw channels add --channel aicq-chat

# 重启 gateway
openclaw gateway restart

# 插件会随 OpenClaw 自动启动，无需手动操作
```

## OpenClaw 集成

插件作为 Channel 类型运行，提供以下工具和网关：

### 工具
- `chat-friend` — 好友管理
- `chat-send` — 发送消息
- `chat-export-key` — 导出密钥

### 网关方法
- `aicq.status` — 插件状态
- `aicq.friends.list/add/remove` — 好友操作
- `aicq.chat.send/history/delete` — 聊天操作
- `aicq.groups.list/create/join` — 群组操作
- `aicq.identity.info` — 身份信息
- `aicq.chat.streamChunk/streamEnd` — 流式消息

### LLM 状态显示（thinking chunks）

当 Claude 执行长时间操作（LLM 调用、工具执行、多轮推理）时，应通过
`aicq.chat.streamChunk` 发送 `chunk_type="thinking"` 的状态片段，让用户
在 aicq.me 聊天页面的输入框上方看到实时状态指示器。

**使用方法**：

```
aicq.chat.streamChunk({
  friend_id: "<target>",
  chunk_type: "thinking",
  data: "Calling LLM..."
})
```

**推荐发送时机**：

1. **开始 LLM 调用前**：`"Calling LLM..."`
2. **多轮推理的第 N 轮**：`"Iteration N"`
3. **执行工具前**：`"Searching the web..."` / `"Running code..."`
4. **推理过程中**（如果有 reasoning content）：用 `chunk_type="reasoning"`
   发送推理内容，客户端会显示 "Reasoning..." 状态
5. **首条文本输出时**：客户端自动隐藏 thinking 状态

**注意**：thinking chunks 不会被持久化为消息内容，仅触发临时 UI 状态。
必须在 thinking chunks 之后发送 `text` chunks（实际回复内容）和
`aicq.chat.streamEnd`（结束流式输出）。

### UI 路由
- `/plugins/aicq-chat/ui/` — 聊天 SPA 界面
- `/plugins/aicq-chat/api/*` — REST API 端点

## 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AICQ_SERVER_URL` | https://aicq.me | AICQ 服务器地址 |
| `AICQ_DATA_DIR` | ~/.aicq-plugin | 数据存储目录 |

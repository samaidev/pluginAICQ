# AICQ Chat Plugin v3.7

AICQ 端到端加密聊天频道插件 — 基于 OpenClaw Channel Plugin SDK。

## 架构 (v3.7 Channel SDK)

v3.7 采用官方 OpenClaw Channel Plugin SDK，使用 `defineChannelPluginEntry` + `createChatChannelPlugin`：

- **ESM 模块** — 入口文件使用 ES Module 格式
- **官方 SDK** — 使用 `openclaw/plugin-sdk/channel-core` 的 `defineChannelPluginEntry` 和 `createChatChannelPlugin`
- **进程内通信** — 通过 Turn Kernel 推送消息，无 HTTP 轮询
- **Gateway HTTP 路由** — SPA 和 API 通过 Gateway 路由提供
- **setupEntry** — 轻量级 setup 入口，不加载运行时代码

## 一键安装

```bash
# 安装插件
openclaw plugins install npm:aicq-chat-plugin

# 配置频道
openclaw channels add --channel aicq-chat --name "AICQ Chat"

# 重启 gateway
openclaw gateway restart
```

插件会随 OpenClaw 自动启动，无需手动操作。

## 功能

- **端到端加密** — 基于 NaCl (X25519 + XSalsa20-Poly1305) 的加密体系
- **Channel 架构** — 进程内运行，复用 OpenClaw agent ID
- **好友管理** — 好友码添加、QR 码扫描、好友列表同步
- **群组聊天** — 创建群组、邀请成员、静默模式
- **消息功能** — Markdown/LaTeX 渲染、图片/文件上传、@提及、流式消息
- **密钥管理** — 公钥/私钥显示、密钥轮换、指纹验证
- **DM 安全策略** — 仅好友列表中的联系人可发送 DM

## 使用方法

### OpenClaw 集成

安装后插件自动注册为 Channel 类型，提供以下工具和网关：

#### 工具
- `chat-friend` — 好友管理 (list, add, remove, requests, accept, reject)
- `chat-send` — 发送消息
- `chat-export-key` — 导出密钥

#### 网关方法
- `aicq.status` — 插件状态
- `aicq.friends.list/add/remove` — 好友操作
- `aicq.chat.send/history/delete` — 聊天操作
- `aicq.groups.list/create/join` — 群组操作
- `aicq.identity.info` — 身份信息
- `aicq.chat.streamChunk/streamEnd` — 流式消息

#### UI 路由
- `/plugins/aicq-chat/ui/` — 聊天 SPA 界面
- `/plugins/aicq-chat/api/*` — REST API 端点

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AICQ_SERVER_URL` | https://aicq.me | AICQ 服务器地址 |
| `AICQ_DATA_DIR` | ~/.aicq-plugin | 数据存储目录 |

## 迁移指南 (v3.7 → v3.7)

1. 卸载旧版：`openclaw plugins uninstall aicq-chat`
2. 安装新版：`openclaw plugins install npm:aicq-chat-plugin`
3. 配置频道：`openclaw channels add --channel aicq-chat`
4. 重启 gateway：`openclaw gateway restart`
5. 旧版数据（密钥、好友、消息）会自动迁移

## 许可证

MIT License

# dsh-aicq — AICQ Encrypted Chat for DeepSeek Harness

把 AICQ 端到端加密聊天网络接入 **DeepSeek Harness（`dsh`）**。本插件以
Cordis 函数式插件形态加载（named export：`name` / `inject` / `Config` /
`apply`），通过 `dsh.bundle` 声明为可安装 npm bundle。

- 协议栈（SQLite 身份库 / NaCl X25519+XSalsa20-Poly1305 加密 / HTTP+WS 信令 /
  握手 / 聊天管理）直接复用自 `aicq-openclaw` 的 CJS `lib/`，跨宿主行为一致。
- 依赖仅 Cordis 官方包与 `ws`、`sql.js`、`tweetnacl(-util)`、`node-fetch`。

## 安装

```bash
# 通过 npm 包安装进 profile
dsh plugin --profile default add aicq-dsh

# 或本地目录安装
git clone https://github.com/samaidev/pluginAICQ.git
dsh plugin --profile default add ./pluginAICQ/deepseek-plugin

# 启动 / 重启后生效
dsh web --profile default
```

## 注册的工具

| 工具 | 说明 |
|------|------|
| `aicq_status` | 连接状态 + 本机 AICQ 身份信息 |
| `aicq_friends_list` | 好友列表（含在线状态） |
| `aicq_friend_add` | 按 AICQ 号发送好友申请 |
| `aicq_chat_send` | 发送私聊消息 |
| `aicq_chat_send_file` | 发送本地文件/图片 |
| `aicq_chat_history` | 读取本地加密会话历史 |

工具经 `ctx.tools.register(defineTool(...))` 注册：参数按 schema 校验，
Code Mode 可直接 `await tools.aicq_chat_send({...})` 调用。

## 入站消息 → Agent 驱动

插件监听信令 WebSocket；每条入站消息会：

1. 解密并落盘到本地 SQLite；
2. 通过 `agent.followup(createUserMessage(...))` 送入 agent inbox 并唤醒驱动，
   消息来源标注 `{ kind: 'plugin', plugin: 'aicq' }`；
3. Agent 回合结束回到 idle 时，抓取最新的 `assistant/message` 文本块，
   经 `_chat.sendMessage` 送回原好友。

目标 agent 选择：配置 `notifyAgentId` 指定 session id，否则取当前
第一个空闲 agent（`ctx.agents.list()`）。

## 配置（cordis.yml）

```yaml
- insert:
    - id: aicq
      name: dsh-aicq
      config:
        serverUrl: 'https://aicq.me'
        masterNumber: '1000000'        # 启动时自动添加的主人号码
        autoAcceptFriends: true
        dataDir: ''                    # 空 = ~/.dsh-aicq
```

编辑配置即热重载：注册是通过 effect 完成的，旧实例卸载时连接关闭、
工具注销，新实例随即接管。

## 版本

### 0.1.0

- 首个发布版本

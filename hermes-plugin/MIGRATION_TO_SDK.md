# hermes-plugin → aicqSDK (Python) 迁移指南

## 背景

hermes-plugin 在 `aicq_hermes/` 目录下自行实现了 AICQ 通信栈
（~700 行），与官方 `aicqSDK` PyPI 包严重重复。
本次已完成：

- ✅ 移除未使用的 `aiosqlite` 依赖
- ✅ Homepage URL 从 `aicq.online` 修正为 `aicq.me`
- ✅ 移除描述中的 "end-to-end" 声明（实际未实现 E2EE）
- ✅ `pyproject.toml` 添加 `aicqSDK>=0.9.0` 依赖
- ✅ 版本号升级到 1.1.0

## 后续迁移步骤

### Step 1 ⏳ 引入 aicqSDK，创建适配层

修改 `aicq_hermes/server_client.py`，让 `AicqServerClient` 内部
委托给 `aicq.AICQCore`：

```python
# aicq_hermes/server_client.py — 修改后
from aicq import AICQCore, AICQError, AuthError

class AicqServerClient:
    def __init__(self, server_url: str, identity_manager):
        self.server_url = server_url.rstrip("/")
        self.identity = identity_manager
        # 新增：底层使用 aicqSDK
        self._sdk = AICQCore(server=self.server_url)
        # 保留现有接口供 adapter.py 调用
        self.jwt_token = None
        self.connected = False

    async def register_and_login(self, agent_id: str) -> str:
        """注册并登录（委托给 SDK）。"""
        # 将 hermes identity 格式转换为 SDK agent 格式
        agent_data = self.identity.get_or_create(agent_id)
        # ... 转换密钥格式 ...
        self._sdk._agent = converted_agent
        await self._sdk.login()
        self.jwt_token = self._sdk.access_token
        return self.jwt_token

    async def send_message(self, friend_id: str, content: str) -> dict:
        """发送消息（委托给 SDK，自动获得 REST 降级）。"""
        await self._sdk.send_message(friend_id, content)
        return {"status": "sent"}

    async def connect_ws(self, on_message: Callable):
        """连接 WebSocket（委托给 SDK）。"""
        self._sdk.on_message(on_message)
        await self._sdk.connect()
        self.connected = True
```

### Step 2 ⏳ 迁移 identity.py

将 `aicq_hermes/identity.py`（131 行）的密钥管理委托给 SDK：

| 现有方法 | 替换为 SDK 方法 |
|----------|-----------------|
| `get_or_create()` | `sdk.create_my_agent()` |
| `get_signing_key()` | SDK 内部管理 |
| `get_exchange_keypair()` | `aicq.crypto.generate_exchange_keypair()` |
| `compute_fingerprint()` | `aicq.crypto.compute_fingerprint()` |

### Step 3 ⏳ 迁移 chat.py

将 `aicq_hermes/chat.py`（257 行）的消息分发委托给 SDK 回调系统：

```python
# 之前：自行管理 WS 消息 + 30 秒轮询
chat_manager.poll_loop()  # O(N) REST 调用

# 之后：使用 SDK 回调，无需轮询
sdk.on_message(lambda data: chat_manager.handle_message(data))
sdk.on_group_message(lambda data: chat_manager.handle_group_message(data))
sdk.on_stream_chunk(lambda data: chat_manager.handle_stream_chunk(data))
sdk.on_stream_end(lambda data: chat_manager.handle_stream_end(data))
```

**额外收益**：消除 30 秒轮询的 O(N) REST 调用，改用纯 WS 推送。

### Step 4 ⏳ 简化 register.py 的工具

`register.py` 中的 6 个 AICQ 工具可直接调用 SDK 方法：

| 现有工具 | 替换为 SDK 方法 |
|----------|-----------------|
| `aicq_status` | `sdk.get_status()` |
| `aicq_friends_list` | `sdk.list_friends()` |
| `aicq_friends_add` | `sdk.add_friend()` |
| `aicq_chat_send` | `sdk.send_message()` |
| `aicq_chat_history` | `sdk.get_conversation()` (0.9+ 新增) |
| `aicq_chat_send_file` | `sdk.send_file()` |

### Step 5 ⏳ 删除重复模块

迁移完成并充分测试后，删除：
- `aicq_hermes/identity.py`（131 行）
- `aicq_hermes/server_client.py`（319 行）
- `aicq_hermes/chat.py`（257 行）

保留：
- `aicq_hermes/adapter.py`（Hermes 平台适配，SDK 无等价物）
- `aicq_hermes/register.py`（Hermes 工具注册，SDK 无等价物）

预计可删除 ~700 行重复代码。

## 验证清单

- [ ] `pip install aicq-hermes-plugin` 成功
- [ ] 插件加载到 Hermes 后正常初始化
- [ ] 自动注册/登录 AICQ
- [ ] 主人绑定正常
- [ ] 6 个 AICQ 工具全部可用
- [ ] 消息收发正常
- [ ] 文件发送正常
- [ ] 自动接受好友请求正常

## E2EE 注意事项

`identity.py` 第 8-9 行明确注释：
> X25519 encryption keys are generated and stored but E2EE message
> encryption is NOT YET IMPLEMENTED. Messages are currently sent in
> plaintext over the server relay.

迁移到 SDK 后此状况不变（SDK 也不自动加密消息）。
建议：
1. 短期：在文档中诚实说明"传输加密，非端到端加密"
2. 长期：在 aicqSDK 中实现自动 E2EE，hermes-plugin 自动受益

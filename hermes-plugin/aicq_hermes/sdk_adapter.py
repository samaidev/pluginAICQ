"""
aicq_hermes/sdk_adapter.py — aicqSDK 适配层

本模块是 hermes-plugin 接入 aicqSDK (PyPI) 的过渡层。

长期目标：将 server_client.py / identity.py / chat.py 中重复实现的
AICQ 协议逻辑替换为对 aicq.AICQCore 的调用，逐步删除重复代码。

迁移进度（详见 MIGRATION_TO_SDK.md）：
  Step 1 ✅ 引入 aicqSDK，创建本适配层
  Step 2 ⏳ 计划中：迁移 identity.py
  Step 3 ⏳ 计划中：迁移 chat.py
  Step 4 ⏳ 计划中：简化 register.py 的工具
  Step 5 ⏳ 计划中：删除重复模块

当前阶段（Step 1）：
  - 提供 HermesSDKAdapter 类，封装 aicq.AICQCore
  - 暴露与 AicqServerClient 相似的方法签名，便于逐步替换
  - 不改变现有 AicqServerClient / IdentityManager / ChatManager 的行为
  - 由 register.py 在初始化时持有，但暂不强制使用

设计原则：
  - 适配层只做"格式转换 + 调用委托"，不重新实现协议
  - hermes 现有 identity 格式（agent_id + SigningKey）与 aicqSDK 的
    Agent 格式（account_id + 私钥 hex）通过本层转换
  - 后续 Step 2+ 会将 server_client.py 的方法逐个改为调用本适配层
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Dict, Optional

# aicqSDK 0.9+ 必须可通过 pip install aicqSDK>=0.9.0 获得
try:
    from aicq import AICQCore, AICQError, AuthError, AICQConnectionError
    from aicq import __version__ as _aicq_sdk_version
    _AICQ_SDK_AVAILABLE = True
except ImportError:
    AICQCore = None  # type: ignore
    AICQError = Exception  # type: ignore
    AuthError = Exception  # type: ignore
    AICQConnectionError = Exception  # type: ignore
    _aicq_sdk_version = "0.0.0-unavailable"
    _AICQ_SDK_AVAILABLE = False

logger = logging.getLogger("aicq-hermes.sdk_adapter")


class HermesSDKAdapter:
    """
    aicqSDK 适配器 — 把 hermes 的 identity 格式桥接到 aicqSDK 的 Agent 格式。

    生命周期：
      1. __init__: 创建 AICQCore 实例（不连接）
      2. import_identity: 从 hermes IdentityManager 注入 Ed25519 私钥 + token
      3. login: 调用 SDK 的 challenge-response login
      4. connect: 建立 WebSocket 连接，注册回调
      5. send_message / list_friends / ...: 委托给 SDK
      6. disconnect: 优雅断开（SDK 自动发送 offline 消息）
    """

    def __init__(self, server_url: str = "https://aicq.me", db_path: str = "~/.aicq-hermes/data.db"):
        if not _AICQ_SDK_AVAILABLE:
            raise RuntimeError(
                f"aicqSDK {_aicq_sdk_version} not available. "
                "Install with: pip install aicqSDK>=0.9.0"
            )
        self.server_url = server_url.rstrip("/")
        # aicqSDK 的 AICQCore 接受 db_path 与 server
        # hermes 给每个 agent 单独建一个 db，避免与其它插件冲突
        self._sdk = AICQCore(db_path=db_path, server=self.server_url)
        self._imported = False
        logger.info("HermesSDKAdapter initialized (aicqSDK %s, server=%s)",
                    _aicq_sdk_version, self.server_url)

    @property
    def sdk(self) -> AICQCore:
        """直接暴露底层 AICQCore，供高级用法使用。"""
        return self._sdk

    @property
    def is_imported(self) -> bool:
        return self._imported

    # ─── Identity 注入（Step 2 会用本方法替代 identity.py） ──────────

    def import_identity(
        self,
        agent_id: str,
        signing_key_hex: str,
        public_key_hex: str,
        access_token: Optional[str] = None,
        refresh_token: Optional[str] = None,
        account_id: Optional[str] = None,
    ) -> None:
        """
        将 hermes IdentityManager 管理的密钥注入 aicqSDK。

        hermes 的 SigningKey 是 nacl.signing.SigningKey 对象，可 encode 为 hex。
        本方法接受 hex 字符串，避免对 nacl 类型的硬依赖。

        注入后 self._sdk 内部即拥有可用的身份，可调用 login/connect/send_message。
        """
        # aicqSDK 的 AICQCore 内部维护 self._agent (dict)，需要这些字段
        # 这里直接设置私有字段 — Step 2 会用更规范的 SDK API 替代
        # SPEC 合规: aicqSDK AICQCore._agent 使用的字段名
        #   signing_pub / signing_sec / exchange_pub / exchange_sec / account_id
        # 旧版本误用 public_key / private_key, 导致 SDK 调用失败。
        self._sdk._agent = {
            "account_id": account_id or agent_id,
            "agent_id": agent_id,
            "name": agent_id,  # SDK 内部用 name 字段
            "signing_pub": public_key_hex,
            "signing_sec": signing_key_hex,
            # exchange keys 留空, 后续 SDK login 时如需要会重新生成
            "exchange_pub": "",
            "exchange_sec": "",
            "access_token": access_token or "",
            "refresh_token": refresh_token or "",
            "type": "my",  # SDK 区分 'my' (有私钥) vs 'friend' (仅公钥)
        }
        # 同步 token 到 SDK 顶层字段
        if access_token:
            self._sdk.access_token = access_token
        if refresh_token:
            self._sdk.refresh_token = refresh_token
        self._imported = True
        logger.debug("Identity imported for agent=%s (account=%s)",
                     agent_id, account_id or agent_id)

    # ─── 协议委托（后续 Step 3+ 会逐个迁移 server_client.py 的方法） ──

    async def login(self) -> str:
        """调用 SDK 的 challenge-response login，返回 access_token。"""
        if not self._imported:
            raise RuntimeError("Must call import_identity() before login()")
        # aicqSDK 0.9+: login() 内部会发 challenge + sign + 验证
        await self._sdk.login()
        return self._sdk.access_token

    async def connect(self) -> None:
        """建立 WebSocket 连接。回调通过 on_message/on_group_message 等注册。"""
        await self._sdk.connect()

    async def disconnect(self) -> None:
        """优雅断开 — SDK 自动发送 offline 消息。"""
        # aicqSDK 的 disconnect 方法
        if hasattr(self._sdk, "disconnect"):
            await self._sdk.disconnect()
        else:
            # 旧版 SDK 没有 disconnect，直接关闭 session
            await self._sdk.close()

    async def send_message(self, friend_id: str, content: str) -> Dict[str, Any]:
        """发送私聊消息（委托给 SDK，自动获得 REST 降级）。"""
        return await self._sdk.send_message(friend_id, content)

    async def send_group_message(self, group_id: str, content: str) -> Dict[str, Any]:
        """发送群组消息。"""
        return await self._sdk.send_group_message(group_id, content)

    async def list_friends(self) -> Any:
        """列出好友。"""
        return await self._sdk.list_friends()

    async def add_friend(self, public_key: str) -> Any:
        """发送好友请求。"""
        return await self._sdk.add_friend(public_key)

    async def send_file(self, friend_id: str, file_path: str) -> Dict[str, Any]:
        """发送文件 — 使用 SDK 的 loop_upload_file 或 send_file。"""
        # aicqSDK 0.9+ 提供 send_file 方法
        if hasattr(self._sdk, "send_file"):
            return await self._sdk.send_file(friend_id, file_path)
        raise NotImplementedError("aicqSDK send_file not available in this version")

    # ─── 回调注册（Step 3 会用本方法替代 chat.py 的轮询） ─────────────

    def on_message(self, callback: Callable[[Dict[str, Any]], None]) -> None:
        """注册私聊消息回调。"""
        self._sdk.on_message(callback)

    def on_group_message(self, callback: Callable[[Dict[str, Any]], None]) -> None:
        """注册群组消息回调。"""
        self._sdk.on_group_message(callback)

    def on_stream_chunk(self, callback: Callable[[Dict[str, Any]], None]) -> None:
        """注册流式输出 chunk 回调。"""
        self._sdk.on_stream_chunk(callback)

    def on_stream_end(self, callback: Callable[[Dict[str, Any]], None]) -> None:
        """注册流式输出结束回调（aicqSDK 0.9+ 新增）。"""
        if hasattr(self._sdk, "on_stream_end"):
            self._sdk.on_stream_end(callback)
        else:
            logger.warning("aicqSDK on_stream_end not available (need >=0.9.0)")


def is_sdk_available() -> bool:
    """检查 aicqSDK 是否可导入。供 register.py 决定是否启用适配层。"""
    return _AICQ_SDK_AVAILABLE


def get_sdk_version() -> str:
    """返回 aicqSDK 版本字符串（不可用则返回 '0.0.0-unavailable'）。"""
    return _aicq_sdk_version

"""
AICQ Platform Adapter for Hermes Agent.

Implements BasePlatformAdapter to connect Hermes to the AICQ
chat network. Supports:
- Auto registration & login (Ed25519 challenge-response)
- Master binding (auto-add specified AICQ user as friend)
- Text, file, and image messaging
- Tool calling via AICQ gateway methods
- Friend request auto-accept
- Unread message polling on reconnect

NOTE: E2EE encryption keys are generated but client-side message
encryption is NOT YET IMPLEMENTED. See identity.py for details.
"""

import asyncio
import logging
import os
from typing import Optional

from .identity import IdentityManager
from .server_client import AicqServerClient
from .chat import ChatManager

logger = logging.getLogger("aicq-hermes")


class AicqPlatformAdapter:
    """
    AICQ platform adapter for Hermes agent.

    Usage in Hermes plugin register():
        ctx.register_platform(
            name="aicq",
            label="AICQ Encrypted Chat",
            adapter_factory=lambda cfg: AicqPlatformAdapter(cfg),
            ...
        )
    """

    def __init__(self, config):
        # Hermes gateway passes a PlatformConfig object (not dict).
        # Normalize so .get() / env-var fallback work regardless of type.
        if isinstance(config, dict):
            self.config = config
        elif hasattr(config, 'env') and isinstance(config.env, dict):
            self.config = dict(config.env)
        elif hasattr(config, '__dict__'):
            self.config = {k: v for k, v in vars(config).items() if not k.startswith('_')}
        else:
            self.config = {}

        self.server_url = (
            self.config.get("AICQ_SERVER_URL")
            or os.environ.get("AICQ_SERVER_URL", "https://aicq.me")
        )
        self.master_number = (
            self.config.get("AICQ_MASTER_NUMBER")
            or os.environ.get("AICQ_MASTER_NUMBER", "")
        )
        self.data_dir = (
            self.config.get("AICQ_DATA_DIR")
            or os.environ.get("AICQ_DATA_DIR", os.path.expanduser("~/.aicq-hermes"))
        )
        self.auto_accept = (
            self.config.get("AICQ_AUTO_ACCEPT_FRIENDS")
            or os.environ.get("AICQ_AUTO_ACCEPT_FRIENDS", "true")
        ).lower() == "true"
        self.agent_id = self.config.get("agent_id", "default")

        os.makedirs(self.data_dir, exist_ok=True)

        # Core components
        self.identity = IdentityManager(os.path.join(self.data_dir, "identities"))
        self.server = AicqServerClient(self.server_url, self.identity)
        self.chat = ChatManager(self.server, self.data_dir)

        # State
        self._connected = False
        self._master_bound = False
        self._running = False
        self._message_handler = None  # Hermes handle_message callback
        self._fatal_error_handler = None  # Hermes fatal error callback
        self._session_store = None  # Hermes session store
        self._busy_session_handler = None  # Hermes busy session handler
        self._topic_recovery_fn = None  # Hermes topic recovery fn

    # ── Hermes Platform Adapter Interface ───────────────────────────────

    async def connect(self) -> bool:
        """Connect to AICQ server: authenticate, bind master, start WS."""
        try:
            logger.info(f"Connecting to AICQ server: {self.server_url}")

            # 1. Register or login
            self.identity.get_or_create(self.agent_id, "Hermes AICQ Agent")
            await self.server.ensure_auth(self.agent_id)
            self.server._current_agent_id = self.agent_id

            # 2. Bind master (add the owner as friend)
            if self.master_number and not self._master_bound:
                await self._bind_master()

            # 3. Auto-accept pending friend requests
            if self.auto_accept:
                await self._auto_accept_friends()

            # 4. Sync friends from server
            await self._sync_friends()

            # 5. Connect WebSocket
            self.chat.set_on_new_message(self._on_inbound_message)
            await self.server.connect_ws(self.agent_id)

            # 6. Start unread polling
            await self.chat.start_polling()

            # 7. Fetch initial unread
            await self._fetch_initial_unread()

            self._connected = True
            self._running = True
            logger.info("AICQ connected successfully")
            return True

        except Exception as e:
            logger.error(f"AICQ connection failed: {e}")
            return False

    async def disconnect(self) -> None:
        """Disconnect from AICQ server."""
        self._running = False
        await self.chat.stop_polling()
        await self.server.close()
        self._connected = False
        logger.info("AICQ disconnected")

    async def send(self, chat_id: str, content: str, reply_to=None, metadata=None):
        """Send a message to a chat (friend or group).

        This is the primary send method called by Hermes gateway.
        """
        if not self._connected:
            logger.warning("Not connected, cannot send message")
            return None

        is_group = metadata.get("is_group", False) if metadata else False
        msg_type = metadata.get("msg_type", "text") if metadata else "text"

        # Handle file/image sending
        file_path = metadata.get("file_path") if metadata else None
        if file_path and os.path.exists(file_path):
            success = await self.chat.send_file(chat_id, file_path)
            if success:
                return {"status": "sent", "type": "file"}

        # Text message
        success = await self.chat.send_message(
            target_id=chat_id,
            content=content,
            msg_type=msg_type,
            is_group=is_group,
        )

        if success:
            return {"status": "sent", "type": msg_type}
        return None

    async def send_typing(self, chat_id: str = None):
        """Send typing indicator (optional, not natively supported by AICQ)."""
        pass

    def get_chat_info(self) -> dict:
        """Return platform metadata for Hermes."""
        return {
            "platform": "aicq",
            "server_url": self.server_url,
            "connected": self._connected,
            "agent_id": self.agent_id,
            "master_bound": self._master_bound,
        }

    # ── Master Binding ──────────────────────────────────────────────────

    async def _bind_master(self):
        """Add the master/owner AICQ user as a friend automatically."""
        try:
            result = await self.server.add_friend_by_number(self.master_number)
            status = result.get("status", "")
            if status == "accepted" or result.get("to_id"):
                self._master_bound = True
                logger.info(f"Master bound: {self.master_number} (accepted)")
            else:
                logger.info(f"Master friend request sent: {self.master_number} (status: {status})")
                self._master_bound = True  # Request sent, will be accepted
        except Exception as e:
            logger.warning(f"Master bind failed: {e}")

    # ── Friend Management ───────────────────────────────────────────────

    async def _auto_accept_friends(self):
        """Auto-accept pending friend requests."""
        try:
            requests = await self.server.list_friend_requests()
            for req in requests:
                req_id = req.get("id") or req.get("request_id") or req.get("session_id")
                if req_id:
                    try:
                        await self.server.accept_friend_request(req_id)
                        logger.info(f"Auto-accepted friend request: {req_id}")
                    except Exception as e:
                        logger.warning(f"Auto-accept failed for {req_id}: {e}")
        except Exception as e:
            logger.warning(f"List friend requests failed: {e}")

    async def _sync_friends(self):
        """Sync friends from server into local state."""
        try:
            friends = await self.server.list_friends()
            logger.info(f"Synced {len(friends)} friends from server")
        except Exception as e:
            logger.warning(f"Friends sync failed: {e}")

    # ── Message Dispatch ────────────────────────────────────────────────

    async def _on_inbound_message(self, msg: dict):
        """Handle inbound AICQ message and forward to Hermes gateway."""
        from_id = msg.get("from_id")
        content = msg.get("content", "")
        is_group = msg.get("is_group", False)

        # Skip self messages
        if from_id == self.server.server_account_id:
            return

        # Skip empty
        if not content or not content.strip():
            return

        logger.info(f"Inbound message from {from_id}: {str(content)[:80]}")

        # Forward to Hermes via the registered message handler
        if self._message_handler:
            try:
                event = AicqMessageEvent(
                    chat_id=from_id if not is_group else msg.get("to_id"),
                    content=content,
                    sender_id=from_id,
                    is_group=is_group,
                    msg_type=msg.get("type", "text"),
                    raw=msg,
                )
                await self._message_handler(event)
            except Exception as e:
                logger.error(f"Message handler error: {e}")

    def set_message_handler(self, handler):
        """Set the Hermes message handler (called by gateway to receive messages)."""
        self._message_handler = handler

    def set_fatal_error_handler(self, handler):
        """Set the Hermes fatal error handler (required by gateway)."""
        self._fatal_error_handler = handler

    def set_session_store(self, store):
        """Set the Hermes session store (required by gateway).
        
        The session store allows the adapter to persist and restore
        conversation state across gateway restarts.
        """
        self._session_store = store

    def set_busy_session_handler(self, handler):
        """Set handler for when a session is busy (required by gateway).
        
        Called when a message arrives for a chat that already has
        an active agent session running.
        """
        self._busy_session_handler = handler

    def set_topic_recovery_fn(self, fn):
        """Set topic recovery function (required by gateway).
        
        Used by platforms like Telegram that support topics/threads.
        AICQ does not use topics, so this is a no-op.
        """
        self._topic_recovery_fn = fn

    @property
    def is_connected(self):
        """Whether the adapter is currently connected (required by gateway)."""
        return self._connected

    @property
    def platform(self):
        """Platform identifier (required by gateway for logging/state)."""
        from enum import Enum
        if not hasattr(self, '_platform_enum'):
            class PlatformEnum(Enum):
                aicq = "aicq"
            self._platform_enum = PlatformEnum.aicq
        return self._platform_enum

    # Fatal error properties (required by gateway for error handling)
    fatal_error_code = None
    fatal_error_message = None
    fatal_error_retryable = False

    async def _fetch_initial_unread(self):
        """Fetch unread messages from all friends on startup."""
        try:
            friends = await self.server.list_friends()
            for f in friends:
                fid = f.get("id") or f.get("friend_id")
                if fid:
                    await self.chat._fetch_unread(fid)
            logger.info(f"Fetched initial unread from {len(friends)} friends")
        except Exception as e:
            logger.warning(f"Initial unread fetch failed: {e}")

    # ── Tool Calling Support ────────────────────────────────────────────

    async def aicq_status(self) -> dict:
        """Get AICQ plugin status."""
        return {
            "connected": self._connected,
            "server_url": self.server_url,
            "agent_id": self.agent_id,
            "server_account_id": self.server.server_account_id,
            "master_bound": self._master_bound,
        }

    async def aicq_friends_list(self) -> list:
        """List all friends."""
        return await self.server.list_friends()

    async def aicq_friends_add(self, aicq_number: str) -> dict:
        """Add a friend by AICQ number."""
        return await self.server.add_friend_by_number(aicq_number)

    async def aicq_chat_send(self, target_id: str, content: str, msg_type: str = "text") -> dict:
        """Send a chat message to a specific user."""
        success = await self.chat.send_message(target_id, content, msg_type)
        return {"success": success}

    async def aicq_chat_history(self, friend_id: str, limit: int = 50) -> dict:
        """Get chat history with a friend."""
        return await self.server.get_conversation(friend_id, limit)

    async def aicq_chat_send_file(self, target_id: str, file_path: str) -> dict:
        """Send a file to a friend."""
        success = await self.chat.send_file(target_id, file_path)
        return {"success": success}

    async def aicq_accept_friend_request(self, request_id: str) -> dict:
        """Accept a friend request."""
        return await self.server.accept_friend_request(request_id)


class AicqMessageEvent:
    """Normalized message event for Hermes gateway."""

    def __init__(self, chat_id: str, content: str, sender_id: str,
                 is_group: bool = False, msg_type: str = "text", raw: dict = None):
        self.chat_id = chat_id
        self.content = content
        self.sender_id = sender_id
        self.is_group = is_group
        self.msg_type = msg_type
        self.raw = raw or {}

    @property
    def text(self) -> str:
        return self.content

    def to_dict(self) -> dict:
        return {
            "chat_id": self.chat_id,
            "content": self.content,
            "sender_id": self.sender_id,
            "is_group": self.is_group,
            "msg_type": self.msg_type,
        }

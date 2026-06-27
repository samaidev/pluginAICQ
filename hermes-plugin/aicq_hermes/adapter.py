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

Inbound AICQ messages are normalized into ``MessageEvent`` instances
(with a ``SessionSource`` built via ``self.build_source(...)``) and
dispatched through ``self.handle_message(...)`` — the same path used
by built-in platforms like ntfy/Telegram/Discord.

NOTE: E2EE encryption keys are generated but client-side message
encryption is NOT YET IMPLEMENTED. See identity.py for details.
"""

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)

from .identity import IdentityManager
from .server_client import AicqServerClient
from .chat import ChatManager

logger = logging.getLogger("aicq-hermes")

# ─── Module-level running-adapter registry ──────────────────────────────────
# Tool handlers (register.py:_get_adapter) need to access the running
# AicqPlatformAdapter instance to delegate tool calls (aicq_status,
# aicq_friends_list, etc.). Hermes-Agent's tool dispatch calls handlers
# as ``handler(args_dict, **kwargs)`` — there is no PluginContext passed
# at dispatch time, so handlers cannot reach the adapter via
# ``ctx.gateway.platforms`` (the original design assumption was wrong).
#
# Instead, the adapter registers itself here on successful connect() and
# unregisters on disconnect(). Tool handlers read from this module-level
# singleton. This is safe because:
#   - There is only one AICQ adapter per gateway process (the platform
#     registry enforces single-instance semantics).
#   - connect()/disconnect() are called by the gateway's main event loop,
#     so there's no concurrent registration race.
_running_adapter: "AicqPlatformAdapter | None" = None

# ─── Gateway main event loop reference ──────────────────────────────────────
# Hermes-Agent's tool dispatch bridges async handlers via _run_async(),
# which — inside the gateway's async context — spins up a WORKER THREAD
# to run the handler. aiohttp.ClientSession is bound to the loop that
# created it (the gateway main loop), so calling session.request() from
# the worker thread triggers:
#   RuntimeError: Timeout context manager should be used inside a task
#
# To work around this, we capture the gateway main loop at connect()
# time and expose a ``run_in_main_loop(coro)`` helper that tool handlers
# can call from any thread. It uses asyncio.run_coroutine_threadsafe()
# to submit the coroutine to the main loop and block on the result.
_main_loop: "asyncio.AbstractEventLoop | None" = None


def set_running_adapter(adapter: "AicqPlatformAdapter | None") -> None:
    """Register/unregister the running adapter instance.

    Called by AicqPlatformAdapter.connect() / disconnect().
    Also captures the gateway main event loop for cross-thread async
    execution (see ``run_in_main_loop``).
    """
    global _running_adapter, _main_loop
    _running_adapter = adapter
    if adapter is not None:
        try:
            _main_loop = asyncio.get_running_loop()
        except RuntimeError:
            _main_loop = None
    else:
        _main_loop = None


def get_running_adapter() -> "AicqPlatformAdapter | None":
    """Return the currently running adapter, or None."""
    return _running_adapter


def run_in_main_loop(coro) -> Any:
    """Run a coroutine on the gateway main event loop from any thread.

    Hermes-Agent's tool dispatch runs async handlers in a worker thread
    (via ``_run_async``). aiohttp sessions are bound to the main loop
    and fail with ``RuntimeError: Timeout context manager should be
    used inside a task`` when used from a different thread/loop.

    This helper uses ``asyncio.run_coroutine_threadsafe()`` to submit
    the coroutine to the gateway main loop (captured at connect() time)
    and blocks on the result. If called from the main loop itself
    (e.g. in CLI mode), it runs the coroutine directly via
    ``asyncio.ensure_future``.

    Raises ``RuntimeError`` if no main loop is available (e.g. adapter
    not connected yet).
    """
    import asyncio
    if _main_loop is None:
        raise RuntimeError("No gateway main loop available — adapter not connected")
    try:
        loop = asyncio.get_running_loop()
        # We're inside a loop — but is it the main loop?
        if loop is _main_loop:
            # Same loop: just await directly via a future
            import concurrent.futures
            fut = concurrent.futures.Future()
            task = asyncio.ensure_future(coro)
            task.add_done_callback(lambda t: fut.set_result(t.result()) if not t.exception() else fut.set_exception(t.exception()))
            return fut.result(timeout=60)
    except RuntimeError:
        # No running loop in this thread — we're in a worker thread
        pass
    # Submit to main loop from a different thread
    future = asyncio.run_coroutine_threadsafe(coro, _main_loop)
    return future.result(timeout=60)


def _env_dict(config) -> dict:
    """Best-effort extraction of env-style settings from a config object.

    Hermes' ``PlatformConfig`` doesn't carry an ``env`` dict — env vars
    are loaded into ``os.environ`` by the gateway before the adapter is
    constructed — but we still check for ``env``/``__dict__`` for tests
    and standalone use.
    """
    if isinstance(config, dict):
        return dict(config)
    env = getattr(config, "env", None)
    if isinstance(env, dict):
        return dict(env)
    if hasattr(config, "__dict__"):
        return {k: v for k, v in vars(config).items() if not k.startswith("_")}
    return {}


class AicqPlatformAdapter(BasePlatformAdapter):
    """
    AICQ platform adapter for Hermes agent.

    Inherits from BasePlatformAdapter so the Hermes gateway can drive
    connection lifecycle, message dispatch, and session bookkeeping
    through the standard adapter contract.
    """

    def __init__(self, config):
        # Accept either a real PlatformConfig (the normal gateway path)
        # or a dict / namespace (used by tests and standalone scripts).
        if not isinstance(config, PlatformConfig):
            extra = getattr(config, "extra", None) or {}
            config = PlatformConfig(enabled=True, extra=extra)
        env = _env_dict(config)
        super().__init__(config=config, platform=Platform("aicq"))

        # Env vars are loaded into os.environ by the gateway before the
        # adapter is constructed. We also accept them via the config
        # object's ``env`` dict (test/standalone path) for flexibility.
        self.server_url = (
            env.get("AICQ_SERVER_URL")
            or os.environ.get("AICQ_SERVER_URL", "https://aicq.me")
        )
        self.master_number = (
            env.get("AICQ_MASTER_NUMBER")
            or os.environ.get("AICQ_MASTER_NUMBER", "")
        )
        self.data_dir = (
            env.get("AICQ_DATA_DIR")
            or os.environ.get("AICQ_DATA_DIR", os.path.expanduser("~/.aicq-hermes"))
        )
        self.auto_accept = (
            env.get("AICQ_AUTO_ACCEPT_FRIENDS")
            or os.environ.get("AICQ_AUTO_ACCEPT_FRIENDS", "true")
        ).lower() == "true"
        self.agent_id = env.get("agent_id", "default")

        os.makedirs(self.data_dir, exist_ok=True)

        # Core components
        self.identity = IdentityManager(os.path.join(self.data_dir, "identities"))
        self.server = AicqServerClient(self.server_url, self.identity)
        self.chat = ChatManager(self.server, self.data_dir)

        # State
        self._master_bound = False

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

            self._mark_connected()
            set_running_adapter(self)
            logger.info("AICQ connected successfully")
            return True

        except Exception as e:
            logger.error(f"AICQ connection failed: {e}")
            return False

    async def disconnect(self) -> None:
        """Disconnect from AICQ server."""
        set_running_adapter(None)
        await self.chat.stop_polling()
        await self.server.close()
        logger.info("AICQ disconnected")

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        """Send a message to a chat (friend or group).

        Returns a ``SendResult`` so the Hermes gateway can retry on
        transient failures.
        """
        if not self.is_connected:
            logger.warning("Not connected, cannot send message")
            return SendResult(success=False, error="not connected", retryable=True)

        metadata = metadata or {}
        is_group = metadata.get("is_group", False)
        msg_type = metadata.get("msg_type", "text")

        # Handle file/image sending
        file_path = metadata.get("file_path")
        if file_path and os.path.exists(file_path):
            success = await self.chat.send_file(chat_id, file_path)
            return SendResult(success=success, error=None if success else "file send failed")

        # Text message
        success = await self.chat.send_message(
            target_id=chat_id,
            content=content,
            msg_type=msg_type,
            is_group=is_group,
        )
        if success:
            return SendResult(success=True)
        return SendResult(success=False, error="send failed", retryable=True)

    async def send_typing(self, chat_id: str = None, metadata=None):
        """Send typing indicator (optional, not natively supported by AICQ)."""
        pass

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        """Return platform metadata for the given chat (required by gateway)."""
        return {
            "name": chat_id,
            "type": "dm",
            "platform": "aicq",
            "server_url": self.server_url,
            "connected": self.is_connected,
            "agent_id": self.agent_id,
            "master_bound": self._master_bound,
        }

    # ── Master Binding ──────────────────────────────────────────────────

    async def _bind_master(self):
        """Add the master/owner AICQ user as a friend automatically."""
        try:
            result = await self.server.add_friend_by_number(self.master_number)
            if result is None:
                # Already friends or already pending — treat as bound.
                self._master_bound = True
                logger.info(f"Master bind: {self.master_number} (no-op / already bound)")
                return
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
            requests = requests or []
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
            # Defensive: server may return null for empty friend list (Go
            # nil-slice → JSON null). list_friends() already normalizes to
            # [] but we double-guard here.
            friends = friends or []
            logger.info(f"Synced {len(friends)} friends from server")
        except Exception as e:
            logger.warning(f"Friends sync failed: {e}")

    # ── Message Dispatch ────────────────────────────────────────────────

    async def _on_inbound_message(self, msg: dict):
        """Handle inbound AICQ message and forward to Hermes gateway.

        Builds a proper ``MessageEvent`` with a ``SessionSource`` and
        hands it to ``self.handle_message(...)``, which is the gateway's
        standard inbound entry point (handles slash commands, busy
        sessions, post-delivery callbacks, etc.).
        """
        from_id = msg.get("from_id")
        content = msg.get("content", "")
        is_group = msg.get("is_group", False)
        msg_type = msg.get("type", "text")

        # Skip self messages
        if from_id == self.server.server_account_id:
            return

        # Skip empty
        if not content or not str(content).strip():
            return

        logger.info(f"Inbound message from {from_id}: {str(content)[:80]}")

        chat_id = str(msg.get("to_id") if is_group else from_id)
        source = self.build_source(
            chat_id=chat_id,
            chat_name=str(from_id),
            chat_type="group" if is_group else "dm",
            user_id=str(from_id) if from_id else None,
            user_name=str(from_id) if from_id else None,
            message_id=str(msg.get("id")) if msg.get("id") else None,
        )

        # Map AICQ message types to MessageType enum.
        type_map = {
            "text": MessageType.TEXT,
            "image": MessageType.PHOTO,
            "photo": MessageType.PHOTO,
            "video": MessageType.VIDEO,
            "audio": MessageType.AUDIO,
            "voice": MessageType.VOICE,
            "file": MessageType.DOCUMENT,
            "document": MessageType.DOCUMENT,
            "sticker": MessageType.STICKER,
        }
        hermes_msg_type = type_map.get(msg_type, MessageType.TEXT)

        try:
            ts = msg.get("timestamp")
            if isinstance(ts, (int, float)):
                timestamp = datetime.fromtimestamp(float(ts), tz=timezone.utc)
            else:
                timestamp = datetime.now(tz=timezone.utc)
        except (ValueError, OSError, TypeError):
            timestamp = datetime.now(tz=timezone.utc)

        event = MessageEvent(
            text=str(content),
            message_type=hermes_msg_type,
            source=source,
            message_id=str(msg.get("id")) if msg.get("id") else None,
            raw_message=msg,
            timestamp=timestamp,
        )

        try:
            await self.handle_message(event)
        except Exception as e:
            logger.error(f"Message handler error: {e}", exc_info=True)

    # ── Initial unread fetch ────────────────────────────────────────────

    async def _fetch_initial_unread(self):
        """Fetch unread messages from all friends on startup."""
        try:
            friends = await self.server.list_friends()
            friends = friends or []
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
            "connected": self.is_connected,
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

    async def aicq_chat_stream_chunk(self, target_id: str, chunk_type: str = "text",
                                     data=None) -> dict:
        """Send a streaming chunk to a friend.

        Use chunk_type="thinking" to show an LLM status indicator in the
        recipient's chat UI (e.g. "Calling LLM...", "Iteration 2").
        Use chunk_type="text" for the actual response text.
        Must be followed by aicq_chat_stream_end() to finalize the message.
        """
        success = await self.chat.send_stream_chunk(target_id, chunk_type, data)
        return {"success": success}

    async def aicq_chat_stream_end(self, target_id: str, message_id: str = "") -> dict:
        """Signal the end of a streaming message."""
        success = await self.chat.send_stream_end(target_id, message_id)
        return {"success": success}

    async def aicq_accept_friend_request(self, request_id: str) -> dict:
        """Accept a friend request."""
        return await self.server.accept_friend_request(request_id)

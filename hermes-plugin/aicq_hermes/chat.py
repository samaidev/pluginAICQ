"""
AICQ Chat Manager — handles message send/receive, friend sync, and unread polling.

Receives inbound messages from the WebSocket and dispatches them to the
Hermes adapter. Manages outbound message sending via WS relay + REST fallback.
"""

import asyncio
import logging
import os
import time
from typing import Optional, Callable

logger = logging.getLogger("aicq-hermes")


class ChatManager:
    """Manages AICQ chat: send/receive messages, file handling, unread polling."""

    def __init__(self, server_client, data_dir: str):
        self.server = server_client
        self.data_dir = data_dir
        self.userfiles_dir = os.path.join(data_dir, "userfiles")
        os.makedirs(self.userfiles_dir, exist_ok=True)

        self._on_new_message: Optional[Callable] = None
        self._processed_ids: set[str] = set()
        self._poll_interval: Optional[asyncio.Task] = None

        # Register WS handlers
        self.server.on_message("relay", self._handle_incoming)
        self.server.on_message("message", self._handle_server_message)
        self.server.on_message("group_message", self._handle_group_incoming)
        self.server.on_message("handshake_initiate", self._handle_handshake)
        self.server.on_message("presence", self._handle_presence)
        self.server.on_message("unread_counts", self._handle_unread_counts)
        self.server.on_message("_reconnected", self._on_reconnect)

    def set_on_new_message(self, callback: Callable):
        """Set the callback for incoming messages."""
        self._on_new_message = callback

    # ── Inbound Message Handlers ────────────────────────────────────────

    async def _handle_incoming(self, data: dict):
        """Handle relay messages (live DM from a friend)."""
        from_id = data.get("fromId") or data.get("from_id") or data.get("from")
        payload = data.get("payload", data)
        content = payload.get("content", payload.get("text", ""))
        msg_type = payload.get("type", "text")

        if not from_id or not content:
            return

        msg = {
            "from_id": from_id,
            "to_id": self.server.server_account_id,
            "content": str(content),
            "type": msg_type,
            "is_group": False,
            "timestamp": data.get("timestamp", time.time()),
        }

        if self._on_new_message:
            await self._on_new_message(msg) if asyncio.iscoroutinefunction(self._on_new_message) else self._on_new_message(msg)

    async def _handle_server_message(self, data: dict):
        """Handle server-pushed messages (offline messages, live messages via 'message' type)."""
        from_id = data.get("from") or (data.get("data", {}) or {}).get("fromId")
        if not from_id:
            return

        msg_data = data.get("data", data)
        content = msg_data.get("content", msg_data.get("text", ""))
        msg_type = msg_data.get("type", "text")
        msg_id = msg_data.get("id")

        # Dedup
        if msg_id and msg_id in self._processed_ids:
            return
        if msg_id:
            self._processed_ids.add(msg_id)
            if len(self._processed_ids) > 10000:
                self._processed_ids = set(list(self._processed_ids)[-5000:])

        if not content:
            return

        msg = {
            "from_id": from_id,
            "to_id": self.server.server_account_id,
            "content": str(content),
            "type": msg_type,
            "is_group": False,
            "timestamp": msg_data.get("timestamp", time.time()),
        }

        if self._on_new_message:
            await self._on_new_message(msg) if asyncio.iscoroutinefunction(self._on_new_message) else self._on_new_message(msg)

    async def _handle_group_incoming(self, data: dict):
        """Handle group messages."""
        from_id = data.get("fromId") or data.get("from_id") or data.get("from")
        group_id = data.get("groupId") or data.get("group_id")
        content = data.get("content", data.get("text", ""))

        if not content:
            return

        msg = {
            "from_id": from_id,
            "to_id": group_id,
            "content": str(content),
            "type": "text",
            "is_group": True,
            "timestamp": data.get("timestamp", time.time()),
        }

        if self._on_new_message:
            await self._on_new_message(msg) if asyncio.iscoroutinefunction(self._on_new_message) else self._on_new_message(msg)

    async def _handle_handshake(self, data: dict):
        """Handle incoming friend handshake / friend request."""
        logger.info(f"Friend request/handshake from {data.get('fromId', 'unknown')}")
        # Auto-accept is handled in the adapter

    async def _handle_presence(self, data: dict):
        """Handle presence updates (friend online/offline)."""
        pass

    async def _handle_unread_counts(self, data: dict):
        """Handle unread count notifications — fetch actual messages."""
        unread = data.get("unread", {})
        for friend_id, count in unread.items():
            if count > 0:
                logger.info(f"Unread: {count} from {friend_id}")
                await self._fetch_unread(friend_id)

    async def _on_reconnect(self, data: dict):
        """On WS reconnect, fetch unread messages from all friends."""
        logger.info("WS reconnected — fetching unread messages")
        try:
            friends = await self.server.list_friends()
            # Defensive: list_friends() already coerces null → [], but
            # double-guard in case the SDK ever returns None.
            friends = friends or []
            for f in friends:
                fid = f.get("id") or f.get("friend_id")
                if fid:
                    await self._fetch_unread(fid)
        except Exception as e:
            logger.warning(f"Reconnect fetch failed: {e}")

    async def _fetch_unread(self, friend_id: str):
        """Fetch unread messages from a friend via REST API."""
        try:
            result = await self.server.get_conversation(friend_id, limit=20)
            # Defensive: server may return {"messages": null} when the
            # conversation is empty (Go nil slice → JSON null).
            messages = result.get("messages")
            if not isinstance(messages, list):
                messages = []
            for msg in messages:
                msg_from = msg.get("from_id") or msg.get("fromId")
                if msg_from == self.server.server_account_id:
                    continue
                msg_id = msg.get("id")
                if msg_id and msg_id in self._processed_ids:
                    continue
                if msg_id:
                    self._processed_ids.add(msg_id)

                content = msg.get("content", msg.get("text", ""))
                if not content:
                    continue

                full_msg = {
                    "from_id": msg_from or friend_id,
                    "to_id": self.server.server_account_id,
                    "content": str(content),
                    "type": msg.get("type", "text"),
                    "is_group": False,
                    "timestamp": msg.get("timestamp", time.time()),
                }

                if self._on_new_message:
                    await self._on_new_message(full_msg) if asyncio.iscoroutinefunction(self._on_new_message) else self._on_new_message(full_msg)

            await self.server.mark_read(friend_id)
        except Exception as e:
            logger.warning(f"Fetch unread from {friend_id} failed: {e}")

    # ── Outbound Messages ───────────────────────────────────────────────

    async def send_message(self, target_id: str, content: str, msg_type: str = "text",
                           is_group: bool = False, **kwargs) -> bool:
        """Send a message to a friend or group.

        Strategy: WS-first (``type: "message"`` for DM, ``type: "group_message"``
        for group), REST fallback only on WS failure.

        NOTE: The server's ``handleMessage`` WS handler reads the recipient from
        the ``to`` field (NOT ``targetId``) and persists the message to the
        ``direct_messages`` table. The older ``handleRelay`` handler only
        forwards in-memory and does NOT persist — so we use ``type: "message"``
        for DMs to make sure replies are stored server-side and visible in
        conversation history / aicq.me admin backend.
        """
        payload = {"type": msg_type, "content": content, **kwargs}

        # Primary: WS — use "message" for DM (server persists + relays),
        # "group_message" for group (server relays to all members).
        ws_msg = {
            "type": "group_message" if is_group else "message",
            "to": target_id,
            "data": payload,
        }
        sent = await self.server.send_ws(ws_msg)

        if sent:
            logger.info(f"Message sent via WS to {target_id}: {str(content)[:60]}...")
            return True

        # Fallback: REST API (only when WS send failed and not a group message)
        if not is_group:
            try:
                await self.server.send_chat_message(target_id, content, msg_type)
                logger.info(f"Message sent via REST fallback to {target_id}: {str(content)[:60]}...")
                return True
            except Exception as e:
                logger.error(f"Message delivery failed (WS down, REST error) to {target_id}: {e}")
                return False

        logger.error(f"Message delivery failed to {target_id}: WS unavailable, group REST not supported")
        return False

    async def send_file(self, target_id: str, file_path: str) -> bool:
        """Send a file to a friend via the REST upload API."""
        try:
            result = await self.server.upload_file(target_id, file_path)
            logger.info(f"File sent to {target_id}: {file_path}")
            return True
        except Exception as e:
            logger.error(f"File send failed: {e}")
            return False

    # ── Periodic Unread Poll ────────────────────────────────────────────

    async def start_polling(self):
        """Start periodic unread message polling (every 30s as safety net)."""
        async def poll_loop():
            while True:
                await asyncio.sleep(30)
                if not self.server.connected:
                    continue
                try:
                    friends = await self.server.list_friends()
                    friends = friends or []
                    for f in friends:
                        fid = f.get("id") or f.get("friend_id")
                        if fid:
                            await self._fetch_unread(fid)
                except Exception:
                    pass

        self._poll_interval = asyncio.create_task(poll_loop())

    async def stop_polling(self):
        if self._poll_interval:
            self._poll_interval.cancel()
            try:
                await self._poll_interval
            except asyncio.CancelledError:
                pass

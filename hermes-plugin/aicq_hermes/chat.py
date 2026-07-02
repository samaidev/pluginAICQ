"""
AICQ Chat Manager �?handles message send/receive, friend sync, and unread polling.

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
        """Handle group messages.

        Aligns with the unified AICQ integration standard (see
        https://aicq.me/static/integration-guide.html#admin-group-reply):
        - Field extraction: top-level camelCase → data wrapper snake_case →
          data wrapper camelCase (3-level fallback, mirrors zagent e8755e9)
        - Dedup via msg_id (primary) + (group_id, from_id, content, 10s ts
          window) fingerprint fallback (mirrors teambot cf67622)
        - Skip self messages (anti echo loop)
        - Skip system messages (join/leave notifications)
        - Pass through sender_name + msgType for downstream context
        """
        # 3-level fallback field extraction
        from_id = (data.get("from")
                   or data.get("fromId")
                   or (data.get("data", {}) or {}).get("from")
                   or (data.get("data", {}) or {}).get("from_id")
                   or (data.get("data", {}) or {}).get("fromId"))
        group_id = (data.get("groupId")
                    or data.get("group_id")
                    or (data.get("data", {}) or {}).get("group_id")
                    or (data.get("data", {}) or {}).get("groupId"))
        data_wrapper = data.get("data", {}) or {}
        content = (data.get("content")
                   or data_wrapper.get("content")
                   or data.get("text")
                   or "")
        msg_type = (data.get("msgType")
                    or data.get("msg_type")
                    or data_wrapper.get("msg_type")
                    or data_wrapper.get("msgType")
                    or "text")
        sender_name = (data_wrapper.get("sender_name")
                       or data_wrapper.get("senderName")
                       or data.get("senderName")
                       or "")
        group_name = (data_wrapper.get("group_name")
                      or data_wrapper.get("groupName")
                      or data.get("groupName")
                      or "")

        # Skip system messages (join/leave notifications)
        if msg_type == "system":
            logger.debug(f"Skipping system message in group {group_id}")
            return

        # Skip self messages (anti echo loop)
        if from_id and from_id == self.server.server_account_id:
            return

        if not content:
            return

        # Dedup: msg_id primary + (group_id, from_id, content, 10s ts window)
        # fingerprint fallback. Mirrors teambot cf67622 fix for the
        # "Leo multi-reply flood" caused by WS reconnect / server re-push.
        msg_id = (data_wrapper.get("id")
                  or data_wrapper.get("messageId")
                  or data.get("id")
                  or data.get("messageId"))
        if msg_id:
            if msg_id in self._processed_ids:
                logger.debug(f"Skipping duplicate group message: msg_id={msg_id}")
                return
            self._processed_ids.add(msg_id)
            if len(self._processed_ids) > 10000:
                self._processed_ids = set(list(self._processed_ids)[-5000:])
        else:
            # Fallback fingerprint dedup (10s window)
            ts = data.get("timestamp") or data_wrapper.get("timestamp") or 0
            if isinstance(ts, (int, float)) and ts > 0 and content:
                ts_window = int(ts) // 10000
                fingerprint = f"grp_{group_id}_{from_id}_{str(content)[:200]}_{ts_window}"
                if fingerprint in self._processed_ids:
                    logger.debug(f"Skipping duplicate group message (fingerprint): from={from_id} group={group_id}")
                    return
                self._processed_ids.add(fingerprint)
                if len(self._processed_ids) > 10000:
                    self._processed_ids = set(list(self._processed_ids)[-5000:])

        msg = {
            "from_id": from_id,
            "to_id": group_id,
            "content": str(content),
            "type": msg_type,
            "is_group": True,
            "sender_name": sender_name,
            "group_name": group_name,
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
        """Handle unread count notifications �?fetch actual messages."""
        unread = data.get("unread", {})
        for friend_id, count in unread.items():
            if count > 0:
                logger.info(f"Unread: {count} from {friend_id}")
                await self._fetch_unread(friend_id)

    async def _on_reconnect(self, data: dict):
        """On WS reconnect, fetch unread messages from all friends."""
        logger.info("WS reconnected �?fetching unread messages")
        try:
            friends = await self.server.list_friends()
            # Defensive: list_friends() already coerces null �?[], but
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
            # conversation is empty (Go nil slice �?JSON null).
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
        forwards in-memory and does NOT persist �?so we use ``type: "message"``
        for DMs to make sure replies are stored server-side and visible in
        conversation history / aicq.me admin backend.
        """
        payload = {"type": msg_type, "content": content, **kwargs}

        # Primary: WS �?use "message" for DM (server persists + relays),
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

    # ── Streaming (LLM status + text chunks) ───────────────────────────

    async def send_stream_chunk(self, target_id: str, chunk_type: str = "text",
                                data=None, message_id: str = "") -> bool:
        """Send a stream chunk to a friend via WebSocket.

        Used for real-time streaming output when the agent is generating a
        response. The aicq.me frontend renders different chunk types differently:

        - ``text``: visible text content (accumulated into the message bubble)
        - ``reasoning``: reasoning/thinking process (shown in a collapsible panel)
        - ``thinking``: transient status hint (shown in the LLM status bar above
          the input box, e.g. "Calling LLM...", "Iteration 2"). NOT persisted.
        - ``reasoning_end``: marks the end of a reasoning section
        - ``clear_text``: clears the current text buffer (between multi-round
          tool calls)
        - ``tool_call``: tool invocation, data = ``{"name": ..., "input": ...}``
        - ``tool_result``: tool result, data = ``{"output": ..., "success": ...}``

        Typical flow for an LLM response with status::

            await chat.send_stream_chunk(target, "thinking", "Calling LLM...")
            # ... LLM generates text ...
            await chat.send_stream_chunk(target, "text", "Hello!")
            await chat.send_stream_chunk(target, "text", " How can I help?")
            await chat.send_stream_end(target)

        For multi-round agent loops, send a ``thinking`` chunk before each
        round to keep the user informed::

            await chat.send_stream_chunk(target, "thinking", "Iteration 2")
            # ... round 2 LLM call + tool calls ...
            await chat.send_stream_chunk(target, "text", "Based on the results...")
            await chat.send_stream_end(target)

        Args:
            target_id: friend account ID
            chunk_type: chunk type (see list above)
            data: chunk payload (string for text/reasoning; object for
                tool_call/tool_result)
            message_id: optional msg_id for dedup/association. When provided,
                all chunks in the same streaming round share this msg_id so
                the frontend can match stream_end with the chunks and avoid
                duplicate display after persistence. Recommended: generate
                once per round (e.g. ``msg_{ts}_{rand}``) and pass to both
                send_stream_chunk and send_stream_end.
        """
        if data is None:
            data = ""
        ws_msg = {
            "type": "stream_chunk",
            "to": target_id,
            "chunkType": chunk_type,
            "data": data,
        }
        if message_id:
            ws_msg["msg_id"] = message_id
        sent = await self.server.send_ws(ws_msg)
        if not sent:
            logger.warning(f"Stream chunk send failed (WS down) to {target_id}: type={chunk_type}")
        return sent

    async def send_stream_end(self, target_id: str, message_id: str = "") -> bool:
        """Signal the end of a stream.

        Must be called after a sequence of ``send_stream_chunk`` calls. The
        aicq.me frontend uses this to finalize the streaming message into a
        permanent message and persist it to the database.

        Args:
            target_id: friend account ID
            message_id: optional message ID for dedup/association. Should
                match the msg_id passed to send_stream_chunk for the same
                round so the frontend can dedup.
        """
        msg_id = message_id or f"msg_{int(time.time()*1000)}_{os.urandom(3).hex()}"
        ws_msg = {
            "type": "stream_end",
            "to": target_id,
            "msg_id": msg_id,
        }
        sent = await self.server.send_ws(ws_msg)
        if not sent:
            logger.warning(f"Stream end send failed to {target_id}")
        return sent

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


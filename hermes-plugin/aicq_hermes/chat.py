"""
AICQ Chat Manager �?handles message send/receive, friend sync, and unread polling.

Receives inbound messages from the WebSocket and dispatches them to the
Hermes adapter. Manages outbound message sending via WS relay + REST fallback.
"""

import asyncio
import base64
import json
import logging
import os
import re
import time
import uuid
from typing import Optional, Callable

logger = logging.getLogger("aicq-hermes")

# Message types that carry a file/image payload (inbound).
_FILE_MSG_TYPES = {"file", "image", "photo", "document", "video", "audio", "voice"}
# Image extensions used to classify a file message as image vs generic file.
_IMAGE_EXTS = re.compile(r"\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$", re.I)
# Common mime → extension fallbacks when the server sends no filename.
_MIME_EXT = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
    "image/webp": ".webp", "image/svg+xml": ".svg",
    "text/plain": ".txt", "application/pdf": ".pdf",
    "application/zip": ".zip", "application/gzip": ".gz",
    "application/json": ".json", "video/mp4": ".mp4",
    "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/webm": ".webm",
}
# Magic-byte sniffing for extension-less downloads.
_MAGIC = [
    (b"\x89PNG\r\n\x1a\n", ".png"), (b"\xff\xd8\xff", ".jpg"),
    (b"GIF8", ".gif"), (b"PK\x03\x04", ".zip"),
    (b"%PDF", ".pdf"), (b"\x1f\x8b", ".gz"), (b"RIFF", ".webp"),
    (b"ID3", ".mp3"), (b"OggS", ".ogg"), (b"\x00\x00\x00 ftyp", ".mp4"),
]


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

        # [v1.4 edge-fix #3] Known group ids. The Hermes gateway's reply path
        # calls adapter.send(chat_id, ...) with thread metadata that never
        # carries ``is_group`` — the adapter must therefore remember which
        # chat ids are groups itself (persisted across restarts). Ids with a
        # ``grp_`` prefix are also recognized heuristically.
        self._group_ids: set[str] = set()
        self._groups_file = os.path.join(self.data_dir, "groups.json")
        self._load_groups()

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

    # ── Group registry ──────────────────────────────────────────────────

    def _load_groups(self):
        """Load known group ids from data_dir/groups.json."""
        try:
            with open(self._groups_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                self._group_ids = {str(g) for g in data}
        except FileNotFoundError:
            pass
        except Exception as e:
            logger.warning(f"Failed to load groups.json: {e}")

    def remember_group(self, group_id) -> None:
        """Record a group id (persisted) so outbound replies route as group."""
        gid = str(group_id or "")
        if not gid or gid in self._group_ids:
            return
        self._group_ids.add(gid)
        try:
            with open(self._groups_file, "w", encoding="utf-8") as f:
                json.dump(sorted(self._group_ids), f)
        except Exception as e:
            logger.warning(f"Failed to persist groups.json: {e}")

    def is_group_chat(self, target_id) -> bool:
        """True when target_id is a known group (or carries a grp_ prefix)."""
        t = str(target_id or "")
        return t in self._group_ids or t.startswith("grp_")

    # ── Inbound file handling ───────────────────────────────────────────
    # [v1.4 edge-fix #2] Inbound files/images used to be dropped silently —
    # only text content was extracted. This mirrors the openclaw/dsh
    # behavior: detect file payloads, download/decode into userfiles/, and
    # rewrite the message content into a synthetic instruction that tells
    # the agent where the file lives locally.

    @staticmethod
    def _merge_frames(*frames) -> dict:
        """Merge WS frames (outer frame + inner payload) for field lookups.

        Later frames win; None / non-dict frames are ignored.
        """
        merged: dict = {}
        for fr in frames:
            if isinstance(fr, dict):
                merged.update(fr)
        return merged

    @staticmethod
    def _extract_parsed_content(*frames) -> Optional[dict]:
        """If a frame's content is a JSON blob (file-info style), parse it."""
        for fr in frames:
            if not isinstance(fr, dict):
                continue
            c = fr.get("content") or fr.get("text")
            if isinstance(c, str) and c.lstrip().startswith("{"):
                try:
                    obj = json.loads(c)
                    if isinstance(obj, dict):
                        return obj
                except Exception:
                    pass
        return None

    def _extract_file_name(self, view: dict, parsed: Optional[dict]) -> str:
        """Best-effort filename extraction across every known field name,
        including file_info JSON strings (the server persists them as TEXT)."""
        candidates = []
        for src in (view, parsed or {}):
            for key in ("file_name", "fileName", "media_filename", "mediaFilename",
                        "filename", "name", "original_name", "originalName"):
                v = src.get(key)
                if isinstance(v, str) and v.strip():
                    candidates.append(v.strip())
        for src in (view, parsed or {}):
            fi = src.get("file_info") or src.get("fileInfo")
            if not fi:
                continue
            try:
                obj = json.loads(fi) if isinstance(fi, str) else fi
                if isinstance(obj, dict):
                    for key in ("filename", "file_name", "fileName",
                                "original_name", "originalName", "name"):
                        v = obj.get(key)
                        if isinstance(v, str) and v.strip():
                            candidates.append(v.strip())
            except Exception:
                if isinstance(fi, str) and fi.strip():
                    candidates.append(fi.strip())
        return candidates[0] if candidates else ""

    @staticmethod
    def _infer_ext_from_bytes(buf: bytes) -> str:
        for magic, ext in _MAGIC:
            if buf[:len(magic)] == magic:
                return ext
        return ""

    @staticmethod
    def _ext_is_known(name: str) -> bool:
        return bool(re.search(r"\.[A-Za-z0-9]{1,8}$", name or ""))

    async def _detect_and_save_file(self, msg_type: str, content, *frames):
        """Detect a file/image payload and persist it under userfiles/.

        Returns ``(local_path, original_name, kind)`` — kind is 'image' or
        'file' — or None when the message carries no file payload. Handles
        the three wire formats seen in the wild:

        1. inline base64 (media_data / mediaData / file_data / fileData)
        2. URL reference (media_url / mediaUrl / file_url / fileUrl,
           including the one-time ``GET /api/v1/chat/files/:id`` download)
        3. text markers (``[文件] name`` / ``[图片] name``)
        """
        try:
            view = self._merge_frames(*frames)
            inner = view.get("data") if isinstance(view.get("data"), dict) else {}
            if inner:
                view = self._merge_frames(view, inner)
            parsed = self._extract_parsed_content(view)

            # ── classification ──────────────────────────────────────────
            t = str(msg_type or view.get("msgType") or view.get("msg_type")
                    or view.get("type") or "").lower()
            has_payload_field = bool(
                view.get("media_data") or view.get("mediaData")
                or view.get("file_data") or view.get("fileData")
                or view.get("media_url") or view.get("mediaUrl")
                or view.get("file_url") or view.get("fileUrl")
                or (parsed and (parsed.get("media_data") or parsed.get("media_url")
                                or parsed.get("file_url") or parsed.get("data"))))
            is_file = t in _FILE_MSG_TYPES or has_payload_field
            if not is_file:
                return None

            original_name = self._extract_file_name(view, parsed)
            kind = "image" if (
                t in {"image", "photo"}
                or _IMAGE_EXTS.search(original_name)
                or (isinstance(content, str) and content.startswith("[图片]"))
            ) else "file"
            ts = int(time.time() * 1000)
            uid = uuid.uuid4().hex[:8]

            # ── case 1: inline base64 ────────────────────────────────────
            b64 = (view.get("media_data") or view.get("mediaData")
                   or view.get("file_data") or view.get("fileData"))
            if not b64 and parsed:
                b64 = parsed.get("media_data") or parsed.get("file_data") or parsed.get("data")
            if isinstance(b64, str) and b64.strip():
                b64 = re.sub(r"^data:[^;]+;base64,", "", b64.strip())
                buf = base64.b64decode(b64, validate=False)
                ext = (os.path.splitext(original_name)[1]
                       if self._ext_is_known(original_name) else "")
                if not ext:
                    ext = self._infer_ext_from_bytes(buf) or ".bin"
                safe = f"{ts}_{uid}{ext}"
                local = os.path.join(self.userfiles_dir, safe)
                with open(local, "wb") as f:
                    f.write(buf)
                logger.info(f"Saved inbound base64 file -> {local} "
                            f"({len(buf)} bytes, name={original_name or safe})")
                return local, original_name or f"file{ext}", kind

            # ── case 2: URL reference (incl. one-time /chat/files/:id) ──
            url = (view.get("media_url") or view.get("mediaUrl")
                   or view.get("file_url") or view.get("fileUrl"))
            if not url and parsed:
                url = parsed.get("media_url") or parsed.get("file_url") or parsed.get("fileUrl")
            if isinstance(url, str) and url.strip():
                url = url.strip()
                try:
                    buf, disp_name = await self.server.download_file(url)
                except Exception as e:
                    # Verified server behavior: GET /api/v1/chat/files/:id
                    # is currently authorized for the uploader (and human
                    # recipients) but returns 404 for agent accounts.
                    # Surface the failure to the agent instead of silence.
                    logger.warning(f"media_url download failed ({e}); "
                                   f"falling back to URL reference")
                    return "FAILED", url, kind, str(e)
                chosen = (disp_name or original_name or "").strip() or "file.bin"
                ext = (os.path.splitext(chosen)[1]
                       if self._ext_is_known(chosen) else "")
                if not ext:
                    ext = self._infer_ext_from_bytes(buf or b"")
                if not ext:
                    ext = ".bin"
                safe = f"{ts}_{uid}{ext}"
                local = os.path.join(self.userfiles_dir, safe)
                with open(local, "wb") as f:
                    f.write(buf or b"")
                if chosen == "file.bin":
                    chosen = f"file{ext}"
                logger.info(f"Downloaded inbound file {url} -> {local} "
                            f"({len(buf or b'')} bytes, name={chosen})")
                return local, chosen, kind

            # ── case 3: text marker without payload ─────────────────────
            if isinstance(content, str) and (
                    content.startswith("[文件]") or content.startswith("[图片]")):
                name = re.sub(r"^\[(文件|图片)\]\s*", "", content).strip() or "unknown"
                ext = (os.path.splitext(name)[1]
                       if self._ext_is_known(name)
                       else (".png" if kind == "image" else ".bin"))
                safe = f"{ts}_{uid}{ext}"
                local = os.path.join(self.userfiles_dir, safe)
                with open(local, "wb") as f:
                    f.write(b"")
                logger.warning(f"File marker without payload; placeholder: {local}")
                return local, name, kind

            logger.warning(
                f"File message (type={t}) carried no downloadable payload "
                f"(file/media fields present: "
                f"{sorted(k for k in view if 'file' in k.lower() or 'media' in k.lower())})")
            return None
        except Exception as e:
            logger.error(f"Inbound file handling failed: {e}", exc_info=True)
            return None

    async def _apply_file_payload(self, msg: dict, content, *frames) -> dict:
        """Post-process an assembled inbound msg dict: when it carries a file
        payload, download it and rewrite content into a synthetic agent
        instruction with the local path (mirrors openclaw/dsh behavior)."""
        result = await self._detect_and_save_file(msg.get("type", "text"), content, *frames)
        if not result:
            return msg
        if result[0] == "FAILED":
            _, url, kind, err = result
            msg["type"] = kind
            label = "图片" if kind == "image" else "文件"
            name = msg.get("file_name") or url.rsplit("/", 1)[-1]
            msg["content"] = (
                f"[用户发送了{label}] {name}\n"
                f"(文件下载失败: {err} — 服务端暂不允许 agent 账户拉取该 media_url)\n"
                f"media_url: {url}\n"
                f"请告知用户暂时无法读取该{label}内容，建议对方改用内联方式发送。"
            )
            return msg
        local_path, original_name, kind = result
        msg["type"] = kind
        msg["file_path"] = local_path
        msg["file_name"] = original_name
        label = "图片" if kind == "image" else "文件"
        msg["content"] = (
            f"[用户发送了{label}] {original_name}\n"
            f"本地路径: {local_path}\n"
            f"请处理该{label}。"
        )
        return msg

    # ── Inbound Message Handlers ────────────────────────────────────────

    async def _handle_incoming(self, data: dict):
        """Handle relay messages (live DM from a friend)."""
        from_id = data.get("fromId") or data.get("from_id") or data.get("from")
        payload = data.get("payload", data)
        content = payload.get("content", payload.get("text", ""))
        msg_type = payload.get("type", "text")

        if not from_id:
            return

        msg = {
            "from_id": from_id,
            "to_id": self.server.server_account_id,
            "content": str(content or ""),
            "type": msg_type,
            "is_group": False,
            "timestamp": data.get("timestamp", time.time()),
        }

        # [v1.4 edge-fix #2] File/image messages may carry empty text — run
        # file detection BEFORE the empty-content gate and let it rewrite
        # content into a synthetic instruction when a payload is present.
        msg = await self._apply_file_payload(msg, content, payload, data)

        if (not msg["content"] or not str(msg["content"]).strip()) and not msg.get("file_path"):
            return

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

        msg = {
            "from_id": from_id,
            "to_id": self.server.server_account_id,
            "content": str(content or ""),
            "type": msg_type,
            "is_group": False,
            "timestamp": msg_data.get("timestamp", time.time()),
        }

        # [v1.4 edge-fix #2] file/image payloads (may carry empty text)
        msg = await self._apply_file_payload(msg, content, msg_data, data)

        if (not msg["content"] or not str(msg["content"]).strip()) and not msg.get("file_path"):
            return

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

        # [v1.4 edge-fix #3] remember this group so replies route as group
        if group_id:
            self.remember_group(group_id)

        # Dedup: msg_id primary + (group_id, from_id, content, 10s ts window)
        # fingerprint fallback. Mirrors teambot cf67622 fix for the
        # "Leo multi-reply flood" caused by WS reconnect / server re-push.
        # NOTE: runs BEFORE file download so a re-pushed file frame never
        # re-downloads (the one-time /chat/files/:id URL would 410 anyway).
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
            "content": str(content or ""),
            "type": msg_type,
            "is_group": True,
            "sender_name": sender_name,
            "group_name": group_name,
            "timestamp": data.get("timestamp", time.time()),
        }

        # [v1.4 edge-fix #2] group file/image payloads (may carry empty text)
        msg = await self._apply_file_payload(msg, content, data_wrapper, data)

        if (not msg["content"] or not str(msg["content"]).strip()) and not msg.get("file_path"):
            return

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

                full_msg = {
                    "from_id": msg_from or friend_id,
                    "to_id": self.server.server_account_id,
                    "content": str(content or ""),
                    "type": msg.get("type", "text"),
                    "is_group": False,
                    "timestamp": msg.get("timestamp", time.time()),
                }

                # [v1.4 edge-fix #2] offline/pulled messages may carry files
                full_msg = await self._apply_file_payload(full_msg, content, msg)

                if (not full_msg["content"] or not str(full_msg["content"]).strip()) and not full_msg.get("file_path"):
                    continue

                if self._on_new_message:
                    await self._on_new_message(full_msg) if asyncio.iscoroutinefunction(self._on_new_message) else self._on_new_message(full_msg)

            await self.server.mark_read(friend_id)
        except Exception as e:
            logger.warning(f"Fetch unread from {friend_id} failed: {e}")

    # ── Outbound Messages ───────────────────────────────────────────────

    async def send_message(self, target_id: str, content: str, msg_type: str = "text",
                           is_group: bool = False, **kwargs) -> bool:
        """Send a message to a friend or group.

        Strategy:
        - DM: WS-first (``type: "message"`` - the server persists + relays),
          REST fallback only when the WS is down.
        - Group: REST ``POST /groups/:id/messages`` - the authoritative,
          persisted delivery path. The WS ``group_message`` frame is
          fire-and-forget relay only and is used purely as a last-resort
          fallback.

        [v1.4 edge-fix #3] Group detection no longer depends on the caller
        passing ``is_group``. The Hermes gateway's reply path invokes
        ``send(chat_id, ...)`` with thread metadata that never carries the
        flag, which previously routed every group reply into a broken DM
        send (server replied DB_ERROR "Failed to save message"). We now
        also consult the persisted group registry via ``is_group_chat``.

        NOTE: The server's ``handleMessage`` WS handler reads the recipient
        from the ``to`` field (NOT ``targetId``) and persists the message to
        the ``direct_messages`` table. The older ``handleRelay`` handler
        only forwards in-memory and does NOT persist, so DMs use
        ``type: "message"`` to guarantee history/admin visibility.
        """
        # [v1.4 edge-fix #3] registry-based detection wins over the caller's
        # guess (metadata.get("is_group") is never set on gateway replies).
        is_group = bool(is_group) or self.is_group_chat(target_id)

        if is_group:
            # [v1.4 edge-fix #3b] Verified against the live server: the WS
            # ``group_message`` frame (top-level groupId/content/msgType) is
            # the ONLY group delivery path — REST POST /groups/:id/messages
            # returns Gin "404 page not found" for every account, so the
            # earlier REST-first design just burned a round trip. WS is
            # live fan-out; offline members depend on server-side queuing.
            ws_msg = {
                "type": "group_message",
                "groupId": target_id,
                "content": content,
                "msgType": msg_type,
            }
            if kwargs.get("mentions"):
                ws_msg["mentions"] = kwargs["mentions"]
            sent = await self.server.send_ws(ws_msg)
            if sent:
                logger.info(f"Group message sent via WS to {target_id}: {str(content)[:60]}...")
                return True
            # WS down — try the REST route anyway in case the server adds it.
            try:
                await self.server.send_group_message_rest(target_id, content, msg_type)
                logger.info(f"Group message sent via REST fallback to {target_id}")
                return True
            except Exception as e:
                logger.error(f"Group message delivery failed (WS down, REST unavailable) to {target_id}: {e}")
                return False

        payload = {"type": msg_type, "content": content, **kwargs}

        # Primary: WS (server persists + relays)
        ws_msg = {
            "type": "message",
            "to": target_id,
            "data": payload,
        }
        sent = await self.server.send_ws(ws_msg)

        if sent:
            logger.info(f"Message sent via WS to {target_id}: {str(content)[:60]}...")
            return True

        # Fallback: REST API (only when the WS is down)
        try:
            await self.server.send_chat_message(target_id, content, msg_type)
            logger.info(f"Message sent via REST fallback to {target_id}: {str(content)[:60]}...")
            return True
        except Exception as e:
            logger.error(f"Message delivery failed (WS down, REST error) to {target_id}: {e}")
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


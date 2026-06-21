"""
AICQ Server Client — REST API + WebSocket client for AICQ server.

Handles authentication (challenge-response with Ed25519), friend management,
chat messaging, and real-time WebSocket communication.
"""

import asyncio
import json
import logging
from typing import Optional, Callable

import aiohttp
from nacl.encoding import HexEncoder
from nacl.signing import SigningKey

logger = logging.getLogger("aicq-hermes")


def _safe_json(data) -> dict:
    """Normalize a parsed JSON value into a dict.

    The AICQ server (Go + Gin) serializes nil slices as JSON ``null``,
    so ``{"friends": null}`` is a valid response when the user has no
    friends. Without this guard, ``data.get(...)`` would raise
    ``AttributeError: 'NoneType' object has no attribute 'get'``.
    """
    if isinstance(data, dict):
        return data
    return {}


class AicqServerClient:
    """REST + WebSocket client for the AICQ server."""

    def __init__(self, server_url: str, identity_manager):
        self.server_url = server_url.rstrip("/")
        self.identity = identity_manager
        self.api_base = f"{self.server_url}/api/v1"
        self.ws_url = f"{self.server_url.replace('https://', 'wss://').replace('http://', 'ws://')}/ws"

        self.session: Optional[aiohttp.ClientSession] = None
        self.ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self.jwt_token: Optional[str] = None
        self.server_account_id: Optional[str] = None
        self.connected = False

        self._ws_handlers: dict[str, list[Callable]] = {}
        self._reconnect_task: Optional[asyncio.Task] = None
        self._running = False

    async def _get_session(self) -> aiohttp.ClientSession:
        if self.session is None or self.session.closed:
            self.session = aiohttp.ClientSession()
        return self.session

    # ── Auth ────────────────────────────────────────────────────────────

    async def register_agent(self, agent_id: str, agent_name: str = "Hermes AICQ Agent") -> dict:
        """Register a new AI agent on the AICQ server."""
        agent = self.identity.get_or_create(agent_id, agent_name)
        signing_key = self.identity.get_signing_key(agent_id)
        public_key = signing_key.verify_key.encode(encoder=HexEncoder).decode()

        session = await self._get_session()
        async with session.post(f"{self.api_base}/auth/register/ai", json={
            "public_key": public_key,
            "agent_name": agent_name,
        }) as resp:
            data = await resp.json()
            if resp.status != 200 and resp.status != 201:
                raise RuntimeError(f"Registration failed: {data}")
            logger.info(f"Agent registered: {agent_id}")
            return data

    async def login_agent(self, agent_id: str) -> dict:
        """Login with Ed25519 challenge-response authentication."""
        agent = self.identity.load_agent(agent_id)
        if not agent:
            raise RuntimeError(f"No identity for agent {agent_id}")

        signing_key = self.identity.get_signing_key(agent_id)
        public_key = signing_key.verify_key.encode(encoder=HexEncoder).decode()

        session = await self._get_session()

        # Step 1: Request challenge
        async with session.post(f"{self.api_base}/auth/challenge", json={
            "public_key": public_key,
        }) as resp:
            data = await resp.json()
            if resp.status != 200:
                raise RuntimeError(f"Challenge failed: {data}")
            challenge = data.get("challenge", "")
            if not challenge:
                raise RuntimeError(f"Empty challenge: {data}")

        # Step 2: Sign challenge
        signature = signing_key.sign(bytes.fromhex(challenge)).signature
        signature_hex = signature.hex() if isinstance(signature, bytes) else signature

        # Step 3: Login with signature
        async with session.post(f"{self.api_base}/auth/login/agent", json={
            "public_key": public_key,
            "signature": signature_hex,
            "challenge": challenge,
        }) as resp:
            data = await resp.json()
            if resp.status != 200:
                raise RuntimeError(f"Login failed: {data}")

        self.jwt_token = data.get("access_token") or data.get("token")
        # Account ID can be at top level (account_id / server_account_id) or
        # nested inside an ``account`` dict (the format the current
        # loginAgentHandler actually returns: ``{"access_token": ...,
        # "account": {"id": "ai_xxx", ...}}``). Older plugin versions only
        # looked at the top level, leaving server_account_id=None — which
        # then broke self-message detection, WS nodeId, and any logic that
        # needs to know "who am I on the server".
        if not self.server_account_id:
            account = data.get("account") or {}
            if isinstance(account, dict):
                self.server_account_id = account.get("id") or account.get("account_id")
        logger.info(f"Agent logged in: {agent_id}, account={self.server_account_id}")
        return data

    async def ensure_auth(self, agent_id: str) -> None:
        """Ensure we have a valid JWT token, registering if needed."""
        if self.jwt_token:
            return
        try:
            await self.login_agent(agent_id)
        except Exception:
            logger.info("Login failed, trying registration...")
            await self.register_agent(agent_id)
            await self.login_agent(agent_id)

    def _auth_headers(self) -> dict:
        if not self.jwt_token:
            return {}
        return {"Authorization": f"Bearer {self.jwt_token}"}

    async def _request_with_refresh(self, method: str, url: str, **kwargs) -> dict:
        """Make an authenticated request, auto-refreshing JWT on 401. Returns parsed JSON.

        Always returns a dict; if the server returns a non-JSON body or a
        JSON ``null``, an empty dict is returned so callers can safely use
        ``data.get(...)`` without NoneType crashes.
        """
        session = await self._get_session()
        headers = kwargs.pop("headers", {})
        headers.update(self._auth_headers())

        async with session.request(method, url, headers=headers, **kwargs) as resp:
            if resp.status == 401 and self.jwt_token:
                logger.info("JWT expired (401), refreshing token...")
                try:
                    await self.login_agent(self._current_agent_id)
                except Exception as e:
                    logger.error(f"JWT refresh failed: {e}")
                    return _safe_json(await resp.json())  # Return whatever the 401 response contains

                # Retry with new token
                headers.update(self._auth_headers())
                async with session.request(method, url, headers=headers, **kwargs) as retry_resp:
                    return _safe_json(await retry_resp.json())
            return _safe_json(await resp.json())

    # ── Friends ─────────────────────────────────────────────────────────

    async def list_friends(self) -> list:
        data = await self._request_with_refresh("GET", f"{self.api_base}/friends")
        # Server returns {"friends": null} when the user has no friends
        # (Go nil slice → JSON null). Coerce to [] so callers can iterate
        # and len() without NoneType crashes.
        friends = data.get("friends")
        return friends if isinstance(friends, list) else []

    async def send_friend_request(self, to_id: str) -> dict:
        return await self._request_with_refresh(
            "POST", f"{self.api_base}/friends/request", json={"to_id": to_id},
        )

    async def list_friend_requests(self) -> list:
        """List friend requests received by this account (i.e. the ones we can accept).

        The AICQ server returns ``{"received": [...], "sent": [...]}`` —
        older plugin versions looked for ``requests`` / ``pending`` keys
        that don't exist on the wire, so auto-accept silently no-op'd.
        We now read ``received`` (the inbound requests) and fall back to
        the legacy keys for forward-compat with future server versions.
        """
        data = await self._request_with_refresh("GET", f"{self.api_base}/friends/requests")
        # Prefer "received" (current server schema). Fall back to legacy
        # keys for compatibility with hypothetical older servers.
        reqs = data.get("received")
        if not isinstance(reqs, list):
            reqs = data.get("requests")
        if not isinstance(reqs, list):
            reqs = data.get("pending")
        return reqs if isinstance(reqs, list) else []

    async def accept_friend_request(self, request_id: str) -> dict:
        return await self._request_with_refresh(
            "POST", f"{self.api_base}/friends/requests/{request_id}/accept",
        )

    async def add_friend_by_number(self, aicq_number: str) -> Optional[dict]:
        """Add a friend by their AICQ number (e.g. '1000000').

        Returns the friend-request response dict on success, or None if
        the number could not be resolved or the request was already
        pending (so callers can treat None as "already bound").
        """
        # First resolve the number to an account ID. The lookup endpoint
        # returns {"accounts": [...], "account_id": "<uuid>"} when there
        # is exactly one match, or {"accounts": null} when no match.
        data = await self._request_with_refresh(
            "GET", f"{self.api_base}/accounts/lookup?number={aicq_number}",
        )
        account_id = data.get("account_id") or data.get("id")
        if not account_id:
            # Try the accounts array as a fallback.
            accounts = data.get("accounts") or []
            if accounts and isinstance(accounts, list):
                first = accounts[0]
                if isinstance(first, dict):
                    account_id = first.get("id") or first.get("account_id")
        if not account_id:
            # The previous fallback sent the raw human_number (e.g.
            # "1000008") as ``to_id`` to /friends/request, which the
            # server rejects with USER_NOT_FOUND. Fail loudly here so
            # the master-bind path can log a clear error instead of
            # silently retrying every reconnect.
            logger.warning(
                f"Could not resolve AICQ number {aicq_number} to an account_id "
                f"(lookup response: {data!r}). Friend request not sent."
            )
            return None
        try:
            return await self.send_friend_request(account_id)
        except Exception as e:
            # ALREADY_FRIENDS / ALREADY_SENT come back as HTTP errors —
            # treat them as "already bound" so we don't spam the log.
            msg = str(e)
            if "ALREADY_FRIENDS" in msg or "ALREADY_SENT" in msg:
                logger.info(f"Already friends/pending with {aicq_number} ({account_id})")
                return None
            raise

    # ── Chat ────────────────────────────────────────────────────────────

    async def send_chat_message(self, to_id: str, content: str, msg_type: str = "text") -> dict:
        return await self._request_with_refresh(
            "POST", f"{self.api_base}/chat/messages",
            json={"to": to_id, "data": {"type": msg_type, "content": content}},
        )

    async def get_conversation(self, friend_id: str, limit: int = 50) -> dict:
        return await self._request_with_refresh(
            "GET", f"{self.api_base}/chat/conversation/{friend_id}?limit={limit}",
        )

    async def mark_read(self, friend_id: str) -> dict:
        return await self._request_with_refresh(
            "POST", f"{self.api_base}/chat/mark-read",
            json={"friend_id": friend_id},
        )

    async def upload_file(self, friend_id: str, file_path: str) -> dict:
        """Upload a file and send it to a friend."""
        import os
        filename = os.path.basename(file_path)
        with open(file_path, "rb") as f:
            form = aiohttp.FormData()
            form.add_field("file", f, filename=filename)
            form.add_field("to", friend_id)
            return await self._request_with_refresh(
                "POST", f"{self.api_base}/chat/upload", data=form,
            )

    # ── WebSocket ───────────────────────────────────────────────────────

    def on_message(self, msg_type: str, handler: Callable):
        """Register a handler for a specific WS message type."""
        if msg_type not in self._ws_handlers:
            self._ws_handlers[msg_type] = []
        self._ws_handlers[msg_type].append(handler)

    async def connect_ws(self, agent_id: str) -> None:
        """Connect to the AICQ WebSocket and authenticate."""
        await self.ensure_auth(agent_id)

        session = await self._get_session()
        self.ws = await session.ws_connect(self.ws_url)
        self._running = True

        # Authenticate over WS
        await self.ws.send_json({
            "type": "online",
            "nodeId": self.server_account_id,
            "token": self.jwt_token,
        })

        # Start message pump
        self._reconnect_task = asyncio.create_task(self._ws_pump())
        logger.info("WebSocket connected and authenticating")

    async def _ws_pump(self) -> None:
        """Background task that reads WS messages and dispatches handlers."""
        try:
            async for msg in self.ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    try:
                        data = json.loads(msg.data)
                        msg_type = data.get("type", "")
                        self.connected = True

                        # Handle auth ack
                        if msg_type == "online_ack":
                            self.connected = True
                            logger.info(f"WS authenticated as {data.get('nodeId')}")
                            # Notify reconnect handlers
                            for h in self._ws_handlers.get("_reconnected", []):
                                try:
                                    await h(data) if asyncio.iscoroutinefunction(h) else h(data)
                                except Exception as e:
                                    logger.warning(f"Reconnect handler error: {e}")

                        # Handle auth failure — clear stale JWT so next reconnect gets fresh token
                        if msg_type == "auth_error" or msg_type == "error":
                            logger.warning(f"WS auth error: {data}")
                            self.jwt_token = None
                            break

                        # Dispatch to registered handlers
                        for h in self._ws_handlers.get(msg_type, []):
                            try:
                                await h(data) if asyncio.iscoroutinefunction(h) else h(data)
                            except Exception as e:
                                logger.warning(f"Handler error for {msg_type}: {e}")

                    except json.JSONDecodeError:
                        logger.warning(f"Invalid JSON from WS: {msg.data[:100]}")

                elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                    self.connected = False
                    break
        except Exception as e:
            logger.error(f"WS pump error: {e}")
            self.connected = False
        finally:
            if self._running:
                # Attempt reconnect after delay
                await asyncio.sleep(5)
                if self._running:
                    logger.info("Attempting WS reconnect...")
                    try:
                        await self.connect_ws(self._current_agent_id)
                    except Exception as e:
                        logger.error(f"WS reconnect failed: {e}")

    _current_agent_id: str = "default"

    async def send_ws(self, data: dict) -> bool:
        """Send a JSON message over WebSocket."""
        if self.ws and not self.ws.closed:
            await self.ws.send_json(data)
            return True
        return False

    async def disconnect_ws(self) -> None:
        """Disconnect the WebSocket gracefully."""
        self._running = False
        if self._reconnect_task:
            self._reconnect_task.cancel()
            try:
                await self._reconnect_task
            except asyncio.CancelledError:
                pass
        if self.ws and not self.ws.closed:
            # Send offline presence before closing
            try:
                await self.ws.send_json({"type": "offline", "nodeId": self.server_account_id})
                await asyncio.sleep(0.1)  # Brief pause to ensure message is sent
            except Exception as e:
                logger.warning(f"Failed to send offline message: {e}")
            await self.ws.close()
        self.connected = False
        logger.info("WebSocket disconnected")

    async def close(self) -> None:
        """Close all connections."""
        await self.disconnect_ws()
        if self.session and not self.session.closed:
            await self.session.close()

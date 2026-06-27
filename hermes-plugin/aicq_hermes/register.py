"""
Hermes plugin registration entry point.

This module provides the register() function that Hermes calls
when loading the AICQ platform plugin.
"""

import os
import logging

logger = logging.getLogger("aicq-hermes")


def check_requirements() -> bool:
    """Check if all required dependencies are available."""
    try:
        import aiohttp
        import nacl
        import websockets
        return True
    except ImportError as e:
        logger.warning(f"AICQ plugin dependency missing: {e}")
        return False


def validate_config(config) -> bool:
    """Validate the plugin configuration. Returns True if valid."""
    import os
    # Hermes gateway passes a PlatformConfig object, not a dict.
    server_url = None
    if isinstance(config, dict):
        server_url = config.get("AICQ_SERVER_URL")
    elif hasattr(config, 'env') and isinstance(config.env, dict):
        server_url = config.env.get("AICQ_SERVER_URL")
    elif hasattr(config, 'AICQ_SERVER_URL'):
        server_url = config.AICQ_SERVER_URL
    if not server_url:
        server_url = os.environ.get("AICQ_SERVER_URL")
    if not server_url:
        logger.warning("AICQ_SERVER_URL not configured")
        return False
    return True


def register(ctx):
    """
    Register the AICQ platform adapter with Hermes.

    This is the main entry point called by the Hermes plugin loader.
    It registers the AICQ platform adapter, tools, and hooks.
    """
    # ── Register Platform Adapter ───────────────────────────────────────
    from .adapter import AicqPlatformAdapter

    ctx.register_platform(
        name="aicq",
        label="AICQ Encrypted Chat",
        adapter_factory=lambda cfg: AicqPlatformAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        required_env=["AICQ_SERVER_URL", "AICQ_MASTER_NUMBER"],
        max_message_length=4000,
        platform_hint=(
            "You are chatting via AICQ, a secure chat network. "
            "E2EE is planned but not yet active — messages are currently "
            "relayed in plaintext through the server. "
            "You can send text, files, and images. "
            "Use the aicq_friends_list tool to see your friends, "
            "aicq_chat_send to send messages, and aicq_chat_send_file to send files."
        ),
        emoji="💬",
    )

    # ── Register AICQ Tools ─────────────────────────────────────────────

    ctx.register_tool(
        name="aicq_status",
        toolset="aicq",
        schema={
            "type": "function",
            "function": {
                "name": "aicq_status",
                "description": "Get the current AICQ connection status, agent ID, and bound master info.",
                "parameters": {"type": "object", "properties": {}, "required": []},
            },
        },
        handler=_tool_status,
        is_async=False,
    )

    ctx.register_tool(
        name="aicq_friends_list",
        toolset="aicq",
        schema={
            "type": "function",
            "function": {
                "name": "aicq_friends_list",
                "description": "List all AICQ friends (both human and AI agents).",
                "parameters": {"type": "object", "properties": {}, "required": []},
            },
        },
        handler=_tool_friends_list,
        is_async=False,
    )

    ctx.register_tool(
        name="aicq_friends_add",
        toolset="aicq",
        schema={
            "type": "function",
            "function": {
                "name": "aicq_friends_add",
                "description": "Add a friend on AICQ by their AICQ number (e.g. '1000000').",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "aicq_number": {
                            "type": "string",
                            "description": "The AICQ number of the user to add as friend",
                        },
                    },
                    "required": ["aicq_number"],
                },
            },
        },
        handler=_tool_friends_add,
        is_async=False,
    )

    ctx.register_tool(
        name="aicq_chat_send",
        toolset="aicq",
        schema={
            "type": "function",
            "function": {
                "name": "aicq_chat_send",
                "description": "Send a chat message to an AICQ friend by their ID.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "target_id": {
                            "type": "string",
                            "description": "The AICQ account ID of the recipient",
                        },
                        "content": {
                            "type": "string",
                            "description": "The message content to send",
                        },
                        "msg_type": {
                            "type": "string",
                            "description": "Message type: text (default), image, file",
                            "enum": ["text", "image", "file"],
                            "default": "text",
                        },
                    },
                    "required": ["target_id", "content"],
                },
            },
        },
        handler=_tool_chat_send,
        is_async=False,
    )

    ctx.register_tool(
        name="aicq_chat_history",
        toolset="aicq",
        schema={
            "type": "function",
            "function": {
                "name": "aicq_chat_history",
                "description": "Get chat history with an AICQ friend.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "friend_id": {
                            "type": "string",
                            "description": "The AICQ account ID of the friend",
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Number of messages to retrieve (default 50)",
                            "default": 50,
                        },
                    },
                    "required": ["friend_id"],
                },
            },
        },
        handler=_tool_chat_history,
        is_async=False,
    )

    ctx.register_tool(
        name="aicq_chat_send_file",
        toolset="aicq",
        schema={
            "type": "function",
            "function": {
                "name": "aicq_chat_send_file",
                "description": "Send a file to an AICQ friend.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "target_id": {
                            "type": "string",
                            "description": "The AICQ account ID of the recipient",
                        },
                        "file_path": {
                            "type": "string",
                            "description": "Local file path to send",
                        },
                    },
                    "required": ["target_id", "file_path"],
                },
            },
        },
        handler=_tool_chat_send_file,
        is_async=False,
    )

    # SPEC 合规: 探活 aicqSDK 适配层 (Step 1)
    # 这里仅检查 aicqSDK 是否可导入, 不强制使用。
    # 后续 Step 2+ 会逐步将 server_client.py 的方法委托给 sdk_adapter。
    try:
        from .sdk_adapter import is_sdk_available, get_sdk_version
        if is_sdk_available():
            logger.info(f"aicqSDK available: v{get_sdk_version()} (adapter wired, ready for Step 2 migration)")
        else:
            logger.warning("aicqSDK not available — plugin runs in legacy mode (self-implemented protocol stack). pip install aicqSDK>=0.9.0")
    except ImportError as e:
        logger.warning(f"sdk_adapter module not loadable: {e}")

    # [v1.3] Streaming tools — let the agent send LLM status + text chunks
    ctx.register_tool(
        name="aicq_chat_stream_chunk",
        toolset="aicq",
        schema={
            "type": "function",
            "function": {
                "name": "aicq_chat_stream_chunk",
                "description": (
                    "Send a streaming chunk to an AICQ friend. Use chunk_type='thinking' "
                    "to show an LLM status indicator (e.g. 'Calling LLM...', 'Iteration 2') "
                    "in the recipient's chat UI. Use chunk_type='text' for the actual "
                    "response text. Must be followed by aicq_chat_stream_end to finalize."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "target_id": {
                            "type": "string",
                            "description": "The AICQ account ID of the recipient",
                        },
                        "chunk_type": {
                            "type": "string",
                            "enum": ["text", "reasoning", "thinking", "reasoning_end",
                                     "clear_text", "tool_call", "tool_result"],
                            "description": "Type of stream chunk (default: text)",
                        },
                        "data": {
                            "description": "Chunk content. String for text/thinking/reasoning. Object for tool_call/tool_result.",
                        },
                    },
                    "required": ["target_id", "chunk_type"],
                },
            },
        },
        handler=_tool_chat_stream_chunk,
        is_async=False,
    )

    ctx.register_tool(
        name="aicq_chat_stream_end",
        toolset="aicq",
        schema={
            "type": "function",
            "function": {
                "name": "aicq_chat_stream_end",
                "description": "Signal the end of a streaming message. Must be called after a sequence of aicq_chat_stream_chunk calls.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "target_id": {
                            "type": "string",
                            "description": "The AICQ account ID of the recipient",
                        },
                        "message_id": {
                            "type": "string",
                            "description": "Optional message ID for dedup",
                        },
                    },
                    "required": ["target_id"],
                },
            },
        },
        handler=_tool_chat_stream_end,
        is_async=False,
    )

    logger.info("AICQ Hermes plugin registered (platform + 8 tools)")


# ── Tool Handlers ───────────────────────────────────────────────────────
# These are async functions that delegate to the running adapter instance.

def _get_adapter(ctx=None) -> "AicqPlatformAdapter | None":
    """Get the running AICQ adapter (synchronous).

    Hermes-Agent's tool dispatch calls handlers as
    ``handler(args_dict, **kwargs)`` — the first positional argument is
    the tool's args dict, NOT a PluginContext. So we cannot reach the
    adapter via ``ctx.gateway.platforms`` (the original design
    assumption was wrong).

    Instead, the adapter registers itself on connect() to a
    module-level singleton in ``aicq_hermes.adapter``. We read from
    that singleton here. The ``ctx`` argument is kept for backward
    compatibility (older handler signatures) but is no longer used.
    """
    try:
        from .adapter import get_running_adapter
        return get_running_adapter()
    except Exception:
        pass
    return None


def _json_result(obj) -> str:
    """Serialize a tool result dict/list to a JSON string.

    Hermes-Agent's tool dispatch contract requires handlers to return a
    JSON string (built-in tools all use ``json.dumps(...)``). Returning
    a bare dict/list causes the tool-result message's ``content`` field
    to be a non-string Python object, which violates the OpenAI Chat
    Completions wire format (``content`` must be a string). Some LLM
    gateways reject this with HTTP 503.
    """
    import json
    if isinstance(obj, str):
        return obj
    try:
        return json.dumps(obj, ensure_ascii=False, default=str)
    except Exception:
        return json.dumps({"error": f"serialization failed: {obj!r}"})


def _run_async_tool(coro_factory, *args, **kwargs):
    """Run an async adapter method from a sync tool handler.

    Hermes-Agent's tool dispatch bridges async handlers via _run_async(),
    which — inside the gateway's async context — spins up a WORKER THREAD
    to run the handler. aiohttp.ClientSession is bound to the gateway
    main loop and fails with ``RuntimeError: Timeout context manager
    should be used inside a task`` when used from the worker thread.

    This helper calls ``run_in_main_loop()`` (from aicq_hermes.adapter)
    to submit the coroutine to the gateway main loop and block on the
    result. Tool handlers are registered as ``is_async=False`` so hermes
    calls them directly from the worker thread; this function then
    bridges back to the main loop for the actual network I/O.

    Args:
        coro_factory: a callable that returns a coroutine (e.g.
            ``lambda: adapter.aicq_friends_list()``). We take a factory
            instead of a coroutine so the coroutine is created inside
            the main loop's context.
    """
    try:
        from .adapter import run_in_main_loop
        return run_in_main_loop(coro_factory())
    except Exception as e:
        import json
        return json.dumps({"error": f"tool execution failed: {type(e).__name__}: {e}"})


# ── Tool Handlers (synchronous, bridge to main loop for async I/O) ────────

def _tool_status(ctx, **kwargs):
    adapter = _get_adapter(ctx)
    if not adapter:
        return _json_result({"error": "AICQ adapter not running"})
    # aicq_status is a pure in-memory read — no network, safe to call
    # directly without the main-loop bridge.
    return _json_result(_run_async_tool(lambda: adapter.aicq_status()))


def _tool_friends_list(ctx, **kwargs):
    adapter = _get_adapter(ctx)
    if not adapter:
        return _json_result({"error": "AICQ adapter not running"})
    return _json_result(_run_async_tool(lambda: adapter.aicq_friends_list()))


def _tool_friends_add(ctx, aicq_number: str = "", **kwargs):
    adapter = _get_adapter(ctx)
    if not adapter:
        return _json_result({"error": "AICQ adapter not running"})
    if not aicq_number:
        return _json_result({"error": "aicq_number is required"})
    return _json_result(_run_async_tool(lambda: adapter.aicq_friends_add(aicq_number)))


def _tool_chat_send(ctx, target_id: str = "", content: str = "", msg_type: str = "text", **kwargs):
    adapter = _get_adapter(ctx)
    if not adapter:
        return _json_result({"error": "AICQ adapter not running"})
    if not target_id or not content:
        return _json_result({"error": "target_id and content are required"})
    return _json_result(_run_async_tool(lambda: adapter.aicq_chat_send(target_id, content, msg_type)))


def _tool_chat_history(ctx, friend_id: str = "", limit: int = 50, **kwargs):
    adapter = _get_adapter(ctx)
    if not adapter:
        return _json_result({"error": "AICQ adapter not running"})
    if not friend_id:
        return _json_result({"error": "friend_id is required"})
    return _json_result(_run_async_tool(lambda: adapter.aicq_chat_history(friend_id, limit)))


def _tool_chat_send_file(ctx, target_id: str = "", file_path: str = "", **kwargs):
    adapter = _get_adapter(ctx)
    if not adapter:
        return _json_result({"error": "AICQ adapter not running"})
    if not target_id or not file_path:
        return _json_result({"error": "target_id and file_path are required"})
    return _json_result(_run_async_tool(lambda: adapter.aicq_chat_send_file(target_id, file_path)))


def _tool_chat_stream_chunk(ctx, target_id: str = "", chunk_type: str = "text",
                            data=None, **kwargs):
    adapter = _get_adapter(ctx)
    if not adapter:
        return _json_result({"error": "AICQ adapter not running"})
    if not target_id:
        return _json_result({"error": "target_id is required"})
    return _json_result(_run_async_tool(lambda: adapter.aicq_chat_stream_chunk(target_id, chunk_type, data)))


def _tool_chat_stream_end(ctx, target_id: str = "", message_id: str = "", **kwargs):
    adapter = _get_adapter(ctx)
    if not adapter:
        return _json_result({"error": "AICQ adapter not running"})
    if not target_id:
        return _json_result({"error": "target_id is required"})
    return _json_result(_run_async_tool(lambda: adapter.aicq_chat_stream_end(target_id, message_id)))

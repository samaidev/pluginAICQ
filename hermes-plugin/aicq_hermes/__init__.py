"""
AICQ Hermes Plugin — Platform adapter for Hermes agent.

Connects Hermes to the AICQ end-to-end encrypted chat network.
Supports: login, registration, master binding, text/file/image chat, tool calling.
"""

from .adapter import AicqPlatformAdapter
from .register import register, check_requirements, validate_config

# ─── hermes-agent stream-tag compat shim ─────────────────────────────────────
# Some OpenAI-compatible LLM gateways (e.g. the aicq.online relay fronting
# MiniMax-M1 / Step-3.7-Flash) inline the model's reasoning inside
# ``delta.content`` wrapped in a single ``<think>`` open tag — with no
# matching ``</think>`` close. Hermes-agent's StreamingThinkScrubber
# treats an unclosed ``<think>`` as a truncated reasoning block and
# discards everything held back in its buffer at end-of-stream, so the
# agent ends up with an empty ``content`` and replies "Empty response
# from model — retrying (1/3)".
#
# Reasoning models that follow this pattern put the final answer on the
# line *after* the reasoning prose, so the safest recovery is: at
# flush() time, if we're still inside an unclosed block, find the last
# newline in the held-back buffer and emit whatever came after it as
# the visible response. If there's no newline we fall through to the
# original "discard everything" behaviour.
#
# This shim is applied at import time so any process that loads the
# aicq plugin (hermes gateway, hermes chat, tests, ...) picks it up
# automatically. Disable with:
#   AICQ_HERMES_PATCH_THINK_SCRUBBER=false
def _apply_think_scrubber_compat_patch():
    import os
    if os.environ.get("AICQ_HERMES_PATCH_THINK_SCRUBBER", "true").lower() != "true":
        return
    try:
        from agent.think_scrubber import StreamingThinkScrubber
    except Exception:
        # hermes-agent not installed (e.g. running plugin unit tests
        # without the full hermes stack) — nothing to patch.
        return

    # Already patched (e.g. plugin re-imported in the same process) —
    # skip so we don't wrap twice.
    if getattr(StreamingThinkScrubber.flush, "_aicq_hermes_patched", False):
        return

    original_flush = StreamingThinkScrubber.flush

    def patched_flush(self):
        if self._in_block:
            held = self._buf
            self._buf = ""
            self._in_block = False
            if not held:
                return ""
            last_nl = held.rfind("\n")
            if last_nl != -1 and last_nl + 1 < len(held):
                tail = held[last_nl + 1:]
                tail = self._strip_orphan_close_tags(tail)
                if tail:
                    self._last_emitted_ended_newline = tail.endswith("\n")
                return tail
            # No newline — fall through to original discard behaviour.
            return ""
        return original_flush(self)

    patched_flush._aicq_hermes_patched = True
    patched_flush._aicq_hermes_original = original_flush
    StreamingThinkScrubber.flush = patched_flush


_apply_think_scrubber_compat_patch()

__all__ = ["AicqPlatformAdapter", "register", "check_requirements", "validate_config"]

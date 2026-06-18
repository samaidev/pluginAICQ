"""
AICQ Hermes Plugin — Platform adapter for Hermes agent.

Connects Hermes to the AICQ end-to-end encrypted chat network.
Supports: login, registration, master binding, text/file/image chat, tool calling.
"""

from .adapter import AicqPlatformAdapter

__all__ = ["AicqPlatformAdapter"]

/**
 * AICQ Chat Plugin — Setup Wizard Entry Point
 *
 * Provides the setup-safe entry for OpenClaw's config / onboarding paths.
 * Uses defineSetupPluginEntry from the official Channel Plugin SDK.
 *
 * This entry is loaded when the channel is disabled or unconfigured.
 * It avoids pulling in heavy runtime code (database, transports, etc.).
 */

import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { aicqChatPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(aicqChatPlugin);

#!/usr/bin/env node
/**
 * AICQ Chat Plugin — Post-install script (v3.7 Channel SDK)
 *
 * Displays setup information after npm install.
 * v3.7 uses official Channel Plugin SDK (defineChannelPluginEntry).
 */

console.log('');
console.log('  ╔══════════════════════════════════════════════╗');
console.log('  ║     AICQ Chat Plugin v3.7 Installed!        ║');
console.log('  ╠══════════════════════════════════════════════╣');
console.log('  ║                                              ║');
console.log('  ║   Architecture: Channel SDK (in-process)     ║');
console.log('  ║   Uses defineChannelPluginEntry              ║');
console.log('  ║   No independent port needed!                ║');
console.log('  ║                                              ║');
console.log('  ║   Install via openclaw CLI:                  ║');
console.log('  ║     openclaw plugins uninstall aicq-chat     ║');
console.log('  ║     openclaw plugins install npm:aicq-chat-plugin ║');
console.log('  ║     openclaw gateway restart                 ║');
console.log('  ║                                              ║');
console.log('  ║   UI: /plugins/aicq-chat/ui/                 ║');
console.log('  ║   API: /plugins/aicq-chat/api/*              ║');
console.log('  ║   Docs: https://aicq.me                  ║');
console.log('  ╚══════════════════════════════════════════════╝');
console.log('');

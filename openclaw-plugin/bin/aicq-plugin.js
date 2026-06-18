#!/usr/bin/env node
/**
 * AICQ Chat Plugin — CLI Entry Point (v3.7 Channel)
 *
 * Usage:
 *   aicq-plugin           Start the plugin server (standalone mode)
 *   aicq-plugin status    Check plugin status
 *   aicq-plugin --server  Specify AICQ server URL
 *   aicq-plugin --help    Show help
 */
const { spawn } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const command = args[0] || 'start';

// Parse options
let serverUrl = process.env.AICQ_SERVER_URL || 'https://aicq.me';

for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--server' || args[i] === '-s') && args[i + 1]) {
    serverUrl = args[i + 1];
    i++;
  }
}

if (command === '--help' || command === '-h') {
  console.log(`
AICQ Chat Plugin v3.7 — End-to-End Encrypted Chat for OpenClaw (Channel)

Usage:
  aicq-plugin [command] [options]

Commands:
  start     Start the plugin server in standalone mode (default)
  status    Check plugin status

Options:
  --server, -s <url>      AICQ server URL (default: https://aicq.me)
  --help, -h              Show this help message

Environment Variables:
  AICQ_SERVER_URL         AICQ server URL
  AICQ_DATA_DIR           Data directory (default: ~/.aicq-plugin)

Architecture:
  v3.7 Channel — runs in-process with OpenClaw.
  No independent port needed.
`);
  process.exit(0);
}

if (command === 'status') {
  console.log('AICQ Plugin v3.7 (Channel architecture)');
  console.log('In Channel mode, the plugin runs inside OpenClaw process.');
  process.exit(0);
}

// Start the plugin server in standalone mode
console.log(`[AICQ] Starting plugin in standalone mode`);
console.log(`[AICQ] Server: ${serverUrl}`);

const env = { ...process.env, AICQ_SERVER_URL: serverUrl };
const child = spawn('node', [path.join(__dirname, '..', 'index.js')], {
  env,
  stdio: 'inherit',
  detached: false,
});

child.on('error', (err) => {
  console.error('[AICQ] Failed to start:', err.message);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code || 0);
});

process.on('SIGINT', () => {
  child.kill('SIGINT');
});

process.on('SIGTERM', () => {
  child.kill('SIGTERM');
});

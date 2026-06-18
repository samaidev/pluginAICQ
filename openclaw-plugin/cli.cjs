#!/usr/bin/env node
/**
 * AICQ Chat Plugin — CLI Entry Point (v3.7 Channel)
 *
 * Usage:
 *   openclaw plugins install npm:aicq-chat-plugin   Install via openclaw CLI
 *   openclaw plugins uninstall aicq-chat            Uninstall old version
 *   openclaw gateway restart                        Restart gateway
 *   aicq-plugin                    Start plugin server (standalone mode)
 *   aicq-plugin start              Start the plugin server (standalone mode)
 *   aicq-plugin install            Install plugin to OpenClaw only
 *   aicq-plugin uninstall          Remove plugin from OpenClaw
 *   aicq-plugin status             Check plugin status
 *   aicq-plugin --server <url>     Specify AICQ server URL
 *   aicq-plugin --help             Show help
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

// ── SKILL.md template ─────────────────────────────────────────────
const SKILL_MD_TEMPLATE = `---
name: aicq-chat
description: AICQ End-to-end Encrypted Chat Channel Plugin for OpenClaw — In-process Channel architecture with friend management, group chat, file transfer, and AI agent communication
license: MIT
metadata:
  author: AICQ
  version: "{VERSION}"
---

# AICQ Encrypted Chat

AICQ 是一个端到端加密聊天频道插件，基于 OpenClaw Channel 架构。支持好友管理、群组聊天、文件传输和 AI Agent 通信。

## 一键启动

\`\`\`bash
openclaw plugins install npm:aicq-chat-plugin
openclaw gateway restart
\`\`\`

## 功能特性

- **端到端加密 (E2EE)** — 基于 NaCl (libsodium) 的加密体系
- **Channel 架构** — 进程内运行，无独立端口
- **好友管理** — 好友码添加、QR 码扫描
- **群组聊天** — 创建群组、邀请成员
- **流式消息** — 支持 AI 流式输出

## UI 路由

- /plugins/aicq-chat/ui/ — 聊天界面
- /plugins/aicq-chat/api/* — API 端点
`;

// ── Find OpenClaw installation ──────────────────────────────────────
function findOpenClawDir() {
  const candidates = [
    path.join(os.homedir(), '.openclaw'),
    path.join(os.homedir(), 'openclaw'),
    path.join(os.homedir(), '.config', 'openclaw'),
  ];
  if (process.env.OPENCLAW_HOME) {
    candidates.unshift(process.env.OPENCLAW_HOME);
  }
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

// ── Find OpenClaw workspace ────────────────────────────────────────
function findOpenClawWorkspace() {
  if (process.env.OPENCLAW_WORKSPACE) {
    return process.env.OPENCLAW_WORKSPACE;
  }
  const home = os.homedir();
  const candidates = [
    process.cwd(),
    path.join(home, 'my-project'),
    path.join(home, 'openclaw'),
    path.join(home, '.openclaw'),
  ];
  for (const dir of candidates) {
    const skillsDir = path.join(dir, 'skills');
    if (fs.existsSync(skillsDir)) {
      return dir;
    }
  }
  let current = process.cwd();
  for (let i = 0; i < 3; i++) {
    const skillsDir = path.join(current, 'skills');
    if (fs.existsSync(skillsDir)) {
      return current;
    }
    current = path.dirname(current);
  }
  const openclawDir = findOpenClawDir();
  if (openclawDir) {
    return openclawDir;
  }
  return null;
}

// ── Recursively copy a directory ────────────────────────────────────
function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ── Install plugin files to a target directory ─────────────────────
function installToDir(sourceDir, targetDir, version) {
  const filesToCopy = [
    'index.js', 'setup-entry.js', 'cli.cjs', 'postinstall.cjs',
    'openclaw.plugin.json', 'package.json', 'README.md',
  ];
  const dirsToCopy = ['lib', 'src', 'public'];

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  for (const file of filesToCopy) {
    const src = path.join(sourceDir, file);
    const dest = path.join(targetDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }
  }

  for (const dir of dirsToCopy) {
    const src = path.join(sourceDir, dir);
    const dest = path.join(targetDir, dir);
    if (fs.existsSync(src)) {
      if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
      }
      copyDirRecursive(src, dest);
    }
  }

  const skillMd = SKILL_MD_TEMPLATE.replace('{VERSION}', version);
  fs.writeFileSync(path.join(targetDir, 'SKILL.md'), skillMd, 'utf8');
}

// ── Install to OpenClaw ────────────────────────────────────────────
function installToOpenClaw() {
  const PLUGIN_ID = 'aicq-chat';
  const sourceDir = path.resolve(__dirname);
  let version = '3.0.0';

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'));
    version = pkg.version;
  } catch (e) {}

  let skillsInstalled = false;
  const workspace = findOpenClawWorkspace();
  if (workspace) {
    const skillsDir = path.join(workspace, 'skills');
    const skillTargetDir = path.join(skillsDir, PLUGIN_ID);
    console.log(`[AICQ] Found workspace at: ${workspace}`);
    console.log(`[AICQ] Installing skill to ${skillTargetDir}...`);

    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }

    installToDir(sourceDir, skillTargetDir, version);

    console.log('[AICQ] Installing skill dependencies...');
    try {
      execSync('npm install --omit=dev', {
        cwd: skillTargetDir,
        stdio: 'pipe',
        timeout: 120000,
      });
      console.log('[AICQ] Skill dependencies installed.');
    } catch (e) {
      console.log('[AICQ] Warning: npm install failed. You may need to run manually:');
      console.log(`  cd ${skillTargetDir} && npm install`);
    }

    console.log(`[AICQ] Skill installed to: ${skillTargetDir}`);
    skillsInstalled = true;
  }

  let pluginInstalled = false;
  const openclawDir = findOpenClawDir();
  if (openclawDir) {
    const pluginsDir = path.join(openclawDir, 'plugins');
    const pluginTargetDir = path.join(pluginsDir, PLUGIN_ID);

    console.log(`[AICQ] Found OpenClaw at: ${openclawDir}`);
    console.log(`[AICQ] Installing plugin to ${pluginTargetDir}...`);

    if (!fs.existsSync(pluginsDir)) {
      fs.mkdirSync(pluginsDir, { recursive: true });
    }

    installToDir(sourceDir, pluginTargetDir, version);

    console.log('[AICQ] Installing plugin dependencies...');
    try {
      execSync('npm install --omit=dev', {
        cwd: pluginTargetDir,
        stdio: 'pipe',
        timeout: 120000,
      });
      console.log('[AICQ] Plugin dependencies installed.');
    } catch (e) {
      console.log('[AICQ] Warning: npm install failed. You may need to run manually:');
      console.log(`  cd ${pluginTargetDir} && npm install`);
    }

    console.log(`[AICQ] Plugin installed to: ${pluginTargetDir}`);
    pluginInstalled = true;
  }

  if (!skillsInstalled && !pluginInstalled) {
    console.log('[AICQ] OpenClaw not found, skipping auto-install.');
    console.log('[AICQ] Set OPENCLAW_HOME or OPENCLAW_WORKSPACE environment variable.');
    return false;
  }

  console.log('[AICQ] Restart OpenClaw to activate the plugin (Channel mode).');
  return true;
}

// ── Uninstall from OpenClaw ─────────────────────────────────────────
function uninstallFromOpenClaw() {
  const PLUGIN_ID = 'aicq-chat';
  let removed = false;

  const workspace = findOpenClawWorkspace();
  if (workspace) {
    const skillDir = path.join(workspace, 'skills', PLUGIN_ID);
    if (fs.existsSync(skillDir)) {
      console.log(`[AICQ] Removing skill from ${skillDir}...`);
      fs.rmSync(skillDir, { recursive: true, force: true });
      removed = true;
    }
  }

  const openclawDir = findOpenClawDir();
  if (openclawDir) {
    const pluginDir = path.join(openclawDir, 'plugins', PLUGIN_ID);
    if (fs.existsSync(pluginDir)) {
      console.log(`[AICQ] Removing plugin from ${pluginDir}...`);
      fs.rmSync(pluginDir, { recursive: true, force: true });
      removed = true;
    }
  }

  if (!removed) {
    console.log('[AICQ] AICQ plugin not found in any OpenClaw directory.');
  } else {
    console.log('[AICQ] Restart OpenClaw to complete the uninstall.');
  }
  return removed;
}

// ── Help ────────────────────────────────────────────────────────────
if (command === '--help' || command === '-h') {
  console.log(`
AICQ Chat Plugin v3.7 — End-to-End Encrypted Chat for OpenClaw (Channel SDK)

Usage:
  openclaw plugins install npm:aicq-chat-plugin   Install plugin via openclaw CLI
  openclaw plugins uninstall aicq-chat            Uninstall old version
  openclaw gateway restart                        Restart gateway after install
  aicq-plugin [command] [options]                 Advanced usage

Commands:
  start       Install to OpenClaw (if needed) (default)
  install     Install plugin to OpenClaw only
  uninstall   Remove plugin from OpenClaw (skills/ and plugins/)
  status      Check if the plugin is running

Options:
  --server, -s <url>      AICQ server URL (default: https://aicq.me)
  --help, -h              Show this help message

Environment Variables:
  AICQ_SERVER_URL         AICQ server URL
  AICQ_DATA_DIR           Data directory (default: ~/.aicq-plugin)
  OPENCLAW_HOME           OpenClaw installation directory (for plugins/)
  OPENCLAW_WORKSPACE      OpenClaw workspace directory (for skills/)

Architecture:
  v3.7 uses official Channel Plugin SDK (defineChannelPluginEntry).
  Runs in-process with OpenClaw — no standalone server needed.
  UI served via Gateway HTTP routes.
  - UI: /plugins/aicq-chat/ui/
  - API: /plugins/aicq-chat/api/*
`);
  process.exit(0);
}

// ── Status ──────────────────────────────────────────────────────────
if (command === 'status') {
  console.log('AICQ Plugin v3.7 (Channel SDK architecture)');
  console.log('Uses defineChannelPluginEntry — runs in-process with OpenClaw.');
  console.log('Check OpenClaw gateway status for plugin health.');
  process.exit(0);
}

// ── Install only ────────────────────────────────────────────────────
if (command === 'install') {
  installToOpenClaw();
  process.exit(0);
}

// ── Uninstall ───────────────────────────────────────────────────────
if (command === 'uninstall' || command === 'remove') {
  uninstallFromOpenClaw();
  process.exit(0);
}

// ── Start (default) — auto-install then inform user ───────────────
installToOpenClaw();

console.log('');
console.log('[AICQ] Channel Plugin uses OpenClaw Channel SDK (defineChannelPluginEntry).');
console.log('[AICQ] It runs in-process with OpenClaw — no standalone server needed.');
console.log('[AICQ] To activate:');
console.log('  openclaw plugins install npm:aicq-chat-plugin');
console.log('  openclaw gateway restart');
console.log('');
console.log(`[AICQ] Server: ${serverUrl}`);
console.log('[AICQ] UI: /plugins/aicq-chat/ui/');
console.log('[AICQ] API: /plugins/aicq-chat/api/*');

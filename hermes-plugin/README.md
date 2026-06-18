# AICQ Hermes Plugin

Connect [Hermes Agent](https://github.com/nousresearch/hermes-agent) to the [AICQ](https://aicq.me) end-to-end encrypted chat network.

## Features

- **Auto Registration & Login** — Ed25519 challenge-response authentication, registers on first run, reuses identity on subsequent starts
- **Master Binding** — Automatically adds the specified owner user as friend on startup
- **Text / File / Image Chat** — Full messaging support via WebSocket relay + REST fallback
- **Tool Calling** — 6 AICQ tools registered with Hermes (status, friends, chat send, history, file send)
- **Auto-Accept Friends** — Automatically accepts incoming friend requests
- **Unread Polling** — 30s periodic poll + WS reconnect fetch to never miss messages
- **E2EE** — NaCl (X25519 + XSalsa20-Poly1305) end-to-end encryption

## Installation

```bash
pip install aicq-hermes-plugin
```

Or install from source:

```bash
cd pluginAICQ/hermes-plugin
pip install -e .
```

## Configuration

Set environment variables or configure in `~/.hermes/.env`:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AICQ_SERVER_URL` | Yes | `https://aicq.me` | AICQ server URL |
| `AICQ_MASTER_NUMBER` | Yes | — | AICQ number of the master/owner to auto-bind |
| `AICQ_DATA_DIR` | No | `~/.aicq-hermes` | Directory for identity and data |
| `AICQ_AUTO_ACCEPT_FRIENDS` | No | `true` | Auto-accept friend requests |

## Hermes Plugin Setup

1. Install the plugin:
   ```bash
   pip install aicq-hermes-plugin
   ```

2. Copy to Hermes plugins directory:
   ```bash
   cp -r aicq_hermes/ ~/.hermes/plugins/aicq/
   cp PLUGIN.yaml ~/.hermes/plugins/aicq/
   ```

3. Configure environment:
   ```bash
   # In ~/.hermes/.env
   AICQ_SERVER_URL=https://aicq.me
   AICQ_MASTER_NUMBER=1000000
   ```

4. Start Hermes with the AICQ platform:
   ```bash
   hermes gateway run
   ```

## Registered Tools

| Tool | Description |
|------|-------------|
| `aicq_status` | Get connection status, agent ID, master info |
| `aicq_friends_list` | List all AICQ friends |
| `aicq_friends_add` | Add a friend by AICQ number |
| `aicq_chat_send` | Send a message (text/image/file) |
| `aicq_chat_history` | Get conversation history |
| `aicq_chat_send_file` | Send a file from local path |

## Architecture

```
Hermes Agent
    │
    ├── AicqPlatformAdapter (BasePlatformAdapter)
    │   ├── connect()       → register/login + bind master + start WS
    │   ├── disconnect()    → close WS + stop polling
    │   ├── send()          → relay message to AICQ friend
    │   └── set_message_handler() → forward inbound to Hermes
    │
    ├── IdentityManager     → Ed25519 + X25519 key persistence
    ├── AicqServerClient    → REST API + WebSocket client
    └── ChatManager         → message dispatch, unread polling, file transfer
```

## License

MIT


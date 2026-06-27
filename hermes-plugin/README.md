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

## Chat Session UI (Companion Feature)

The AICQ web client (https://aicq.me) and other UI surfaces that consume the
`pluginAICQ` family provide two new buttons in the chat header (placed BEFORE
the existing action buttons):

- **New Chat (+)** — Archives the current session and starts a new one.
- **History (clock)** — Opens a side panel listing archived sessions for the
  current friend/group.

These are **client-side UI concepts only** — the AICQ server still stores all
messages as a single linear conversation per friend. The session boundaries
are recorded in the browser's `localStorage` and used purely to filter which
messages are shown and to insert "── New Chat ──" separators.

This Hermes plugin itself has no UI layer and does not need any code changes
for the new feature; it continues to send/receive messages the same way as
before. From the plugin's perspective, a "new session" is just a point in
time — the plugin keeps working with the same linear conversation.

If you want the Hermes agent to be aware of session boundaries (for example,
to truncate context sent to the LLM), you can read the
`aicq_active_session_<type>_<id>` localStorage key from the user's browser
and pass the `startTime` as a `since` filter when calling
`aicq_chat_history`. This is optional and not required for basic
operation.


## Compatibility Notes

### v1.2.4 — OpenAI-compatible LLM gateways with inline `<think>` reasoning

Some OpenAI-compatible LLM gateways (e.g. the aicq.online relay fronting
MiniMax-M1 / Step-3.7-Flash) inline the model's reasoning inside
`delta.content` wrapped in a single `<think>` open tag with no
matching `</think>` close. Hermes-agent's `StreamingThinkScrubber`
treats an unclosed `<think>` as a truncated reasoning block and
discards everything held back in its buffer at end-of-stream, so the
agent ends up with an empty `content` and replies
"Empty response from model — retrying (1/3)".

This plugin (since v1.2.4) ships an import-time compatibility shim
that monkey-patches `StreamingThinkScrubber.flush` to recover the
visible answer in this case: when the stream ends inside an unclosed
`<think>` block, the shim finds the last newline in the held-back
buffer and emits whatever came after it as the final response
(reasoning models typically put the answer on the line after the
reasoning). If there is no newline, the original "discard everything"
behaviour is preserved.

The shim is enabled by default. To disable (e.g. for debugging or
when running against a gateway that emits properly closed tags):

```bash
export AICQ_HERMES_PATCH_THINK_SCRUBBER=false
```

The shim is idempotent (safe to apply multiple times) and degrades
gracefully if `agent.think_scrubber` is not importable (e.g. when
running plugin unit tests without the full hermes-agent stack).

## License

MIT

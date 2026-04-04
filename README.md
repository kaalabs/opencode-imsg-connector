# OpenCode iMessage Connector

Global OpenCode custom tools for reading and sending Messages.app chats on macOS through the local `imsg` CLI.

## What it adds

- `imessage_chats` to list recent chats
- `imessage_history` to read messages from a chat
- `imessage_rc_pending` to list incoming `@RC` or `@DRBOZ` messages that still need a reply
- `imessage_oc_reply_once` to reply once to an incoming `@RC` or `@DRBOZ` message
- `imessage_oc_status` to inspect reply-once state
- `imessage_send` to send a text message after explicit confirmation

## Requirements

- macOS with Messages.app signed in
- `imsg` installed and available on `PATH`
- Full Disk Access for the terminal or app running OpenCode
- Automation permission for that app to control Messages when sending

This project expects `imsg` at `PATH`, but you can override it with `IMSG_BIN=/path/to/imsg`.

## Install

```bash
npm install
```

The canonical implementation lives at `tools-source/imessage.js`.

The live global tool file at `~/.config/opencode/tools/imessage.js` re-exports that repo file, so future edits only need to happen in one place. Restart OpenCode after changing the tool code.

This repo also keeps the fake `imsg` helper used for safe tests.

`RC_HEARTBEAT` can now process two inbound trigger styles:

- `@RC` for general chat-style requests
- `@DRBOZ` for ketoCONTINUUM-style coaching requests grounded in the Remcobrain `ketoCONTINUUM` book

Outgoing auto-replies keep the trigger visible in Messages:

- `@RC` requests send replies prefixed with `RC:`
- `@DRBOZ` requests send replies prefixed with `DRBOZ:`

## Start After Login

Use the startup helper to bring up both the headless OpenCode server and the RC heartbeat watcher in the background:

```bash
./scripts/start-rc-heartbeat-stack.sh
```

Defaults:

- server: `http://127.0.0.1:4096`
- model: `openai/gpt-5.4`
- agent: `build`
- prompt: `RC_HEARTBEAT`

Optional overrides:

```bash
./scripts/start-rc-heartbeat-stack.sh \
  --hostname 127.0.0.1 \
  --port 4096 \
  --model openai/gpt-5.4 \
  --agent build \
  --prompt RC_HEARTBEAT
```

The script is idempotent: if the local server and watcher are already running, it will reuse them instead of starting duplicates.

The `@DRBOZ` workflow should retrieve cited evidence from the Remcobrain `ketoCONTINUUM` PDF before replying. Because the source can be indexed with unexpected language metadata, the retrieval flow should avoid forcing an English language filter.

By default it writes logs and PID files under `${TMPDIR:-/tmp}/opencode-imsg-connector`.

## Tool usage

Examples you can type in OpenCode:

```text
Use imessage_chats to list my recent messages.
Use imessage_history with chatId 12 and limit 10.
Send "Ik ben er zo" using imessage_send with targetType "to" and targetValue "+31612345678". Ask me to confirm first.
```

`imessage_send` will fail unless `confirmed: true` is passed, so the agent needs an explicit user send confirmation before using it.

Send targeting is explicit:

- `targetType: "to"` with `targetValue` as phone number or email
- `targetType: "chatId"` with `targetValue` as the chat row ID digits
- `targetType: "chatIdentifier"` with `targetValue` as the raw chat identifier
- `targetType: "chatGuid"` with `targetValue` as the raw chat GUID

## Verify

```bash
npm run check
imsg chats --limit 3 --json
```

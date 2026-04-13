# OpenCode iMessage Connector

Global OpenCode custom tools for reading and sending Messages.app chats on macOS through the local `imsg` CLI, with matching WhatsApp trigger handling and `amen`-based email review.

This connector now also supports a WhatsApp transport path with the same command surface (`whatsapp_*`), plus an `amen_*` email tool surface and RC heartbeat email signaling.

## What it adds

- `imessage_chats` to list recent chats
- `imessage_history` to read messages from a chat
- `imessage_rc_pending` to list incoming `@RC` or `@DRBOZ` messages that still need a reply
- `imessage_oc_reply_once` to reply once to an incoming `@RC` or `@DRBOZ` message
- `imessage_oc_status` to inspect reply-once state
- `imessage_send` to send a text message after explicit confirmation
- `imessage_signal_once` to send a deduped automation signal into a specific iMessage chat
- `imessage_signal_email_once` to send a structured, readable deduped email alert into a specific iMessage chat
- `whatsapp_chats` to list recent WhatsApp chats
- `whatsapp_history` to read WhatsApp messages from a chat
- `whatsapp_pending` to list incoming trigger requests on WhatsApp that still need a reply
- `whatsapp_reply_once` to reply once to an incoming WhatsApp trigger request
- `whatsapp_status` to inspect WhatsApp reply-once state
- `amen_check` to refresh Apple Mail and report queued new-email counts
- `amen_headlines` to list queued new-email headline metadata without clearing the queue
- `amen_message_id` to fetch a specific email body by RFC Message-ID without mutating queue state
- `amen_fetch` to fetch and clear queued amen emails after successful processing

OWPenbot compatibility aliases are also exported:

- `owpenbot_chats`
- `owpenbot_history`
- `owpenbot_send`
- `owpenbot_pending`
- `owpenbot_reply_once`
- `owpenbot_oc_reply_once`
- `owpenbot_status`
- `owpenbot_oc_status`

## Requirements

- macOS with Messages.app signed in
- `imsg` installed and available on `PATH`
- Full Disk Access for the terminal or app running OpenCode
- Automation permission for that app to control Messages when sending
- `wu` (or compatible WhatsApp CLI exposing `listen`, `chats`, `messages`, and `history`) for WhatsApp support
- `amen` for queued Apple Mail headline/body access and email heartbeat signaling

This project expects `imsg` at `PATH`, but you can override it with `IMSG_BIN=/path/to/imsg`.

## Install

```bash
npm install
```

The canonical implementations live at:

- `tools-source/imessage.js`
- `tools-source/whatsapp.js`
- `tools-source/amen.js`

The live global tool files at `~/.config/opencode/tools/*.js` re-export those repo files, so future edits only need to happen in one place. Restart OpenCode after changing the tool code.

This repo also keeps the fake `imsg` helper used for safe tests.

## OWPENbot path (recommended)

Use this when you want an explicit OWPENbot-style entrypoint but still run the existing iMessage relay implementation underneath:

- `./scripts/watch-owpenbot.js`
- `./scripts/start-owpenbot-stack.sh`

These scripts behave the same as their `RC` equivalents and are intentionally thin wrappers so you can integrate a relaunch strategy or deployment automation around OWPENbot naming without changing underlying behavior.

You can tune request prefixes without code changes by setting:

```bash
export OWPENBOT_REQUEST_KINDS='{"rc":{"incomingPrefix":"@RC","outgoingPrefix":"RC:"},"drboz":{"incomingPrefix":"@DRBOZ","outgoingPrefix":"DRBOZ:"}}'
```

The legacy shape is unchanged, so omit this for default `@RC`/`@DRBOZ` behavior.

`RC_HEARTBEAT` is the single automation trigger prompt for all active heartbeat workflows on this host, including iMessage, WhatsApp, and amen-backed email review.

It can now process two inbound request styles:

- `@RC` for general chat-style requests
- `@DRBOZ` for ketoCONTINUUM-style coaching requests grounded in the Openbrain `ketoCONTINUUM` book

Queued email is now reviewed during the same heartbeat flow. The intended runtime split is:

- cron runs `scripts/check-amen-heartbeat.js` every 10 minutes
- cron is the only place that runs `amen check`
- `RC_HEARTBEAT` consumes queued email via `amen_headlines` plus `amen_message_id`
- relevant email is signaled into self-chat `chatId: 144`
- `amen_fetch` is only used after successful review to clear the queue

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

You can pass custom trigger prefixes to the stack wrapper:

```bash
./scripts/start-rc-heartbeat-stack.sh --request-kinds '{"rc":{"incomingPrefix":"@RC","outgoingPrefix":"RC:"}}'
```

You can also run the OWPENbot-named stack wrapper:

```bash
./scripts/start-owpenbot-stack.sh
```

The script is idempotent: if the local server and watcher are already running, it will reuse them instead of starting duplicates.

### WhatsApp channel (beta)

You can run the same RC heartbeat flow against WhatsApp without introducing a separate OpenCode prompt:

- `./scripts/watch-whatsapp-heartbeat.js`
- `./scripts/start-whatsapp-heartbeat-stack.sh`

By default these scripts run `WHATSAPP_BIN` for watch/history/send and invoke `rc-heartbeat.sh` with the shared `RC_HEARTBEAT` prompt.

```bash
./scripts/start-whatsapp-heartbeat-stack.sh \
  --hostname 127.0.0.1 \
  --port 4096 \
  --model openai/gpt-5.4 \
  --agent build \
  --prompt RC_HEARTBEAT \
  --runtime-dir /tmp/opencode-whatsapp
```

You can also override trigger prefixes for both iMessage and WhatsApp flows separately:

```bash
WHATSAPP_REQUEST_KINDS='{"rc":{"incomingPrefix":"@RC","outgoingPrefix":"RC:"},"drboz":{"incomingPrefix":"@DRBOZ","outgoingPrefix":"DRBOZ:"}}' \
./scripts/start-whatsapp-heartbeat-stack.sh
```

The `@DRBOZ` workflow should retrieve cited evidence from the Openbrain `ketoCONTINUUM` PDF before replying. Because the source can be indexed with unexpected language metadata, the retrieval flow should avoid forcing an English language filter.

By default it writes logs and PID files under `${TMPDIR:-/tmp}/opencode-imsg-connector`.

### Amen email cron

Install the periodic email trigger under the same user that runs OpenCode and Messages permissions:

```cron
*/10 * * * * /opt/homebrew/bin/node /Users/rrk/Work/opencode-imsg-connector/scripts/check-amen-heartbeat.js --server-url http://127.0.0.1:4096 --model openai/gpt-5.4 --agent build --prompt RC_HEARTBEAT --runtime-dir /tmp/opencode-imsg-connector --amen-bin /Users/rrk/.local/bin/amen --opencode-bin /opt/homebrew/bin/opencode >> /tmp/opencode-imsg-connector/amen-cron.log 2>&1
```

This script only triggers the heartbeat when `amen check --format json` reports queued new email.

## Tool usage

Examples you can type in OpenCode:

```text
Use imessage_chats to list my recent messages.
Use imessage_history with chatId 12 and limit 10.
Send "Ik ben er zo" using imessage_send with targetType "to" and targetValue "+31612345678". Ask me to confirm first.
Use amen_headlines to inspect queued email without clearing the queue.
Use amen_message_id with a headline's rfcMessageID to fetch the full body safely.
```

`imessage_send` will fail unless `confirmed: true` is passed, so the agent needs an explicit user send confirmation before using it.

Send targeting is explicit:

- `targetType: "to"` with `targetValue` as phone number or email
- `targetType: "chatId"` with `targetValue` as the chat row ID digits
- `targetType: "chatIdentifier"` with `targetValue` as the raw chat identifier
- `targetType: "chatGuid"` with `targetValue` as the raw chat GUID

## Production launchd install (macOS)

Install and optionally load a `launchd` agent in one command. The installer now builds a real app bundle launcher under `~/Applications/OWPENbot Connector.app` and points `launchd` at that bundle executable instead of raw `node`.

```bash
./scripts/install-owpenbot-launchd.sh --load
```

For macOS Privacy & Security, approve the app bundle itself:

- `~/Applications/OWPENbot Connector.app`

The generated plist format is documented in:

`./scripts/launchd/com.owpenbot.imessage-connector.plist.example`

The installer accepts deployment overrides:

```bash
./scripts/install-owpenbot-launchd.sh \
  --label com.owpenbot.imessage-connector \
  --app-name "OWPENbot Connector" \
  --bundle-id com.owpenbot.connector \
  --app-dir ~/Applications \
  --runtime-dir /opt/owpenbot/imessage \
  --hostname 127.0.0.1 \
  --port 4096 \
  --model openai/gpt-5.4 \
  --agent build \
  --prompt RC_HEARTBEAT \
  --imsg-bin /usr/local/bin/imsg \
  --amen-bin /Users/rrk/.local/bin/amen \
  --opencode-bin /usr/local/bin/opencode \
  --node-bin /opt/homebrew/bin/node \
  --request-kinds '{"rc":{"incomingPrefix":"@RC","outgoingPrefix":"RC:"},"drboz":{"incomingPrefix":"@DRBOZ","outgoingPrefix":"DRBOZ:"}}'
```

To update/reload after changing a config:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.owpenbot.imessage-connector.plist
./scripts/install-owpenbot-launchd.sh --load --label com.owpenbot.imessage-connector
```

Uninstall:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.owpenbot.imessage-connector.plist
rm ~/Library/LaunchAgents/com.owpenbot.imessage-connector.plist
```

## Verify

Production deployment hardening steps and runbook are documented in [PRODUCTION.md](/Users/rrk/Work/opencode-imsg-connector/PRODUCTION.md).

The `imsg history` attributed-body decoding bug write-up and standalone reproducer live at [docs/imsg-attributedbody-history-bug.md](/Users/rrk/Work/opencode-imsg-connector/docs/imsg-attributedbody-history-bug.md).

```bash
npm run check
imsg chats --limit 3 --json
```

## WhatsApp fake CLI helper (tests)

The repository includes `scripts/fake-whatsapp.js` for deterministic test execution. It mirrors the CLI contract used by `scripts/whatsapp-cli.js`, `scripts/watch-whatsapp-heartbeat.js`, and `tools-source/whatsapp.js` via environment variables prefixed `FAKE_WHATSAPP_...`.

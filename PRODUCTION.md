# OWPENbot Production Runbook

This runbook covers the production readiness path introduced in this repository for OWPENbot and WhatsApp entrypoints.

## 1) Prerequisites

- macOS host with Messages.app logged in.
- Full Disk Access for the process/user launching launchd/opencode.
- Automation permission for that user to control Messages.app.
- opencode, node, imsg, curl, and `wu` (or a `whatsapp` CLI exposing `listen`, `chats`, `messages`, `history` subcommands) available.
- RUNTIME_DIR writable by the runtime user.

Quick install for the recommended WhatsApp transport:

```bash
npm install -g wu
wu login
```

## 2) Deployment targets

The production path is built on existing RC internals:

- Tooling/behavior logic remains in tools-source/imessage.js.
- OWPENbot tools are aliases over existing RC tools.
- Watcher behavior is launched through scripts/watch-owpenbot.js -> scripts/watch-rc-heartbeat.js.
- Stack helper is scripts/start-owpenbot-stack.sh -> scripts/start-rc-heartbeat-stack.sh.
- launchd installer is scripts/install-owpenbot-launchd.sh.
- WhatsApp logic is in tools-source/whatsapp.js and uses:
  - scripts/watch-whatsapp-heartbeat.js
  - scripts/start-whatsapp-heartbeat-stack.sh

`RC_HEARTBEAT` is the single automation trigger prompt for both iMessage and WhatsApp workflows on this host.

## 3) Install/update workflow (recommended)

From repo root:

```bash
cd /path/to/opencode-imsg-connector

./scripts/install-owpenbot-launchd.sh \
  --load \
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
  --opencode-bin /usr/local/bin/opencode \
  --node-bin /opt/homebrew/bin/node

# Optional: run a dedicated WhatsApp stack from the same machine:
# (no launchd wrapper is required; keep it supervised by your own process manager)
./scripts/start-whatsapp-heartbeat-stack.sh \
  --hostname 127.0.0.1 \
  --port 4097 \
  --runtime-dir /opt/owpenbot/whatsapp \
  --model openai/gpt-5.4 \
  --agent build \
  --prompt RC_HEARTBEAT \
  --whatsapp-bin /usr/local/bin/wu
```

Notes:
- The installer builds `~/Applications/OWPENbot Connector.app` and points `launchd` at the app bundle executable. On macOS, grant Full Disk Access and Automation to that app bundle path.
- You can customize request mapping without code changes by adding --request-kinds:

```bash
./scripts/install-owpenbot-launchd.sh \
  --request-kinds '{"rc":{"incomingPrefix":"@RC","outgoingPrefix":"RC:"},"drboz":{"incomingPrefix":"@DRBOZ","outgoingPrefix":"DRBOZ:"}}'
```

- If a plist already exists at ~/Library/LaunchAgents/com.owpenbot.imessage-connector.plist, the command regenerates it before bootstrap.

## 4) Post-install verification

```bash
launchctl print gui/$(id -u)/com.owpenbot.imessage-connector
launchctl list | grep com.owpenbot.imessage-connector || true
curl -fsS http://127.0.0.1:4096/global/health
```

Check logs for startup state:

```bash
ls -lah "${RUNTIME_DIR:-${TMPDIR:-/tmp}/opencode-imsg-connector}"
tail -n 120 "${RUNTIME_DIR:-${TMPDIR:-/tmp}/opencode-imsg-connector}/opencode-server.log"
tail -n 120 "${RUNTIME_DIR:-${TMPDIR:-/tmp}/opencode-imsg-connector}/rc-heartbeat-watcher.log"
tail -n 120 "${RUNTIME_DIR:-${TMPDIR:-/tmp}/opencode-imsg-connector}/whatsapp-heartbeat-watcher.log"
tail -n 120 "${RUNTIME_DIR:-${TMPDIR:-/tmp}/opencode-imsg-connector}/launchd.out.log"
tail -n 120 "${RUNTIME_DIR:-${TMPDIR:-/tmp}/opencode-imsg-connector}/launchd.err.log"
```

## 5) Runtime checks

1. Confirm both PIDs are alive:

```bash
ps -p "$(cat "${RUNTIME_DIR:-${TMPDIR:-/tmp}/opencode-imsg-connector}/opencode-server.pid")" 2>/dev/null || true
ps -p "$(cat "${RUNTIME_DIR:-${TMPDIR:-/tmp}/opencode-imsg-connector}/rc-heartbeat-watcher.pid")" 2>/dev/null || true
ps -p "$(cat "${RUNTIME_DIR:-${TMPDIR:-/tmp}/opencode-imsg-connector}/whatsapp-heartbeat-watcher.pid")" 2>/dev/null || true
```

2. Sanity-check tool wiring in OpenCode: owpenbot_* tools should be present.

3. Verify request-kind mapping in controlled environment with test messages for expected @RC / RC: and @DRBOZ / DRBOZ: prefixes.

## 6) Rolling restart / reload

After changing config, binaries, or request kinds:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.owpenbot.imessage-connector.plist || true
./scripts/install-owpenbot-launchd.sh --load --label com.owpenbot.imessage-connector
```

## 7) Uninstall

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.owpenbot.imessage-connector.plist || true
rm -f ~/Library/LaunchAgents/com.owpenbot.imessage-connector.plist
```

(Optional) archive logs/runtime state before teardown if needed.

## 8) Acceptance criteria for production readiness

- npm run check passes.
- npm test passes.
- Stack startup is idempotent when rerun.
- launchd service is active after bootstrap.
- curl -fsS http://127.0.0.1:4096/global/health succeeds.
- OWPENbot aliases and custom OWPENBOT_REQUEST_KINDS are covered by tests.

## 9) Known environment-specific caveats

- launchd is macOS-only. For other process managers, replicate:
  - opencode serve --hostname ... --port ...
  - node scripts/watch-owpenbot.js --server-url ... --model ... --agent ... --prompt ...
  - node scripts/watch-whatsapp-heartbeat.js --server-url ... --model ... --agent ... --prompt ...
- imsg permissions are user/session specific; permission errors usually appear in watcher logs as Automation / AppleScript access failures.

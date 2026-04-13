#!/usr/bin/env node

import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const heartbeatScript = resolve(scriptDir, "rc-heartbeat.sh")
const whatsappBin = process.env.WHATSAPP_BIN ?? resolve(scriptDir, "whatsapp-cli.js")

function usage(code = 1) {
  process.stderr.write(
    [
      `Usage: ${process.argv[1].split("/").pop()} [options]`,
      "",
      "Options:",
      "  --server-url URL              OpenCode server URL (default: http://localhost:4096)",
      "  --model PROVIDER/MODEL        Model to use (default: openai/gpt-5.4)",
      "  --agent AGENT                 Agent to use (default: build)",
      "  --prompt PROMPT               Trigger prompt (default: RC_HEARTBEAT)",
      "  --chat-id ID                  Limit watch to a specific chat row ID",
      "  --participants LIST           Comma-separated participant handles",
      "  --since-rowid ID              Start watching after this message row ID",
      "  --debounce VALUE              whatsapp watch debounce interval",
      "  --attachments                 Include attachment metadata in watch events",
      "  --reactions                   Include reaction events in the watch stream",
      "  -h, --help                    Show this help",
      "",
      "Environment:",
      "  WHATSAPP_BIN                  Override the whatsapp CLI executable path",
      "  WHATSAPP_REAL_BIN             Override the real WhatsApp CLI when using the wrapper",
      "  OPENCODE_BIN                  Override the opencode executable used by rc-heartbeat.sh",
      "",
    ].join("\n"),
  )
  process.exit(code)
}

function parseArgs(argv) {
  const options = {
    serverUrl: "http://localhost:4096",
    model: "openai/gpt-5.4",
    agent: "build",
    prompt: "RC_HEARTBEAT",
    chatId: "",
    participants: [],
    sinceRowid: "",
    debounce: "",
    attachments: false,
    reactions: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    switch (arg) {
      case "--server-url":
        options.serverUrl = argv[index + 1] ?? usage()
        index += 1
        break
      case "--model":
        options.model = argv[index + 1] ?? usage()
        index += 1
        break
      case "--agent":
        options.agent = argv[index + 1] ?? usage()
        index += 1
        break
      case "--prompt":
        options.prompt = argv[index + 1] ?? usage()
        index += 1
        break
      case "--chat-id":
        options.chatId = argv[index + 1] ?? usage()
        index += 1
        break
      case "--participants":
        options.participants = (argv[index + 1] ?? usage())
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
        index += 1
        break
      case "--since-rowid":
        options.sinceRowid = argv[index + 1] ?? usage()
        index += 1
        break
      case "--debounce":
        options.debounce = argv[index + 1] ?? usage()
        index += 1
        break
      case "--attachments":
        options.attachments = true
        break
      case "--reactions":
        options.reactions = true
        break
      case "-h":
      case "--help":
        usage(0)
        break
      default:
        process.stderr.write(`Unknown argument: ${arg}\n`)
        usage()
    }
  }

  return options
}

function buildWatchArgs(options) {
  const args = ["watch", "--json"]

  if (options.chatId) args.push("--chat-id", options.chatId)
  if (options.participants.length > 0) args.push("--participants", options.participants.join(","))
  if (options.sinceRowid) args.push("--since-rowid", options.sinceRowid)
  if (options.debounce) args.push("--debounce", options.debounce)
  if (options.attachments) args.push("--attachments")
  if (options.reactions) args.push("--reactions")

  return args
}

function buildHeartbeatArgs(options) {
  return [
    heartbeatScript,
    "--server-url",
    options.serverUrl,
    "--model",
    options.model,
    "--agent",
    options.agent,
    "--prompt",
    options.prompt,
  ]
}

function eventKey(event) {
  if (event.guid) return `guid:${event.guid}`
  if (event.id !== undefined && event.id !== null) return `id:${event.id}`
  return ""
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (normalized === "") return false
    if (["true", "1", "yes", "on"].includes(normalized)) return true
    if (["false", "0", "no", "off"].includes(normalized)) return false
  }
  return Boolean(value)
}

function isIncomingMessage(event) {
  if (!event || typeof event !== "object") return false
  if (event.from_me === true || event.sender === "me" || event.from === "me") return false
  return Boolean(event.guid || event.id !== undefined)
}

function normalizeWatchEvent(raw) {
  if (!raw || typeof raw !== "object") return null

  const chatId = raw.chat_id ?? raw.chatId ?? raw.chat?.id ?? raw.chat_jid ?? raw.chat ?? raw.jid ?? raw.phone
  const text = raw.text ?? raw.body ?? raw.content ?? raw.message
  const timestamp = raw.created_at ?? raw.timestamp ?? raw.createdAt ?? raw.date
  const guid = raw.guid ?? raw.message_id ?? raw.messageId
  const id = raw.id ?? raw.msg_id ?? raw.msgId ?? raw.key
  const fromMe =
    raw.is_from_me ??
    raw.from_me ??
    raw.fromMe ??
    raw.sender_is_me ??
    raw.authorized_from_me ??
    raw.from === "me" ??
    (typeof raw.from === "object" ? parseBoolean(raw.from?.me) : undefined)

  const resolvedText = typeof text === "object" ? text?.body ?? text?.text : text

  return {
    chat_id: chatId == null ? "" : String(chatId),
    text: resolvedText,
    guid: guid == null ? "" : String(guid),
    id: id == null ? undefined : String(id),
    from_me: parseBoolean(fromMe),
    created_at: typeof timestamp === "number" ? new Date(timestamp).toISOString() : timestamp,
  }
}

const options = parseArgs(process.argv.slice(2))
const watchArgs = buildWatchArgs(options)
const seenEvents = new Set()
const seenOrder = []
const maxSeenEvents = 500
let heartbeatRunning = false
let heartbeatQueued = false
let stopping = false

function rememberEvent(key) {
  if (!key || seenEvents.has(key)) return false

  seenEvents.add(key)
  seenOrder.push(key)

  if (seenOrder.length > maxSeenEvents) {
    const evicted = seenOrder.shift()
    if (evicted) seenEvents.delete(evicted)
  }

  return true
}

function log(message) {
  process.stderr.write(`[watch-whatsapp-heartbeat] ${message}\n`)
}

function runHeartbeat() {
  heartbeatRunning = true
  const child = spawn("bash", buildHeartbeatArgs(options), {
    stdio: "inherit",
    env: process.env,
  })

  child.on("exit", (code, signal) => {
    heartbeatRunning = false

    if (signal) {
      log(`heartbeat exited from signal ${signal}`)
    } else if (code !== 0) {
      log(`heartbeat exited with code ${code}`)
    }

    if (heartbeatQueued && !stopping) {
      heartbeatQueued = false
      runHeartbeat()
    }
  })
}

function queueHeartbeat() {
  if (heartbeatRunning) {
    heartbeatQueued = true
    return
  }

  runHeartbeat()
}

const watchProcess = spawn(whatsappBin, watchArgs, {
  stdio: ["ignore", "pipe", "inherit"],
  env: process.env,
})

log(`watching with: ${whatsappBin} ${watchArgs.join(" ")}`)
log(`heartbeat command: ${buildHeartbeatArgs(options).join(" ")}`)

const lines = createInterface({ input: watchProcess.stdout })

lines.on("line", (line) => {
  const trimmed = line.trim()
  if (!trimmed) return

  let event
  try {
    event = JSON.parse(trimmed)
  } catch {
    log(`ignoring non-JSON watch line: ${trimmed}`)
    return
  }

  const normalizedEvent = normalizeWatchEvent(event)
  if (!normalizedEvent) return
  if (!isIncomingMessage(normalizedEvent)) return

  const key = eventKey(normalizedEvent)
  if (key && !rememberEvent(key)) return

  log(`incoming message detected${normalizedEvent.chat_id ? ` in chat ${normalizedEvent.chat_id}` : ""}`)
  queueHeartbeat()
})

watchProcess.on("exit", (code, signal) => {
  stopping = true

  if (signal) {
    log(`whatsapp watch exited from signal ${signal}`)
    process.exit(1)
  }

  process.exit(code ?? 1)
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true
    watchProcess.kill(signal)
  })
}

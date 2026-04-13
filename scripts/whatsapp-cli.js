#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const args = process.argv.slice(2)
const cliPath = fileURLToPath(import.meta.url)
const configuredCli = process.env.WHATSAPP_REAL_BIN ?? process.env.WHATSAPP_BIN ?? "wu"
const cli = configuredCli === cliPath ? "whatsapp-cli" : configuredCli
const scriptDir = resolve(cliPath, "..")
const controllerScript = resolve(scriptDir, "whatsapp-controller.js")
const nodeBin = process.env.NODE_BIN ?? process.execPath
const wuHome = process.env.WU_HOME ?? join(homedir(), ".wu")
const wuDbPath = join(wuHome, "wu.db")
const controllerHome = join(wuHome, "owpenbot-controller")
const controllerPidPath = join(controllerHome, "controller.pid")
const controllerRequestsDir = join(controllerHome, "requests")
const defaultWatchPollMs = Number.parseInt(process.env.WHATSAPP_WATCH_POLL_MS ?? "1500", 10)
const defaultSendTimeoutMs = Number.parseInt(process.env.WHATSAPP_SEND_TIMEOUT_MS ?? "45000", 10)

function parseBoolean(value) {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (["true", "1", "yes", "on"].includes(normalized)) return true
    if (["false", "0", "no", "off"].includes(normalized)) return false
  }
  return Boolean(value)
}

function normalizeWatchEvent(raw) {
  if (!raw || typeof raw !== "object") return null

  const chatId = raw.chat_id ?? raw.chatId ?? raw.chat?.id ?? raw.chat_jid ?? raw.chat ?? raw.jid ?? raw.phone
  const text = raw.text ?? raw.body ?? raw.content ?? raw.message
  const timestamp = raw.created_at ?? raw.timestamp ?? raw.createdAt ?? raw.date
  const guid = raw.guid ?? raw.message_id ?? raw.messageId
  const id = raw.id ?? raw.msg_id ?? raw.msgId ?? raw.key
  const fromMe = raw.is_from_me ?? raw.from_me ?? raw.fromMe ?? raw.sender_is_me ?? raw.authorized_from_me ?? raw.from === "me"

  const normalizedText = typeof text === "object" ? text?.body ?? text?.text : text

  return {
    ...raw,
    chat_id: chatId == null ? "" : String(chatId),
    text: normalizedText,
    guid: guid == null ? "" : String(guid),
    id: id == null ? undefined : String(id),
    from_me: parseBoolean(fromMe),
    is_from_me: parseBoolean(fromMe),
    created_at: typeof timestamp === "number" ? new Date(timestamp).toISOString() : timestamp,
  }
}

function parseWatchOptions(rawArgs) {
  const options = {
    chatIds: [],
    sinceRowid: 0,
    pollMs: Number.isFinite(defaultWatchPollMs) && defaultWatchPollMs > 0 ? defaultWatchPollMs : 1500,
  }

  for (let index = 1; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]
    const next = rawArgs[index + 1]

    if (arg === "--chat-id" || arg === "--chat") {
      if (next !== undefined) options.chatIds.push(String(next))
      index += 1
      continue
    }

    if (arg === "--participants") {
      if (next !== undefined) {
        options.chatIds.push(
          ...String(next)
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        )
      }
      index += 1
      continue
    }

    if (arg === "--since-rowid") {
      if (next !== undefined) {
        const parsed = Number.parseInt(next, 10)
        if (Number.isFinite(parsed) && parsed > 0) options.sinceRowid = parsed
      }
      index += 1
      continue
    }

    if (arg === "--debounce") {
      if (next !== undefined) {
        const parsed = Number.parseInt(next, 10)
        if (Number.isFinite(parsed) && parsed > 0) options.pollMs = parsed
      }
      index += 1
    }
  }

  return options
}

function mapChatsArgs(rawArgs) {
  const mapped = ["chats", "list"]
  const includeJson = rawArgs.includes("--json")

  for (let index = 1; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]
    const next = rawArgs[index + 1]

    if (arg === "--json" || !arg.startsWith("--")) continue

    if (arg === "--limit") {
      if (next !== undefined) mapped.push("--limit", next)
      index += 1
      continue
    }

    mapped.push(arg)
    if (next !== undefined && !next.startsWith("--")) {
      mapped.push(next)
      index += 1
    }
  }

  if (includeJson && !mapped.includes("--json")) mapped.push("--json")
  return mapped
}

function mapHistoryArgs(rawArgs) {
  let chatId = ""
  const mapped = ["messages", "list"]
  const includeJson = rawArgs.includes("--json")

  for (let index = 1; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]
    const next = rawArgs[index + 1]

    if (arg === "--chat-id" || arg === "--chat") {
      if (next !== undefined) chatId = next
      index += 1
      continue
    }

    if (arg === "--start" || arg === "--from" || arg === "--after") {
      if (next !== undefined) mapped.push("--after", next)
      index += 1
      continue
    }

    if (arg === "--end" || arg === "--before" || arg === "--until") {
      if (next !== undefined) mapped.push("--before", next)
      index += 1
      continue
    }

    if (arg === "--json") continue

    if (arg.startsWith("--")) {
      if (next !== undefined) {
        mapped.push(arg, next)
        index += 1
      } else {
        mapped.push(arg)
      }
      continue
    }

    if (!chatId) chatId = arg
  }

  if (chatId) mapped.push(chatId)
  if (includeJson && !mapped.includes("--json")) mapped.push("--json")
  return mapped
}

function mapSendArgs(rawArgs) {
  const mapped = {
    includeJson: rawArgs.includes("--json"),
    chatId: "",
    text: "",
    replyTo: "",
  }

  for (let index = 1; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]
    const next = rawArgs[index + 1]

    if (arg === "--chat-id" || arg === "--to" || arg === "--chat") {
      if (next !== undefined) mapped.chatId = String(next)
      index += 1
      continue
    }

    if (arg === "--text" || arg === "--body") {
      if (next !== undefined) mapped.text = String(next)
      index += 1
      continue
    }

    if (arg === "--reply-to") {
      if (next !== undefined) mapped.replyTo = String(next)
      index += 1
      continue
    }

    if (arg.startsWith("--")) {
      if (next !== undefined && !next.startsWith("--")) index += 1
      continue
    }

    if (!mapped.chatId) {
      mapped.chatId = String(arg)
      continue
    }

    if (!mapped.text) mapped.text = String(arg)
  }

  return mapped
}

function mapCommand(rawArgs) {
  if (!rawArgs.length) return { name: "passthrough", args: rawArgs }

  switch (rawArgs[0]) {
    case "watch":
      return { name: "watch", args: rawArgs }
    case "chats":
      return { name: "chats", args: mapChatsArgs(rawArgs) }
    case "history":
      return { name: "history", args: mapHistoryArgs(rawArgs) }
    case "send":
      return { name: "send", args: mapSendArgs(rawArgs) }
    default:
      return { name: "passthrough", args: rawArgs }
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readPidFile(filePath) {
  if (!existsSync(filePath)) return null

  const parsed = Number.parseInt(readFileSync(filePath, "utf8").trim(), 10)
  if (Number.isFinite(parsed) && parsed > 0 && isProcessAlive(parsed)) return parsed

  try {
    unlinkSync(filePath)
  } catch {}

  return null
}

function ensureControllerDirs() {
  mkdirSync(controllerRequestsDir, { recursive: true })
}

function readControllerPid() {
  return readPidFile(controllerPidPath)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForControllerReady(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const pid = readControllerPid()
    if (pid) return pid
    await sleep(200)
  }

  return null
}

function spawnController() {
  const child = spawn(nodeBin, [controllerScript], {
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
  })

  child.stderr.pipe(process.stderr)

  child.on("error", (error) => {
    process.stderr.write(`${error.message}\n`)
  })

  return child
}

function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function queryDb(sql) {
  if (!existsSync(wuDbPath)) return []

  const result = spawnSync("sqlite3", ["-json", wuDbPath, sql], {
    env: process.env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  })

  if (result.error) throw result.error
  if ((result.status ?? 0) !== 0) {
    throw new Error(result.stderr?.trim() || `sqlite3 exited with status ${result.status}`)
  }

  const text = result.stdout?.trim()
  if (!text) return []

  return JSON.parse(text)
}

function readMaxRowId() {
  const rows = queryDb("SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM messages;")
  return Number.parseInt(String(rows[0]?.max_rowid ?? "0"), 10) || 0
}

function queryWatchRows(lastRowid, options) {
  const clauses = [`rowid > ${Math.max(0, lastRowid)}`]

  if (options.chatIds.length === 1) {
    clauses.push(`chat_jid = ${sqlQuote(options.chatIds[0])}`)
  } else if (options.chatIds.length > 1) {
    clauses.push(`chat_jid IN (${options.chatIds.map(sqlQuote).join(", ")})`)
  }

  const sql = `
    SELECT
      rowid,
      id,
      chat_jid,
      sender_jid,
      sender_name,
      body,
      type,
      timestamp,
      is_from_me,
      created_at
    FROM messages
    WHERE ${clauses.join(" AND ")}
    ORDER BY rowid ASC;
  `

  return queryDb(sql)
}

function mapDbRowToWatchEvent(row) {
  const timestampSeconds = Number.parseInt(String(row.timestamp ?? 0), 10) || 0
  const createdAt = timestampSeconds > 0 ? new Date(timestampSeconds * 1000).toISOString() : undefined

  return {
    chat_id: row.chat_jid == null ? "" : String(row.chat_jid),
    text: row.body ?? "",
    body: row.body ?? "",
    guid: row.id == null ? "" : String(row.id),
    id: row.id == null ? "" : String(row.id),
    from_me: parseBoolean(row.is_from_me),
    is_from_me: parseBoolean(row.is_from_me),
    created_at: createdAt,
    timestamp: row.timestamp,
    sender_jid: row.sender_jid ?? "",
    sender_name: row.sender_name ?? "",
    type: row.type ?? "",
    rowid: row.rowid,
  }
}

async function runControllerBackedWatch(rawArgs) {
  const options = parseWatchOptions(rawArgs)
  let stopping = false
  let controllerChild = null
  let ownsController = false
  let pollTimer = null
  let lastRowid = options.sinceRowid > 0 ? options.sinceRowid : 0

  const stop = (code = 0, signal = "SIGTERM") => {
    if (stopping) return
    stopping = true

    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }

    if (ownsController && controllerChild && controllerChild.exitCode === null) {
      try {
        controllerChild.kill(signal)
      } catch {}
    }

    process.exit(code)
  }

  if (!lastRowid) {
    try {
      lastRowid = readMaxRowId()
    } catch (error) {
      process.stderr.write(`${error.message}\n`)
    }
  }

  const existingPid = readControllerPid()

  if (existingPid) {
    process.stderr.write(`Using existing WhatsApp controller PID ${existingPid}\n`)
  } else {
    ensureControllerDirs()
    controllerChild = spawnController()
    ownsController = true
    const controllerPid = await waitForControllerReady()

    if (!controllerPid) {
      stop(1)
      return
    }
  }

  const poll = () => {
    try {
      const rows = queryWatchRows(lastRowid, options)
      for (const row of rows) {
        const numericRowId = Number.parseInt(String(row.rowid ?? 0), 10) || lastRowid
        if (numericRowId > lastRowid) lastRowid = numericRowId
        process.stdout.write(`${JSON.stringify(mapDbRowToWatchEvent(row))}\n`)
      }
    } catch (error) {
      process.stderr.write(`${error.message}\n`)
    }
  }

  pollTimer = setInterval(poll, Math.max(250, options.pollMs))
  poll()

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => stop(0, signal))
  }
}

function makeRequestId() {
  return `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`
}

async function waitForResponseFile(responsePath, controllerPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (existsSync(responsePath)) {
      const payload = JSON.parse(readFileSync(responsePath, "utf8"))
      try {
        unlinkSync(responsePath)
      } catch {}
      return payload
    }

    if (!isProcessAlive(controllerPid)) {
      throw new Error("WhatsApp controller stopped before responding")
    }

    await sleep(200)
  }

  throw new Error("Timed out waiting for WhatsApp controller response")
}

async function runControllerSend(mappedArgs) {
  const controllerPid = readControllerPid()

  if (!controllerPid) {
    throw new Error("WhatsApp controller is not running")
  }

  if (!mappedArgs.chatId) {
    throw new Error("Provide a chat id")
  }

  if (!mappedArgs.text) {
    throw new Error("Provide message text")
  }

  ensureControllerDirs()

  const requestId = makeRequestId()
  const requestPath = join(controllerRequestsDir, `${requestId}.request.json`)
  const responsePath = join(controllerRequestsDir, `${requestId}.response.json`)
  const timeoutMs = Number.isFinite(defaultSendTimeoutMs) && defaultSendTimeoutMs > 0 ? defaultSendTimeoutMs : 45000

  writeFileSync(
    requestPath,
    JSON.stringify(
      {
        id: requestId,
        action: "send-text",
        chatId: mappedArgs.chatId,
        text: mappedArgs.text,
        replyTo: mappedArgs.replyTo || null,
        responsePath,
        timeoutMs,
      },
      null,
      2,
    ),
  )

  const response = await waitForResponseFile(responsePath, controllerPid, timeoutMs + 5000)

  if (!response?.ok) {
    throw new Error(response?.error || "WhatsApp controller send failed")
  }

  if (mappedArgs.includeJson) {
    process.stdout.write(`${JSON.stringify(response.result ?? response)}\n`)
  } else {
    process.stdout.write(`Sent: ${response.result?.id ?? "ok"}\n`)
  }
}

async function run(mappedCommand) {
  if (mappedCommand.name === "watch") {
    await runControllerBackedWatch(mappedCommand.args)
    return
  }

  if (mappedCommand.name === "send") {
    await runControllerSend(mappedCommand.args)
    return
  }

  const child = spawnSync(cli, mappedCommand.args, {
    env: process.env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  })

  if (child.error) throw child.error
  if (child.stdout) process.stdout.write(child.stdout)
  if (child.stderr) process.stderr.write(child.stderr)
  process.exit(child.status ?? 0)
}

try {
  await run(mapCommand(args))
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

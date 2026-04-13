#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const cliPath = process.env.WHATSAPP_REAL_BIN ?? process.env.WHATSAPP_BIN ?? "wu"
const scriptPath = fileURLToPath(import.meta.url)
const scriptDir = dirname(scriptPath)
const bundledWuPackageRoot = process.env.WHATSAPP_PACKAGE_ROOT ?? ""
const nodeDistRoot =
  bundledWuPackageRoot.trim() !== ""
    ? resolve(bundledWuPackageRoot, "dist")
    : resolve(dirname(realpathSync(cliPath)), "..")
const wuHome = process.env.WU_HOME ?? join(homedir(), ".wu")
const controllerHome = join(wuHome, "owpenbot-controller")
const controllerPidPath = join(controllerHome, "controller.pid")
const controllerRequestsDir = join(controllerHome, "requests")
const requestPollMs = Number.parseInt(process.env.WHATSAPP_CONTROLLER_POLL_MS ?? "250", 10)
const confirmationTimeoutMs = Number.parseInt(process.env.WHATSAPP_SEND_CONFIRM_TIMEOUT_MS ?? "30000", 10)

const { ReconnectingConnection } = await import(pathToFileURL(resolve(nodeDistRoot, "core/connection.js")).href)
const { startListener } = await import(pathToFileURL(resolve(nodeDistRoot, "core/listener.js")).href)
const { sendText } = await import(pathToFileURL(resolve(nodeDistRoot, "core/sender.js")).href)
const { loadConfig } = await import(pathToFileURL(resolve(nodeDistRoot, "config/schema.js")).href)
const { acquireLock, releaseLock } = await import(pathToFileURL(resolve(nodeDistRoot, "core/lock.js")).href)
const { closeDb } = await import(pathToFileURL(resolve(nodeDistRoot, "db/database.js")).href)

const config = loadConfig()
const recentOutgoing = []
const maxRecentOutgoing = 200
const pendingConfirmations = new Map()
const queuedRequestPaths = []
const queuedRequestSet = new Set()
let controller = null
let currentSock = null
let connected = false
let processing = false
let stopping = false
let requestTimer = null

function log(message) {
  process.stderr.write(`[whatsapp-controller] ${message}\n`)
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function ensureControllerDirs() {
  mkdirSync(controllerRequestsDir, { recursive: true })
}

function readControllerPid() {
  if (!existsSync(controllerPidPath)) return null

  const parsed = Number.parseInt(readFileSync(controllerPidPath, "utf8").trim(), 10)
  if (Number.isFinite(parsed) && parsed > 0 && isProcessAlive(parsed)) return parsed

  try {
    unlinkSync(controllerPidPath)
  } catch {}

  return null
}

function writeControllerPid() {
  writeFileSync(controllerPidPath, `${process.pid}\n`)
}

function cleanupControllerPid() {
  try {
    const existing = readControllerPid()
    if (existing === process.pid) unlinkSync(controllerPidPath)
  } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractText(message) {
  const payload = message?.message ?? {}

  return (
    payload.conversation ??
    payload.extendedTextMessage?.text ??
    payload.imageMessage?.caption ??
    payload.videoMessage?.caption ??
    payload.documentMessage?.caption ??
    null
  )
}

function normalizeOutgoingEvent(message) {
  if (!message?.key?.fromMe) return null

  const chatId = message.key.remoteJid
  const id = message.key.id
  const text = extractText(message)

  if (!chatId || !id || typeof text !== "string" || text.trim() === "") return null

  const timestamp =
    typeof message.messageTimestamp === "number"
      ? message.messageTimestamp
      : typeof message.messageTimestamp === "object" && message.messageTimestamp != null
        ? Number(message.messageTimestamp)
        : Math.floor(Date.now() / 1000)

  return {
    chatId: String(chatId),
    id: String(id),
    text,
    timestamp,
  }
}

function rememberOutgoing(event) {
  recentOutgoing.push(event)
  if (recentOutgoing.length > maxRecentOutgoing) recentOutgoing.shift()
}

function settleConfirmation(token, error, event) {
  const pending = pendingConfirmations.get(token)
  if (!pending) return

  clearTimeout(pending.timer)
  pendingConfirmations.delete(token)

  if (error) {
    pending.reject(error)
    return
  }

  pending.resolve(event)
}

function matchPendingConfirmations(event) {
  for (const [token, pending] of pendingConfirmations.entries()) {
    const sameChat = pending.chatId === event.chatId
    const sameText = pending.text === event.text
    const sameId = pending.resultId !== "" && pending.resultId === event.id

    if ((sameChat && sameText) || sameId) {
      settleConfirmation(token, null, event)
    }
  }
}

function findRecentOutgoingMatch(chatId, text, resultId) {
  for (let index = recentOutgoing.length - 1; index >= 0; index -= 1) {
    const event = recentOutgoing[index]
    const sameChat = event.chatId === chatId
    const sameText = event.text === text
    const sameId = resultId !== "" && event.id === resultId

    if ((sameChat && sameText) || sameId) return event
  }

  return null
}

function waitForOutboundConfirmation(chatId, text, resultId, timeoutMs) {
  const immediate = findRecentOutgoingMatch(chatId, text, resultId)
  if (immediate) return Promise.resolve(immediate)

  return new Promise((resolve, reject) => {
    const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const timer = setTimeout(() => {
      settleConfirmation(token, new Error(`Timed out waiting for outbound WhatsApp confirmation in ${chatId}`))
    }, Math.max(1000, timeoutMs))

    pendingConfirmations.set(token, {
      chatId,
      text,
      resultId,
      resolve,
      reject,
      timer,
    })
  })
}

function handleMessagesUpsert(update) {
  for (const message of update?.messages ?? []) {
    const event = normalizeOutgoingEvent(message)
    if (!event) continue
    rememberOutgoing(event)
    matchPendingConfirmations(event)
  }
}

function attachSocketObservers(sock) {
  sock.ev.on("messages.upsert", handleMessagesUpsert)
}

function queueRequestPath(filePath) {
  if (queuedRequestSet.has(filePath)) return
  queuedRequestSet.add(filePath)
  queuedRequestPaths.push(filePath)
}

function scanRequestDir() {
  ensureControllerDirs()

  for (const name of readdirSync(controllerRequestsDir)) {
    if (!name.endsWith(".request.json")) continue
    queueRequestPath(join(controllerRequestsDir, name))
  }
}

function writeResponse(filePath, payload) {
  writeFileSync(filePath, JSON.stringify(payload, null, 2))
}

async function processRequest(filePath) {
  const request = JSON.parse(readFileSync(filePath, "utf8"))
  const responsePath = request.responsePath ?? join(controllerRequestsDir, `${request.id}.response.json`)

  try {
    if (request.action !== "send-text") {
      throw new Error(`Unsupported action: ${request.action}`)
    }

    if (!currentSock || !connected) {
      throw new Error("WhatsApp controller is not connected")
    }

    const result = await sendText(
      currentSock,
      String(request.chatId),
      String(request.text),
      config,
      request.replyTo ? { replyTo: String(request.replyTo) } : undefined,
    )

    const confirmed = await waitForOutboundConfirmation(
      String(request.chatId),
      String(request.text),
      String(result?.key?.id ?? ""),
      Number.isFinite(request.timeoutMs) ? request.timeoutMs : confirmationTimeoutMs,
    )

    writeResponse(responsePath, {
      ok: true,
      result: {
        id: result?.key?.id ?? null,
        timestamp: result?.messageTimestamp ?? null,
      },
      confirmed,
    })
  } catch (error) {
    writeResponse(responsePath, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    queuedRequestSet.delete(filePath)
    rmSync(filePath, { force: true })
  }
}

async function processQueue() {
  if (processing || !connected || !currentSock) return
  processing = true

  try {
    while (!stopping && connected && currentSock && queuedRequestPaths.length > 0) {
      const filePath = queuedRequestPaths.shift()
      if (!filePath) break
      await processRequest(filePath)
    }
  } finally {
    processing = false
  }
}

async function startController() {
  ensureControllerDirs()

  const existingPid = readControllerPid()
  if (existingPid && existingPid !== process.pid) {
    throw new Error(`WhatsApp controller already running (PID ${existingPid})`)
  }

  acquireLock()
  writeControllerPid()

  controller = new ReconnectingConnection({
    isDaemon: true,
    quiet: true,
    onReady: (sock) => {
      currentSock = sock
      connected = true
      startListener(sock, { config, quiet: true })
      attachSocketObservers(sock)
      log("connected")
      void processQueue()
    },
    onDisconnect: () => {
      connected = false
      currentSock = null
      log("disconnected")
    },
    onReconnecting: (delayMs) => {
      log(`reconnecting in ${Math.round(delayMs / 1000)}s`)
    },
    onFatal: (reason) => {
      log(`fatal: ${reason}`)
    },
  })

  await controller.start()
  log("ready")

  requestTimer = setInterval(() => {
    scanRequestDir()
    void processQueue()
  }, Math.max(100, requestPollMs))
}

async function stopController() {
  if (stopping) return
  stopping = true

  if (requestTimer) {
    clearInterval(requestTimer)
    requestTimer = null
  }

  for (const token of pendingConfirmations.keys()) {
    settleConfirmation(token, new Error("WhatsApp controller is shutting down"))
  }

  if (controller) {
    await controller.stop()
  }

  closeDb()
  releaseLock()
  cleanupControllerPid()
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void stopController().finally(() => process.exit(0))
  })
}

process.on("exit", () => {
  cleanupControllerPid()
})

try {
  await startController()
  while (!stopping) {
    await sleep(1000)
  }
} catch (error) {
  log(error instanceof Error ? error.message : String(error))
  await stopController()
  process.exit(1)
}

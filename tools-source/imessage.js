import { execFile } from "node:child_process"
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { tool } from "@opencode-ai/plugin"

const execFileAsync = promisify(execFile)
const IMSG_BIN = process.env.IMSG_BIN ?? "imsg"
const OPENCODE_HOME = join(homedir(), ".config", "opencode")
const OC_STATE_DIR = join(OPENCODE_HOME, "state", "imessage-oc")
const SIGNAL_STATE_DIR = join(OPENCODE_HOME, "state", "imessage-signal")
const OC_PENDING_MAX_AGE_MS = 15 * 60 * 1000
const REQUEST_KIND_CONFIG_DEFAULTS = {
  rc: {
    incomingPrefix: "@RC",
    outgoingPrefix: "RC:",
  },
  drboz: {
    incomingPrefix: "@DRBOZ",
    outgoingPrefix: "DRBOZ:",
  },
}
const REQUEST_KIND_CONFIG = resolveRequestKindConfig(process.env.OWPENBOT_REQUEST_KINDS ?? "")

function normalizeRequestKindConfig(rawConfig = "") {
  const trimmed = String(rawConfig).trim()

  if (trimmed === "") {
    return { ...REQUEST_KIND_CONFIG_DEFAULTS }
  }

  let parsedConfig

  try {
    parsedConfig = JSON.parse(trimmed)
  } catch (error) {
    throw new Error(`Invalid JSON for OWPENBOT_REQUEST_KINDS: ${error.message}`)
  }

  if (!parsedConfig || typeof parsedConfig !== "object" || Array.isArray(parsedConfig)) {
    throw new Error("OWPENBOT_REQUEST_KINDS must be a JSON object mapping request kinds to { incomingPrefix, outgoingPrefix }")
  }

  const normalized = {}
  const incomingPrefixes = new Set()
  const outgoingPrefixes = new Set()

  for (const [requestKind, config] of Object.entries(parsedConfig)) {
    const normalizedRequestKind = String(requestKind).trim()
    if (!normalizedRequestKind) {
      throw new Error("OWPENBOT_REQUEST_KINDS contains an empty request kind key")
    }

    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error(`OWPENBOT_REQUEST_KINDS.${normalizedRequestKind} must be an object`)
    }

    const incomingPrefix =
      typeof config.incomingPrefix === "string" ? config.incomingPrefix.trim() : ""
    const outgoingPrefix =
      typeof config.outgoingPrefix === "string" ? config.outgoingPrefix.trim() : ""

    if (!incomingPrefix) {
      throw new Error(`OWPENBOT_REQUEST_KINDS.${normalizedRequestKind}.incomingPrefix must be a non-empty string`)
    }

    if (!outgoingPrefix) {
      throw new Error(`OWPENBOT_REQUEST_KINDS.${normalizedRequestKind}.outgoingPrefix must be a non-empty string`)
    }

    if (incomingPrefixes.has(incomingPrefix)) {
      throw new Error(`OWPENBOT_REQUEST_KINDS has duplicate incomingPrefix: ${incomingPrefix}`)
    }

    if (outgoingPrefixes.has(outgoingPrefix)) {
      throw new Error(`OWPENBOT_REQUEST_KINDS has duplicate outgoingPrefix: ${outgoingPrefix}`)
    }

    incomingPrefixes.add(incomingPrefix)
    outgoingPrefixes.add(outgoingPrefix)

    normalized[normalizedRequestKind] = {
      incomingPrefix,
      outgoingPrefix,
    }
  }

  if (Object.keys(normalized).length === 0) {
    throw new Error("OWPENBOT_REQUEST_KINDS must contain at least one request kind")
  }

  return normalized
}

function resolveRequestKindConfig(rawConfig) {
  return normalizeRequestKindConfig(rawConfig)
}

async function runImsg(args) {
  try {
    const { stdout, stderr } = await execFileAsync(IMSG_BIN, args, {
      maxBuffer: 10 * 1024 * 1024,
    })

    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    }
  } catch (error) {
    const stderr = error.stderr?.toString().trim()
    const stdout = error.stdout?.toString().trim()
    const message = [stderr, stdout, error.message].filter(Boolean).join("\n")

    throw new Error(message || "imsg command failed")
  }
}

function parseImsgOutput(text) {
  if (!text) return null

  const trimmed = text.trim()

  try {
    return JSON.parse(trimmed)
  } catch {}

  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length === 0) return null

  const parsed = []

  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line))
    } catch {
      return trimmed
    }
  }

  return parsed
}

function stripAttributedBodyLengthPrefix(text) {
  if (typeof text !== "string" || text.length < 4) return text

  const characters = Array.from(text)
  if (characters.length < 4) return text

  const [marker, lowByte, highByte] = characters
  const markerCode = marker.codePointAt(0)
  const lowByteCode = lowByte.codePointAt(0)
  const highByteCode = highByte.codePointAt(0)

  if (markerCode !== 0xfffd) return text
  if (highByteCode > 0xff) return text
  if (lowByteCode > 0xff && lowByteCode !== 0xfffd) return text

  const remainder = characters.slice(3).join("")
  if (!remainder) return text

  const firstRemainderCode = remainder.codePointAt(0)
  if (firstRemainderCode === undefined || firstRemainderCode < 0x20 || firstRemainderCode === 0x7f) {
    return text
  }

  if (lowByteCode !== 0xfffd) {
    const expectedLength = lowByteCode + highByteCode * 256
    if (expectedLength !== remainder.length) return text
  } else {
    const minExpectedLength = 128 + highByteCode * 256
    const maxExpectedLength = 255 + highByteCode * 256
    if (remainder.length < minExpectedLength || remainder.length > maxExpectedLength) {
      return text
    }
  }

  return remainder
}

function sanitizeImsgRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record

  if (typeof record.text === "string") {
    return {
      ...record,
      text: stripAttributedBodyLengthPrefix(record.text),
    }
  }

  return record
}

function parseImsgLines(text) {
  const parsed = parseImsgOutput(text)

  if (parsed === null) return []
  if (Array.isArray(parsed)) return parsed.map((entry) => sanitizeImsgRecord(entry))

  return [sanitizeImsgRecord(parsed)]
}

function formatResult(payload) {
  return JSON.stringify(payload, null, 2)
}

function encodeStateKey(value) {
  return Buffer.from(value, "utf8").toString("hex")
}

function getStateHandledPath(stateDir, key) {
  return join(stateDir, `${encodeStateKey(key)}.json`)
}

function getStatePendingPath(stateDir, key) {
  return join(stateDir, `${encodeStateKey(key)}.pending.json`)
}

function getOcHandledPath(messageGuid) {
  return getStateHandledPath(OC_STATE_DIR, messageGuid)
}

function getOcPendingPath(messageGuid) {
  return getStatePendingPath(OC_STATE_DIR, messageGuid)
}

function getSignalHandledPath(dedupeKey) {
  return getStateHandledPath(SIGNAL_STATE_DIR, dedupeKey)
}

function getSignalPendingPath(dedupeKey) {
  return getStatePendingPath(SIGNAL_STATE_DIR, dedupeKey)
}

function getRequestKindConfig(requestKind) {
  const config = REQUEST_KIND_CONFIG[requestKind]

  if (!config) {
    throw new Error(`Unsupported requestKind: ${requestKind}`)
  }

  return config
}

function parseRequestText(text) {
  if (typeof text !== "string") return null

  const trimmed = text.trim()

  for (const [requestKind, config] of Object.entries(REQUEST_KIND_CONFIG)) {
    if (!trimmed.startsWith(config.incomingPrefix)) continue

    return {
      requestKind,
      requestPrefix: config.incomingPrefix,
      responsePrefix: config.outgoingPrefix,
    }
  }

  return null
}

function resolveRequestKind(requestKind, requestText) {
  if (requestKind) {
    getRequestKindConfig(requestKind)
    return requestKind
  }

  return parseRequestText(requestText)?.requestKind ?? "rc"
}

function formatOcReply(replyText, requestKind = "rc") {
  return `${getRequestKindConfig(requestKind).outgoingPrefix} ${replyText.trim()}`
}

async function pathExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"))
}

async function ensureStateDir(stateDir) {
  await mkdir(stateDir, { recursive: true })
}

async function isPendingClaimStale(filePath) {
  try {
    const info = await stat(filePath)
    return Date.now() - info.mtimeMs > OC_PENDING_MAX_AGE_MS
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

async function releasePendingClaim(filePath) {
  await rm(filePath, { force: true })
}

async function claimStateKey(stateDir, key, pendingRecord) {
  await ensureStateDir(stateDir)

  const handledPath = getStateHandledPath(stateDir, key)
  if (await pathExists(handledPath)) {
    return {
      claimed: false,
      reason: "already_handled",
      handledPath,
      record: await readJsonFile(handledPath),
    }
  }

  const pendingPath = getStatePendingPath(stateDir, key)

  try {
    await writeFile(pendingPath, JSON.stringify(pendingRecord, null, 2), { flag: "wx" })

    return {
      claimed: true,
      handledPath,
      pendingPath,
    }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error

    if (await pathExists(handledPath)) {
      return {
        claimed: false,
        reason: "already_handled",
        handledPath,
        record: await readJsonFile(handledPath),
      }
    }

    if (await isPendingClaimStale(pendingPath)) {
      await releasePendingClaim(pendingPath)
      return claimStateKey(stateDir, key, pendingRecord)
    }

    return {
      claimed: false,
      reason: "already_pending",
      handledPath,
      pendingPath,
    }
  }
}

async function claimOcMessage(messageGuid, pendingRecord) {
  return await claimStateKey(OC_STATE_DIR, messageGuid, pendingRecord)
}

async function claimSignal(dedupeKey, pendingRecord) {
  return await claimStateKey(SIGNAL_STATE_DIR, dedupeKey, pendingRecord)
}

function getOcRecordSortTime(record, fallbackTimeMs) {
  for (const value of [record.handledAt, record.claimedAt]) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }

  return fallbackTimeMs
}

async function readOcStateRecord(filePath, extra = {}) {
  const record = await readJsonFile(filePath)
  return {
    ...record,
    statePath: filePath,
    ...extra,
  }
}

async function getOcMessageStatus(messageGuid) {
  const handledPath = getOcHandledPath(messageGuid)
  if (await pathExists(handledPath)) {
    return {
      found: true,
      status: "handled",
      messageGuid,
      record: await readOcStateRecord(handledPath),
    }
  }

  const pendingPath = getOcPendingPath(messageGuid)
  if (await pathExists(pendingPath)) {
    return {
      found: true,
      status: "pending",
      messageGuid,
      record: await readOcStateRecord(pendingPath, {
        stale: await isPendingClaimStale(pendingPath),
      }),
    }
  }

  return {
    found: false,
    status: "not_found",
    messageGuid,
  }
}

async function listOcRecords({ includePending, limit }) {
  if (!(await pathExists(OC_STATE_DIR))) {
    return {
      total: 0,
      records: [],
    }
  }

  const fileNames = (await readdir(OC_STATE_DIR)).filter((name) => {
    if (name.endsWith(".pending.json")) return includePending
    return name.endsWith(".json")
  })

  const records = await Promise.all(
    fileNames.map(async (name) => {
      const filePath = join(OC_STATE_DIR, name)
      const info = await stat(filePath)
      const isPending = name.endsWith(".pending.json")

      try {
        const record = await readOcStateRecord(filePath, {
          stale: isPending ? await isPendingClaimStale(filePath) : false,
        })

        return {
          ...record,
          _sortTime: getOcRecordSortTime(record, info.mtimeMs),
        }
      } catch (error) {
        return {
          status: "invalid",
          statePath: filePath,
          error: error.message,
          stale: isPending ? await isPendingClaimStale(filePath) : false,
          _sortTime: info.mtimeMs,
        }
      }
    }),
  )

  records.sort((left, right) => right._sortTime - left._sortTime)

  return {
    total: records.length,
    records: records.slice(0, limit).map(({ _sortTime, ...record }) => record),
  }
}

function pushOptional(args, flag, value) {
  if (value === undefined || value === null || value === "") return
  args.push(flag, String(value))
}

function appendParticipantFilter(args, participants) {
  if (!participants || participants.length === 0) return
  args.push("--participants", participants.join(","))
}

function normalizeTargetValue(value) {
  if (value === undefined || value === null) return undefined

  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed === "" ? undefined : trimmed
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined
  }

  return value
}

function resolveSendTarget(targetType, targetValue) {
  const normalizedValue = normalizeTargetValue(targetValue)

  if (normalizedValue === undefined) {
    throw new Error("Provide a non-empty targetValue")
  }

  const targetFlags = {
    to: "--to",
    chatId: "--chat-id",
    chatIdentifier: "--chat-identifier",
    chatGuid: "--chat-guid",
  }

  if (targetType === "chatId") {
    const parsed = Number.parseInt(String(normalizedValue), 10)

    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error("chatId targetValue must be a positive integer")
    }

    return {
      type: targetType,
      flag: targetFlags[targetType],
      value: String(parsed),
    }
  }

  return {
    type: targetType,
    flag: targetFlags[targetType],
    value: String(normalizedValue),
  }
}

function normalizeSingleLineText(value) {
  if (typeof value !== "string") return ""
  return value.replace(/\s+/g, " ").trim()
}

function formatLocalSignalDateTime(dateInput) {
  const parsed = new Date(dateInput)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("dateReceived must be a valid date string")
  }

  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(parsed)

  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]))
  return `${values.day} ${values.month} ${values.hour}:${values.minute}`
}

function formatEmailSignalText({ dateReceived, from, subject, summaryLines }) {
  const formattedLines = []
  const formattedDateTime = formatLocalSignalDateTime(dateReceived)
  const formattedFrom = normalizeSingleLineText(from)
  const formattedSubject = normalizeSingleLineText(subject)
  const normalizedSummaryLines = Array.isArray(summaryLines)
    ? summaryLines.map((line) => normalizeSingleLineText(line)).filter(Boolean).slice(0, 3)
    : []

  formattedLines.push("RC: incoming relevant email")
  formattedLines.push(formattedDateTime)

  if (formattedFrom) {
    formattedLines.push(`From: ${formattedFrom}`)
  }

  if (formattedSubject) {
    formattedLines.push(`Subject: ${formattedSubject}`)
  }

  for (const line of normalizedSummaryLines) {
    formattedLines.push(`- ${line.replace(/^-+\s*/, "")}`)
  }

  return formattedLines.join("\n")
}

async function executeSignalOnce({ confirmed, dedupeKey, chatId, text, service, region, recordExtras = {} }) {
  if (!confirmed) {
    throw new Error("Refusing to send: user confirmation is required")
  }

  const trimmedText = text.trim()
  const claimedAt = new Date().toISOString()
  const claim = await claimSignal(dedupeKey, {
    status: "pending",
    dedupeKey,
    chatId,
    text: trimmedText,
    claimedAt,
    ...recordExtras,
  })

  if (!claim.claimed) {
    return formatResult({
      sent: false,
      skipped: true,
      reason: claim.reason,
      dedupeKey,
      statePath: claim.handledPath,
      record: claim.record ?? null,
    })
  }

  try {
    const command = ["send", "--chat-id", String(chatId), "--text", trimmedText, "--service", service, "--json"]
    pushOptional(command, "--region", region)

    const result = await runImsg(command)
    const handledAt = new Date().toISOString()
    const parsedResult = parseImsgOutput(result.stdout) ?? result.stdout
    const record = {
      status: "handled",
      dedupeKey,
      chatId,
      text: trimmedText,
      claimedAt,
      handledAt,
      service,
      result: parsedResult,
      ...recordExtras,
    }

    await writeFile(claim.handledPath, JSON.stringify(record, null, 2))
    await releasePendingClaim(claim.pendingPath)

    return formatResult({
      sent: true,
      skipped: false,
      dedupeKey,
      target: {
        type: "chatId",
        value: String(chatId),
      },
      text: trimmedText,
      service,
      result: parsedResult,
      statePath: claim.handledPath,
      stderr: result.stderr || null,
    })
  } catch (error) {
    await releasePendingClaim(claim.pendingPath)
    throw error
  }
}

function parseIncomingRequestMessage(message) {
  if (!message || typeof message !== "object") return false
  if (message.is_from_me === true) return false
  if (typeof message.guid !== "string" || message.guid.trim() === "") return null
  if (!Number.isInteger(message.chat_id) || message.chat_id <= 0) return null
  if (typeof message.text !== "string") return null

  const request = parseRequestText(message.text)
  if (!request) return null

  return {
    ...message,
    ...request,
  }
}

function getMessageSortTime(message) {
  const createdAt = Date.parse(message.created_at ?? message.createdAt ?? "")
  if (Number.isFinite(createdAt)) return createdAt
  if (Number.isFinite(message.id)) return message.id
  if (Number.isFinite(message.messageId)) return message.messageId
  return 0
}

async function listRcPendingRequests({ chatLimit, messageLimit, limit }) {
  const chatsResult = await runImsg(["chats", "--limit", String(chatLimit), "--json"])
  const recentChats = parseImsgLines(chatsResult.stdout)

  const chatHistories = await Promise.all(
    recentChats.map(async (chat) => {
      if (!Number.isInteger(chat.id) || chat.id <= 0) return []

      const result = await runImsg(["history", "--chat-id", String(chat.id), "--limit", String(messageLimit), "--json"])
      return parseImsgLines(result.stdout)
    }),
  )

  const candidates = chatHistories
    .flat()
    .map(parseIncomingRequestMessage)
    .filter(Boolean)

  const requests = []

  for (const message of candidates) {
    const status = await getOcMessageStatus(message.guid)
    const isStalePending = status.status === "pending" && status.record?.stale === true

    if (status.status === "handled") continue
    if (status.status === "pending" && !isStalePending) continue

      requests.push({
        chatId: message.chat_id,
        messageGuid: message.guid,
        messageId: Number.isFinite(message.id) ? message.id : null,
        requestKind: message.requestKind,
        requestPrefix: message.requestPrefix,
        responsePrefix: message.responsePrefix,
        requestText: message.text,
        sender: message.sender ?? null,
        createdAt: message.created_at ?? null,
        status: isStalePending ? "stale_pending" : "new",
      })
  }

  requests.sort((left, right) => getMessageSortTime(right) - getMessageSortTime(left))

  return {
    total: requests.length,
    requests: requests.slice(0, limit),
  }
}

export const chats = tool({
  description: "List recent macOS Messages chats through the local imsg CLI.",
  args: {
    limit: tool.schema.number().int().min(1).max(100).default(20).describe("Maximum chats to return"),
  },
  async execute(args) {
    const command = ["chats", "--limit", String(args.limit), "--json"]
    const result = await runImsg(command)

    return formatResult({
      chats: parseImsgLines(result.stdout),
    })
  },
})

export const history = tool({
  description: "Read Messages history for a specific chat through the local imsg CLI.",
  args: {
    chatId: tool.schema.number().int().positive().describe("Chat row ID from imessage_chats"),
    limit: tool.schema.number().int().min(1).max(200).default(20).describe("Maximum messages to return"),
    includeAttachments: tool.schema.boolean().default(false).describe("Include attachment metadata"),
    participants: tool.schema.array(tool.schema.string()).optional().describe("Optional participant handle filters"),
    start: tool.schema.string().optional().describe("Optional ISO8601 inclusive start time"),
    end: tool.schema.string().optional().describe("Optional ISO8601 exclusive end time"),
  },
  async execute(args) {
    const command = ["history", "--chat-id", String(args.chatId), "--limit", String(args.limit), "--json"]

    if (args.includeAttachments) command.push("--attachments")
    appendParticipantFilter(command, args.participants)
    pushOptional(command, "--start", args.start)
    pushOptional(command, "--end", args.end)

    const result = await runImsg(command)

    return formatResult({
      chatId: args.chatId,
      messages: parseImsgLines(result.stdout),
    })
  },
})

export const send = tool({
  description: "Send a text message with the local imsg CLI after explicit user confirmation.",
  args: {
    confirmed: tool.schema.boolean().describe("Must be true only after the user explicitly asked to send this message"),
    text: tool.schema.string().min(1).describe("Message body to send"),
    targetType: tool.schema.enum(["to", "chatId", "chatIdentifier", "chatGuid"]).describe("How to target the message recipient"),
    targetValue: tool.schema.union([tool.schema.string(), tool.schema.number()]).describe("Target value. Use a phone number or email for 'to', digits for 'chatId', or the raw identifier/guid for the other target types"),
    service: tool.schema.enum(["auto", "imessage", "sms"]).default("auto").describe("Preferred delivery service"),
    region: tool.schema.string().optional().describe("Default region for phone normalization, for example US or NL"),
  },
  async execute(args) {
    if (!args.confirmed) {
      throw new Error("Refusing to send: user confirmation is required")
    }

    const target = resolveSendTarget(args.targetType, args.targetValue)

    const command = ["send", target.flag, target.value, "--text", args.text, "--service", args.service, "--json"]
    pushOptional(command, "--region", args.region)

    const result = await runImsg(command)

    return formatResult({
      sent: true,
      target: {
        type: target.type,
        value: target.value,
      },
      service: args.service,
      result: parseImsgOutput(result.stdout) ?? result.stdout,
      stderr: result.stderr || null,
    })
  },
})

export const signal_once = tool({
  description: "Send a text message to a specific chat at most once for a dedupe key.",
  args: {
    confirmed: tool.schema.boolean().describe("Must be true only after the user explicitly allowed these automated signal messages"),
    dedupeKey: tool.schema.string().min(1).describe("Stable key used to prevent duplicate signals, for example email:<rfc-message-id>"),
    chatId: tool.schema.number().int().positive().describe("Chat row ID to send the signal into"),
    text: tool.schema.string().min(1).describe("Full message body to send"),
    service: tool.schema.enum(["auto", "imessage", "sms"]).default("auto").describe("Preferred delivery service"),
    region: tool.schema.string().optional().describe("Default region for phone normalization, for example US or NL"),
  },
  async execute(args) {
    return await executeSignalOnce(args)
  },
})

export const signal_email_once = tool({
  description: "Send a formatted email self-alert to a specific chat at most once for a dedupe key.",
  args: {
    confirmed: tool.schema.boolean().describe("Must be true only after the user explicitly allowed these automated email signals"),
    dedupeKey: tool.schema.string().min(1).describe("Stable key used to prevent duplicate signals, for example email:<rfc-message-id>"),
    chatId: tool.schema.number().int().positive().describe("Chat row ID to send the signal into"),
    dateReceived: tool.schema.string().min(1).describe("Email received timestamp as an ISO8601 string or other parseable date string"),
    from: tool.schema.string().min(1).describe("Email sender display text"),
    subject: tool.schema.string().optional().describe("Email subject line"),
    summaryLines: tool.schema.array(tool.schema.string()).optional().describe("Up to three short summary lines; one fact per line"),
    service: tool.schema.enum(["auto", "imessage", "sms"]).default("auto").describe("Preferred delivery service"),
    region: tool.schema.string().optional().describe("Default region for phone normalization, for example US or NL"),
  },
  async execute(args) {
    const summaryLines = Array.isArray(args.summaryLines) ? args.summaryLines.slice(0, 3) : []
    const text = formatEmailSignalText({
      dateReceived: args.dateReceived,
      from: args.from,
      subject: args.subject,
      summaryLines,
    })

    return await executeSignalOnce({
      confirmed: args.confirmed,
      dedupeKey: args.dedupeKey,
      chatId: args.chatId,
      text,
      service: args.service,
      region: args.region,
      recordExtras: {
        signalKind: "email",
        dateReceived: args.dateReceived,
        from: normalizeSingleLineText(args.from),
        subject: normalizeSingleLineText(args.subject),
        summaryLines: summaryLines.map((line) => normalizeSingleLineText(line)).filter(Boolean),
      },
    })
  },
})

export const rc_pending = tool({
  description: "List incoming @RC or @DRBOZ messages that still need a reply.",
  args: {
    chatLimit: tool.schema.number().int().min(1).max(100).default(20).describe("Maximum recent chats to scan"),
    messageLimit: tool.schema.number().int().min(1).max(200).default(50).describe("Maximum recent messages to inspect per chat"),
    limit: tool.schema.number().int().min(1).max(200).default(20).describe("Maximum pending incoming trigger requests to return"),
  },
  async execute(args) {
    return formatResult(await listRcPendingRequests(args))
  },
})

export const oc_reply_once = tool({
  description: "Reply once to an incoming @RC or @DRBOZ message and persist handled state across OpenCode sessions.",
  args: {
    confirmed: tool.schema.boolean().describe("Must be true only after the user explicitly allowed incoming trigger auto-replies"),
    chatId: tool.schema.number().int().positive().describe("Chat row ID from imessage_history"),
    messageGuid: tool.schema.string().min(1).describe("GUID of the incoming trigger message being handled"),
    requestKind: tool.schema.enum(["rc", "drboz"]).optional().describe("Incoming trigger kind. Defaults to inferring from requestText, then rc"),
    replyText: tool.schema.string().min(1).describe("Reply body without the leading outgoing trigger prefix"),
    requestText: tool.schema.string().optional().describe("Original incoming @RC or @DRBOZ text for audit/debugging and request-kind inference"),
    service: tool.schema.enum(["auto", "imessage", "sms"]).default("auto").describe("Preferred delivery service"),
    region: tool.schema.string().optional().describe("Default region for phone normalization, for example US or NL"),
  },
  async execute(args) {
    if (!args.confirmed) {
      throw new Error("Refusing to send: user confirmation is required")
    }

    const requestKind = resolveRequestKind(args.requestKind, args.requestText)
    const requestConfig = getRequestKindConfig(requestKind)
    const replyText = args.replyText.trim()
    const outgoingText = formatOcReply(replyText, requestKind)
    const claimedAt = new Date().toISOString()
    const claim = await claimOcMessage(args.messageGuid, {
      status: "pending",
      messageGuid: args.messageGuid,
      chatId: args.chatId,
      requestKind,
      requestPrefix: requestConfig.incomingPrefix,
      responsePrefix: requestConfig.outgoingPrefix,
      requestText: args.requestText ?? null,
      replyText,
      outgoingText,
      claimedAt,
    })

    if (!claim.claimed) {
      return formatResult({
        sent: false,
        skipped: true,
        reason: claim.reason,
        messageGuid: args.messageGuid,
        statePath: claim.handledPath,
        record: claim.record ?? null,
      })
    }

    try {
      const command = ["send", "--chat-id", String(args.chatId), "--text", outgoingText, "--service", args.service, "--json"]
      pushOptional(command, "--region", args.region)

      const result = await runImsg(command)
      const handledAt = new Date().toISOString()
      const parsedResult = parseImsgOutput(result.stdout) ?? result.stdout
      const record = {
        status: "handled",
        messageGuid: args.messageGuid,
        chatId: args.chatId,
        requestKind,
        requestPrefix: requestConfig.incomingPrefix,
        responsePrefix: requestConfig.outgoingPrefix,
        requestText: args.requestText ?? null,
        replyText,
        outgoingText,
        claimedAt,
        handledAt,
        service: args.service,
        result: parsedResult,
      }

      await writeFile(claim.handledPath, JSON.stringify(record, null, 2))
      await releasePendingClaim(claim.pendingPath)

      return formatResult({
        sent: true,
        skipped: false,
        messageGuid: args.messageGuid,
        target: {
          type: "chatId",
          value: String(args.chatId),
        },
        text: outgoingText,
        service: args.service,
        result: parsedResult,
        statePath: claim.handledPath,
        stderr: result.stderr || null,
      })
    } catch (error) {
      await releasePendingClaim(claim.pendingPath)
      throw error
    }
  },
})

export const oc_status = tool({
  description: "Inspect persisted @RC/@DRBOZ reply-once state across OpenCode sessions.",
  args: {
    messageGuid: tool.schema.string().optional().describe("Optional GUID of a specific incoming trigger message to inspect"),
    limit: tool.schema.number().int().min(1).max(200).default(20).describe("Maximum records to return when listing recent trigger state"),
    includePending: tool.schema.boolean().default(true).describe("Include pending in-flight trigger reply claims when listing recent state"),
  },
  async execute(args) {
    if (args.messageGuid) {
      return formatResult({
        stateDir: OC_STATE_DIR,
        ...(await getOcMessageStatus(args.messageGuid)),
      })
    }

    const result = await listOcRecords({
      includePending: args.includePending,
      limit: args.limit,
    })

    return formatResult({
      stateDir: OC_STATE_DIR,
      includePending: args.includePending,
      ...result,
    })
  },
})

// OWPENbot-compatible aliases
export const owpenbot_chats = chats
export const owpenbot_history = history
export const owpenbot_send = send
export const owpenbot_pending = rc_pending
export const owpenbot_oc_reply_once = oc_reply_once
export const owpenbot_reply_once = oc_reply_once
export const owpenbot_status = oc_status
export const owpenbot_oc_status = oc_status

import { execFile } from "node:child_process"
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { tool } from "@opencode-ai/plugin"

const execFileAsync = promisify(execFile)
const WHATSAPP_BIN = process.env.WHATSAPP_BIN ?? "wu"
const OPENCODE_HOME = join(homedir(), ".config", "opencode")
const WA_STATE_DIR = join(OPENCODE_HOME, "state", "whatsapp-oc")
const WA_PENDING_MAX_AGE_MS = 15 * 60 * 1000
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
const REQUEST_KIND_CONFIG = resolveRequestKindConfig(
  process.env.WHATSAPP_REQUEST_KINDS ?? process.env.OWPENBOT_REQUEST_KINDS ?? "",
)

function normalizeRequestKindConfig(rawConfig = "") {
  const trimmed = String(rawConfig).trim()

  if (trimmed === "") {
    return { ...REQUEST_KIND_CONFIG_DEFAULTS }
  }

  let parsedConfig

  try {
    parsedConfig = JSON.parse(trimmed)
  } catch (error) {
    throw new Error(`Invalid JSON for WHATSAPP_REQUEST_KINDS: ${error.message}`)
  }

  if (!parsedConfig || typeof parsedConfig !== "object" || Array.isArray(parsedConfig)) {
    throw new Error(
      "WHATSAPP_REQUEST_KINDS must be a JSON object mapping request kinds to { incomingPrefix, outgoingPrefix }",
    )
  }

  const normalized = {}
  const incomingPrefixes = new Set()
  const outgoingPrefixes = new Set()

  for (const [requestKind, config] of Object.entries(parsedConfig)) {
    const normalizedRequestKind = String(requestKind).trim()

    if (!normalizedRequestKind) {
      throw new Error("WHATSAPP_REQUEST_KINDS contains an empty request kind key")
    }

    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error(`WHATSAPP_REQUEST_KINDS.${normalizedRequestKind} must be an object`)
    }

    const incomingPrefix =
      typeof config.incomingPrefix === "string" ? config.incomingPrefix.trim() : ""
    const outgoingPrefix =
      typeof config.outgoingPrefix === "string" ? config.outgoingPrefix.trim() : ""

    if (!incomingPrefix) {
      throw new Error(
        `WHATSAPP_REQUEST_KINDS.${normalizedRequestKind}.incomingPrefix must be a non-empty string`,
      )
    }

    if (!outgoingPrefix) {
      throw new Error(
        `WHATSAPP_REQUEST_KINDS.${normalizedRequestKind}.outgoingPrefix must be a non-empty string`,
      )
    }

    if (incomingPrefixes.has(incomingPrefix)) {
      throw new Error(`WHATSAPP_REQUEST_KINDS has duplicate incomingPrefix: ${incomingPrefix}`)
    }

    if (outgoingPrefixes.has(outgoingPrefix)) {
      throw new Error(`WHATSAPP_REQUEST_KINDS has duplicate outgoingPrefix: ${outgoingPrefix}`)
    }

    incomingPrefixes.add(incomingPrefix)
    outgoingPrefixes.add(outgoingPrefix)

    normalized[normalizedRequestKind] = {
      incomingPrefix,
      outgoingPrefix,
    }
  }

  if (Object.keys(normalized).length === 0) {
    throw new Error("WHATSAPP_REQUEST_KINDS must contain at least one request kind")
  }

  return normalized
}

function resolveRequestKindConfig(rawConfig) {
  return normalizeRequestKindConfig(rawConfig)
}

async function runWhatsapp(args) {
  try {
    const { stdout, stderr } = await execFileAsync(WHATSAPP_BIN, args, {
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

    throw new Error(message || "whatsapp command failed")
  }
}

function parseWhatsappOutput(text) {
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

function parseWhatsappLines(text) {
  const parsed = parseWhatsappOutput(text)

  if (parsed === null) return []
  if (Array.isArray(parsed)) return parsed

  return [parsed]
}

function formatResult(payload) {
  return JSON.stringify(payload, null, 2)
}

function normalizeChatId(value) {
  if (value === undefined || value === null) return ""

  const trimmed = String(value).trim()
  if (trimmed === "") return ""

  return trimmed.replace(/^whatsapp:/i, "").replace(/^\+/, "")
}

function formatChatId(value) {
  return normalizeChatId(value)
}

function encodeStateKey(value) {
  return Buffer.from(value, "utf8").toString("hex")
}

function getOcHandledPath(messageGuid) {
  return join(WA_STATE_DIR, `${encodeStateKey(messageGuid)}.json`)
}

function getOcPendingPath(messageGuid) {
  return join(WA_STATE_DIR, `${encodeStateKey(messageGuid)}.pending.json`)
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

function formatWhatsappReply(replyText, requestKind = "rc") {
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

async function ensureWaStateDir() {
  await mkdir(WA_STATE_DIR, { recursive: true })
}

async function isPendingClaimStale(filePath) {
  try {
    const info = await stat(filePath)
    return Date.now() - info.mtimeMs > WA_PENDING_MAX_AGE_MS
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

async function releasePendingClaim(filePath) {
  await rm(filePath, { force: true })
}

async function claimOcMessage(messageGuid, pendingRecord) {
  await ensureWaStateDir()

  const handledPath = getOcHandledPath(messageGuid)
  if (await pathExists(handledPath)) {
    return {
      claimed: false,
      reason: "already_handled",
      handledPath,
      record: await readJsonFile(handledPath),
    }
  }

  const pendingPath = getOcPendingPath(messageGuid)

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
      return claimOcMessage(messageGuid, pendingRecord)
    }

    return {
      claimed: false,
      reason: "already_pending",
      handledPath,
      pendingPath,
    }
  }
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
  if (!(await pathExists(WA_STATE_DIR))) {
    return {
      total: 0,
      records: [],
    }
  }

  const fileNames = (await readdir(WA_STATE_DIR)).filter((name) => {
    if (name.endsWith(".pending.json")) return includePending
    return name.endsWith(".json")
  })

  const records = await Promise.all(
    fileNames.map(async (name) => {
      const filePath = join(WA_STATE_DIR, name)
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

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined
  }

  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed === "" ? undefined : trimmed
  }

  return String(value).trim() || undefined
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

  if (!targetFlags[targetType]) {
    throw new Error(`Unsupported targetType: ${targetType}`)
  }

  return {
    type: targetType,
    flag: targetFlags[targetType],
    value: formatChatId(normalizedValue),
  }
}

function parseIncomingRequestMessage(message) {
  if (!message || typeof message !== "object") return false
  if (message.is_from_me === true || message.from_me === true) return false

  const chatId = formatChatId(
    message.chat_id ??
      message.chatId ??
      message.chat_jid ??
      message.chat_identifier ??
      message.phone ??
      message.chat ??
      message.to,
  )

  if (!chatId) return null

  const messageGuid = (() => {
    if (typeof message.guid === "string" && message.guid.trim() !== "") {
      return message.guid.trim()
    }

    if (typeof message.id === "string" && message.id.trim() !== "") {
      return message.id.trim()
    }

    if (typeof message.messageId === "string" && message.messageId.trim() !== "") {
      return message.messageId.trim()
    }

    if (typeof message.sid === "string" && message.sid.trim() !== "") {
      return message.sid.trim()
    }

    return null
  })()

  if (!messageGuid) return null

  const text =
    typeof message.text === "string" ? message.text : typeof message.body === "string" ? message.body : null

  if (typeof text !== "string") return null

  const request = parseRequestText(text)
  if (!request) return null

  return {
    ...message,
    ...request,
    chat_id: chatId,
    guid: messageGuid,
    text,
  }
}

function getMessageSortTime(message) {
  const createdAt = Date.parse(message.created_at ?? message.createdAt ?? message.date_created ?? "")
  if (Number.isFinite(createdAt)) return createdAt

  if (message.id && Number.isFinite(Number.parseInt(String(message.id), 10))) {
    return Number.parseInt(String(message.id), 10)
  }

  return 0
}

async function listWaPendingRequests({ chatLimit, messageLimit, limit }) {
  const chatsResult = await runWhatsapp(["chats", "--limit", String(chatLimit), "--json"])
  const recentChats = parseWhatsappLines(chatsResult.stdout)

  const chatHistories = await Promise.all(
    recentChats.map(async (chat) => {
      const chatId = formatChatId(chat.id ?? chat.chat_id ?? chat.jid ?? chat.identifier ?? chat.phone)
      if (!chatId) return []

      const result = await runWhatsapp([
        "history",
        "--chat-id",
        String(chatId),
        "--limit",
        String(messageLimit),
        "--json",
      ])

      return parseWhatsappLines(result.stdout)
    }),
  )

  const candidates = chatHistories.flat().map(parseIncomingRequestMessage).filter(Boolean)
  const requests = []

  for (const message of candidates) {
    const status = await getOcMessageStatus(message.guid)
    const isStalePending = status.status === "pending" && status.record?.stale === true

    if (status.status === "handled") continue
    if (status.status === "pending" && !isStalePending) continue

    requests.push({
      chatId: message.chat_id,
      messageGuid: message.guid,
      messageId: message.id ?? null,
      requestKind: message.requestKind,
      requestPrefix: message.requestPrefix,
      responsePrefix: message.responsePrefix,
      requestText: message.text,
      sender: message.sender ?? message.from ?? null,
      createdAt: message.created_at ?? message.createdAt ?? message.date_created ?? null,
      status: isStalePending ? "stale_pending" : "new",
    })
  }

  requests.sort((left, right) => getMessageSortTime(right) - getMessageSortTime(left))

  return {
    total: requests.length,
    requests: requests.slice(0, limit),
  }
}

export const whatsapp_chats = tool({
  description: "List recent WhatsApp chats through the configured WhatsApp CLI.",
  args: {
    limit: tool.schema.number().int().min(1).max(100).default(20).describe("Maximum chats to return"),
  },
  async execute(args) {
    const result = await runWhatsapp(["chats", "--limit", String(args.limit), "--json"])

    return formatResult({
      chats: parseWhatsappLines(result.stdout),
    })
  },
})

export const whatsapp_history = tool({
  description: "Read WhatsApp history for a specific chat through the configured WhatsApp CLI.",
  args: {
    chatId: tool.schema.string().min(1).describe("Chat identifier from whatsapp_chats"),
    limit: tool.schema.number().int().min(1).max(200).default(20).describe("Maximum messages to return"),
    includeAttachments: tool.schema.boolean().default(false).describe("Include attachment metadata"),
    participants: tool.schema.array(tool.schema.string()).optional().describe("Optional participant handle filters"),
    start: tool.schema.string().optional().describe("Optional ISO8601 inclusive start time"),
    end: tool.schema.string().optional().describe("Optional ISO8601 exclusive end time"),
  },
  async execute(args) {
    const command = [
      "history",
      "--chat-id",
      String(formatChatId(args.chatId)),
      "--limit",
      String(args.limit),
      "--json",
    ]

    if (args.includeAttachments) command.push("--attachments")
    appendParticipantFilter(command, args.participants)
    pushOptional(command, "--start", args.start)
    pushOptional(command, "--end", args.end)

    const result = await runWhatsapp(command)

    return formatResult({
      chatId: formatChatId(args.chatId),
      messages: parseWhatsappLines(result.stdout),
    })
  },
})

export const whatsapp_send = tool({
  description: "Send a WhatsApp message after explicit user confirmation.",
  args: {
    confirmed: tool.schema.boolean().describe("Must be true only after the user explicitly asked to send this message"),
    text: tool.schema.string().min(1).describe("Message body to send"),
    targetType: tool.schema
      .enum(["to", "chatId", "chatIdentifier", "chatGuid"])
      .describe("How to target the message recipient"),
    targetValue: tool.schema
      .union([tool.schema.string(), tool.schema.number()])
      .describe(
        "Target value. Use a phone number for 'to', digits/identifier for 'chatId', or the raw identifier/guid for other target types",
      ),
    service: tool.schema.enum(["auto", "whatsapp"]).default("auto").describe("Preferred delivery service"),
    region: tool.schema.string().optional().describe("Optional phone region for normalization"),
  },
  async execute(args) {
    if (!args.confirmed) {
      throw new Error("Refusing to send: user confirmation is required")
    }

    const target = resolveSendTarget(args.targetType, args.targetValue)

    const command = [
      "send",
      target.flag,
      target.value,
      "--text",
      args.text,
      "--service",
      args.service,
      "--json",
    ]
    pushOptional(command, "--region", args.region)

    const result = await runWhatsapp(command)

    return formatResult({
      sent: true,
      target: {
        type: target.type,
        value: target.value,
      },
      service: args.service,
      result: parseWhatsappOutput(result.stdout) ?? result.stdout,
      stderr: result.stderr || null,
    })
  },
})

export const whatsapp_pending = tool({
  description: "List incoming WhatsApp trigger messages that still need a reply.",
  args: {
    chatLimit: tool.schema.number().int().min(1).max(100).default(20).describe("Maximum recent chats to scan"),
    messageLimit: tool.schema.number().int().min(1).max(200).default(50).describe("Maximum recent messages to inspect per chat"),
    limit: tool.schema.number().int().min(1).max(200).default(20).describe("Maximum pending incoming trigger requests to return"),
  },
  async execute(args) {
    return formatResult(await listWaPendingRequests(args))
  },
})

export const whatsapp_reply_once = tool({
  description:
    "Reply once to an incoming WhatsApp trigger request and persist handled state across OpenCode sessions.",
  args: {
    confirmed: tool.schema
      .boolean()
      .describe("Must be true only after the user explicitly allowed incoming trigger auto-replies"),
    chatId: tool.schema.string().min(1).describe("Chat identifier from whatsapp_history"),
    messageGuid: tool.schema.string().min(1).describe("GUID/message id of the incoming trigger message being handled"),
    requestKind: tool.schema
      .enum(["rc", "drboz"])
      .optional()
      .describe("Incoming trigger kind. Defaults to inferring from requestText, then rc"),
    replyText: tool.schema.string().min(1).describe("Reply body without the leading outgoing trigger prefix"),
    requestText: tool.schema
      .string()
      .optional()
      .describe("Original incoming trigger text for audit/debugging and request-kind inference"),
    service: tool.schema.enum(["auto", "whatsapp"]).default("auto").describe("Preferred delivery service"),
    region: tool.schema.string().optional().describe("Optional phone region for normalization"),
  },
  async execute(args) {
    if (!args.confirmed) {
      throw new Error("Refusing to send: user confirmation is required")
    }

    const requestKind = resolveRequestKind(args.requestKind, args.requestText)
    const requestConfig = getRequestKindConfig(requestKind)
    const replyText = args.replyText.trim()
    const outgoingText = formatWhatsappReply(replyText, requestKind)
    const claimedAt = new Date().toISOString()
    const targetChatId = formatChatId(args.chatId)
    const claim = await claimOcMessage(args.messageGuid, {
      status: "pending",
      messageGuid: args.messageGuid,
      chatId: targetChatId,
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
      const command = [
        "send",
        "--chat-id",
        targetChatId,
        "--text",
        outgoingText,
        "--service",
        args.service,
        "--json",
      ]
      pushOptional(command, "--region", args.region)

      const result = await runWhatsapp(command)
      const handledAt = new Date().toISOString()
      const parsedResult = parseWhatsappOutput(result.stdout) ?? result.stdout
      const record = {
        status: "handled",
        messageGuid: args.messageGuid,
        chatId: targetChatId,
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
          value: targetChatId,
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

export const whatsapp_status = tool({
  description: "Inspect persisted WhatsApp reply-once state across OpenCode sessions.",
  args: {
    messageGuid: tool.schema.string().optional().describe("Optional GUID/message id of a specific incoming trigger message to inspect"),
    limit: tool.schema.number().int().min(1).max(200).default(20).describe("Maximum records to return when listing recent trigger state"),
    includePending: tool.schema.boolean().default(true).describe("Include pending in-flight trigger reply claims when listing recent state"),
  },
  async execute(args) {
    if (args.messageGuid) {
      return formatResult({
        stateDir: WA_STATE_DIR,
        ...(await getOcMessageStatus(args.messageGuid)),
      })
    }

    const result = await listOcRecords({
      includePending: args.includePending,
      limit: args.limit,
    })

    return formatResult({
      stateDir: WA_STATE_DIR,
      includePending: args.includePending,
      ...result,
    })
  },
})

export const whatsapp_oc_reply_once = whatsapp_reply_once
export const whatsapp_oc_status = whatsapp_status

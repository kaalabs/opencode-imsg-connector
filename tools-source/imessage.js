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
const OC_PENDING_MAX_AGE_MS = 15 * 60 * 1000
const REQUEST_KIND_CONFIG = {
  rc: {
    incomingPrefix: "@RC",
    outgoingPrefix: "RC:",
  },
  drboz: {
    incomingPrefix: "@DRBOZ",
    outgoingPrefix: "DRBOZ:",
  },
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

function parseImsgLines(text) {
  const parsed = parseImsgOutput(text)

  if (parsed === null) return []
  if (Array.isArray(parsed)) return parsed

  return [parsed]
}

function formatResult(payload) {
  return JSON.stringify(payload, null, 2)
}

function encodeStateKey(value) {
  return Buffer.from(value, "utf8").toString("hex")
}

function getOcHandledPath(messageGuid) {
  return join(OC_STATE_DIR, `${encodeStateKey(messageGuid)}.json`)
}

function getOcPendingPath(messageGuid) {
  return join(OC_STATE_DIR, `${encodeStateKey(messageGuid)}.pending.json`)
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

async function ensureOcStateDir() {
  await mkdir(OC_STATE_DIR, { recursive: true })
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

async function claimOcMessage(messageGuid, pendingRecord) {
  await ensureOcStateDir()

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

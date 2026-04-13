#!/usr/bin/env node

import { appendFileSync } from "node:fs"

const args = process.argv.slice(2)

function normalizeChatId(value) {
  if (value === undefined || value === null) return ""
  return String(value).replace(/^\+/, "").trim()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function appendLog(entry) {
  const logFile = process.env.FAKE_WHATSAPP_LOG_FILE
  if (!logFile) return

  appendFileSync(logFile, `${JSON.stringify(entry)}\n`)
}

if (args[0] === "watch") {
  const rawLines = process.env.FAKE_WHATSAPP_WATCH_LINES
  const sleepMs = Number.parseInt(process.env.FAKE_WHATSAPP_WATCH_SLEEP_MS ?? "0", 10)
  const exitCode = Number.parseInt(process.env.FAKE_WHATSAPP_WATCH_EXIT_CODE ?? "0", 10)
  const lines = rawLines
    ? rawLines.split("\n").filter(Boolean)
    : [
        JSON.stringify({
          id: "1",
          chat_id: "+31600000000",
          from_me: false,
          text: "@RC: fake incoming message",
          created_at: new Date().toISOString(),
        }),
      ]

  for (const line of lines) {
    appendLog({ command: "watch", line })
    console.log(line)
  }

  if (Number.isFinite(sleepMs) && sleepMs > 0) {
    await sleep(sleepMs)
  }

  process.exit(Number.isFinite(exitCode) ? exitCode : 0)
}

if (args[0] === "chats") {
  const raw = process.env.FAKE_WHATSAPP_CHATS_JSON
  const chats = raw
    ? JSON.parse(raw)
    : [{ id: "+31600000000", identifier: "+31600000000", service: "whatsapp", last_message_at: new Date().toISOString() }]

  for (const chat of chats) {
    appendLog({ command: "chats", chat })
    console.log(JSON.stringify(chat))
  }

  process.exit(0)
}

if (args[0] === "history") {
  const chatIdIndex = args.indexOf("--chat-id")
  const chatId = normalizeChatId(chatIdIndex >= 0 ? args[chatIdIndex + 1] : "")
  const allMessages = process.env.FAKE_WHATSAPP_HISTORY_JSON ? JSON.parse(process.env.FAKE_WHATSAPP_HISTORY_JSON) : []
  const messages = allMessages.filter((message) => {
    const messageChatId = normalizeChatId(message.chat_id ?? message.chatId ?? message.phone ?? "")
    return messageChatId === String(chatId)
  })

  for (const message of messages) {
    appendLog({ command: "history", chatId, message })
    console.log(JSON.stringify(message))
  }

  process.exit(0)
}

if (args[0] === "send") {
  const sleepMs = Number.parseInt(process.env.FAKE_WHATSAPP_SEND_SLEEP_MS ?? "0", 10)
  const shouldFail = process.env.FAKE_WHATSAPP_SEND_FAIL === "1"
  const stderrText = process.env.FAKE_WHATSAPP_SEND_FAIL_STDERR ?? "fake whatsapp send failure"

  appendLog({ command: "send", argv: args })

  if (Number.isFinite(sleepMs) && sleepMs > 0) {
    await sleep(sleepMs)
  }

  if (shouldFail) {
    process.stderr.write(`${stderrText}\n`)
    process.exit(1)
  }

  console.log(
    JSON.stringify({
      status: "sent",
      argv: args,
    }),
  )
  process.exit(0)
}

appendLog({ command: "default", argv: args })
console.log(
  JSON.stringify({
    status: "sent",
    argv: args,
  }),
)

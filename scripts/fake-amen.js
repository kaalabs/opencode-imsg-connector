#!/usr/bin/env node

import { appendFileSync } from "node:fs"

const args = process.argv.slice(2)

function appendLog(entry) {
  const logFile = process.env.FAKE_AMEN_LOG_FILE
  if (!logFile) return

  appendFileSync(logFile, `${JSON.stringify(entry)}\n`)
}

function failIfRequested(commandName) {
  if (process.env.FAKE_AMEN_FAIL_COMMAND !== commandName) return false

  process.stderr.write(`${process.env.FAKE_AMEN_FAIL_STDERR ?? `fake amen ${commandName} failure`}\n`)
  process.exit(1)
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2))
}

if (args[0] === "check") {
  appendLog({ command: "check", argv: args })
  failIfRequested("check")
  printJson(
    process.env.FAKE_AMEN_CHECK_JSON
      ? JSON.parse(process.env.FAKE_AMEN_CHECK_JSON)
      : { mailboxCounts: [], refreshed: true, totalNewMessages: 0 },
  )
  process.exit(0)
}

if (args[0] === "headlines") {
  appendLog({ command: "headlines", argv: args })
  failIfRequested("headlines")
  printJson(
    process.env.FAKE_AMEN_HEADLINES_JSON
      ? JSON.parse(process.env.FAKE_AMEN_HEADLINES_JSON)
      : { messages: [] },
  )
  process.exit(0)
}

if (args[0] === "message-id") {
  const requestedMessageID = args[1] ?? ""
  const messagesById = process.env.FAKE_AMEN_MESSAGE_ID_MAP_JSON
    ? JSON.parse(process.env.FAKE_AMEN_MESSAGE_ID_MAP_JSON)
    : {}
  appendLog({ command: "message-id", argv: args, requestedMessageID })
  failIfRequested("message-id")
  printJson(
    messagesById[requestedMessageID] ?? {
      requestedMessageID,
      messages: [],
      errors: [],
    },
  )
  process.exit(0)
}

if (args[0] === "fetch") {
  appendLog({ command: "fetch", argv: args })
  failIfRequested("fetch")
  printJson(
    process.env.FAKE_AMEN_FETCH_JSON
      ? JSON.parse(process.env.FAKE_AMEN_FETCH_JSON)
      : { messages: [], errors: [] },
  )
  process.exit(0)
}

appendLog({ command: "default", argv: args })
printJson({ argv: args })

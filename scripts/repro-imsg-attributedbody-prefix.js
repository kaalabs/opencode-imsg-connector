#!/usr/bin/env node

import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

function usage(code = 1) {
  process.stderr.write(
    [
      `Usage: ${process.argv[1].split("/").pop()} --chat-id ID [options]`,
      "",
      "Options:",
      "  --chat-id ID      Required Messages chat rowid to inspect",
      "  --limit N         Number of recent messages to read (default: 20)",
      "  --imsg-bin PATH   Path to imsg binary (default: IMSG_BIN or imsg)",
      "  --db PATH         Path to Messages chat.db (default: ~/Library/Messages/chat.db)",
      "  -h, --help        Show this help",
      "",
    ].join("\n"),
  )
  process.exit(code)
}

function parseArgs(argv) {
  const options = {
    chatId: "",
    limit: "20",
    imsgBin: process.env.IMSG_BIN ?? "imsg",
    dbPath: join(homedir(), "Library", "Messages", "chat.db"),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    switch (arg) {
      case "--chat-id":
        options.chatId = argv[index + 1] ?? usage()
        index += 1
        break
      case "--limit":
        options.limit = argv[index + 1] ?? usage()
        index += 1
        break
      case "--imsg-bin":
        options.imsgBin = argv[index + 1] ?? usage()
        index += 1
        break
      case "--db":
        options.dbPath = argv[index + 1] ?? usage()
        index += 1
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

  if (!options.chatId) usage()
  return options
}

async function runCommand(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
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
    throw new Error(message || `${command} failed`)
  }
}

function parseNdjson(text) {
  if (!text) return []
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function extractPrefixDetails(text) {
  const prefix = Array.from(text).slice(0, 8)
  return {
    preview: prefix.join(""),
    codepoints: prefix.map((character) => character.codePointAt(0)),
  }
}

function looksLikeAttributedBodyPrefixLeak(text) {
  if (typeof text !== "string" || text.length < 4) return false

  const chars = Array.from(text)
  if (chars.length < 4) return false

  const first = chars[0].codePointAt(0)
  const second = chars[1].codePointAt(0)
  const third = chars[2].codePointAt(0)
  const fourth = chars[3].codePointAt(0)

  if (first !== 0xfffd) return false
  if (fourth === undefined || fourth < 0x20 || fourth === 0x7f) return false
  if (third > 0xff) return false

  return second === 0xfffd || second <= 0xff
}

async function fetchBlobEvidence(dbPath, rowId) {
  const query = `select rowid, guid, text, length(attributedBody) as attributedBodyLength, hex(substr(attributedBody, 1, 48)) as attributedBodyPrefixHex from message where rowid = ${Number(rowId)};`
  const result = await runCommand("sqlite3", ["-json", dbPath, query])
  const parsed = JSON.parse(result.stdout)
  return parsed[0] ?? null
}

const options = parseArgs(process.argv.slice(2))
const history = await runCommand(options.imsgBin, ["history", "--chat-id", options.chatId, "--limit", options.limit, "--json"])
const messages = parseNdjson(history.stdout)
const suspects = messages.filter((message) => looksLikeAttributedBodyPrefixLeak(message.text ?? ""))

console.log(`Scanned ${messages.length} message(s) from chat ${options.chatId}.`)

if (suspects.length === 0) {
  console.log("No attributedBody prefix leak found in the inspected history output.")
  process.exit(0)
}

console.log(`Found ${suspects.length} suspect message(s):`)

for (const message of suspects) {
  const prefix = extractPrefixDetails(message.text ?? "")
  const blobEvidence = await fetchBlobEvidence(options.dbPath, message.id)

  console.log("")
  console.log(`rowid: ${message.id}`)
  console.log(`guid: ${message.guid}`)
  console.log(`created_at: ${message.created_at}`)
  console.log(`raw_prefix_preview: ${JSON.stringify(prefix.preview)}`)
  console.log(`raw_prefix_codepoints: ${JSON.stringify(prefix.codepoints)}`)
  console.log(`raw_text_preview: ${JSON.stringify(String(message.text).slice(0, 160))}`)
  console.log(`db_text_is_null: ${blobEvidence?.text === null}`)
  console.log(`attributedBody_length: ${blobEvidence?.attributedBodyLength ?? null}`)
  console.log(`attributedBody_prefix_hex: ${blobEvidence?.attributedBodyPrefixHex ?? null}`)
}

process.exit(1)

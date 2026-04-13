import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { tool } from "@opencode-ai/plugin"

const execFileAsync = promisify(execFile)
const AMEN_BIN = process.env.AMEN_BIN ?? "amen"

async function runAmen(args) {
  try {
    const { stdout, stderr } = await execFileAsync(AMEN_BIN, args, {
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

    throw new Error(message || "amen command failed")
  }
}

function parseAmenJson(text) {
  if (!text) return {}

  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`amen returned invalid JSON: ${error.message}`)
  }
}

function formatResult(payload) {
  return JSON.stringify(payload, null, 2)
}

export const check = tool({
  description: "Refresh Apple Mail and report queued new email counts.",
  args: {
    refreshMail: tool.schema.boolean().default(true).describe("Whether to trigger Apple Mail's check-for-new-mail action before scanning"),
  },
  async execute(args) {
    const command = ["check", "--format", "json"]
    if (!args.refreshMail) command.push("--no-refresh-mail")

    const result = await runAmen(command)
    return formatResult(parseAmenJson(result.stdout))
  },
})

export const headlines = tool({
  description: "List queued new email headline metadata without clearing the queue.",
  args: {},
  async execute() {
    const result = await runAmen(["headlines", "--format", "json"])
    return formatResult(parseAmenJson(result.stdout))
  },
})

export const message_id = tool({
  description: "Fetch a specific email by RFC Message-ID without mutating amen queue state.",
  args: {
    messageId: tool.schema.string().min(1).describe("RFC Message-ID value, with or without surrounding angle brackets"),
  },
  async execute(args) {
    const result = await runAmen(["message-id", args.messageId, "--format", "json"])
    return formatResult(parseAmenJson(result.stdout))
  },
})

export const fetch = tool({
  description: "Fetch and clear queued amen emails after successful processing.",
  args: {},
  async execute() {
    const result = await runAmen(["fetch", "--format", "json"])
    return formatResult(parseAmenJson(result.stdout))
  },
})

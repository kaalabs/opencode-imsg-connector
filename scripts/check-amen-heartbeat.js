#!/usr/bin/env node

import { execFile, spawn } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { delimiter, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const scriptDir = dirname(fileURLToPath(import.meta.url))
const heartbeatScript = resolve(scriptDir, "rc-heartbeat.sh")

function usage(code = 1) {
  process.stderr.write(
    [
      `Usage: ${process.argv[1].split("/").pop()} [options]`,
      "",
      "Options:",
      "  --server-url URL              OpenCode server URL (default: http://127.0.0.1:4096)",
      "  --model PROVIDER/MODEL        Model to use (default: openai/gpt-5.4)",
      "  --agent AGENT                 Agent to use (default: build)",
      "  --prompt PROMPT               Trigger prompt (default: RC_HEARTBEAT)",
      "  --runtime-dir PATH            Runtime directory for lock and logs",
      "  --amen-bin PATH               Path to amen binary (default: amen)",
      "  --opencode-bin PATH           Path to opencode binary (default: opencode)",
      "  -h, --help                    Show this help",
      "",
      "Environment:",
      "  AMEN_BIN, OPENCODE_BIN, RUNTIME_DIR",
      "",
    ].join("\n"),
  )
  process.exit(code)
}

function parseArgs(argv) {
  const options = {
    serverUrl: "http://127.0.0.1:4096",
    model: "openai/gpt-5.4",
    agent: "build",
    prompt: "RC_HEARTBEAT",
    runtimeDir: process.env.RUNTIME_DIR ?? `${process.env.TMPDIR ?? "/tmp"}/opencode-imsg-connector`,
    amenBin: process.env.AMEN_BIN ?? "amen",
    opencodeBin: process.env.OPENCODE_BIN ?? "opencode",
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
      case "--runtime-dir":
        options.runtimeDir = argv[index + 1] ?? usage()
        index += 1
        break
      case "--amen-bin":
        options.amenBin = argv[index + 1] ?? usage()
        index += 1
        break
      case "--opencode-bin":
        options.opencodeBin = argv[index + 1] ?? usage()
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

  return options
}

function log(message) {
  process.stderr.write(`[check-amen-heartbeat] ${message}\n`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForHealth(serverUrl, attempts = 10, delayMs = 500) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${serverUrl}/global/health`)
      if (response.ok) return true
    } catch {}

    await sleep(delayMs)
  }

  return false
}

async function runAmenCheck(amenBin) {
  try {
    const { stdout, stderr } = await execFileAsync(amenBin, ["check", "--format", "json"], {
      maxBuffer: 10 * 1024 * 1024,
      env: buildExecutionEnv(amenBin),
    })

    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    }
  } catch (error) {
    const stderr = error.stderr?.toString().trim()
    const stdout = error.stdout?.toString().trim()
    const message = [stderr, stdout, error.message].filter(Boolean).join("\n")
    throw new Error(message || "amen check failed")
  }
}

async function runAmenHeadlines(amenBin) {
  try {
    const { stdout, stderr } = await execFileAsync(amenBin, ["headlines", "--format", "json"], {
      maxBuffer: 10 * 1024 * 1024,
      env: buildExecutionEnv(amenBin),
    })

    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    }
  } catch (error) {
    const stderr = error.stderr?.toString().trim()
    const stdout = error.stdout?.toString().trim()
    const message = [stderr, stdout, error.message].filter(Boolean).join("\n")
    throw new Error(message || "amen headlines failed")
  }
}

function parseCheckResult(stdout) {
  const parsed = JSON.parse(stdout)
  const total = Number(parsed?.totalNewMessages ?? 0)
  return {
    result: parsed,
    totalNewMessages: Number.isFinite(total) ? total : 0,
  }
}

function parseHeadlinesResult(stdout) {
  const parsed = JSON.parse(stdout)
  const total = Array.isArray(parsed?.messages) ? parsed.messages.length : 0
  return {
    result: parsed,
    totalQueuedMessages: total,
  }
}

function buildExecutionPath(...binPaths) {
  const pathParts = []
  const seen = new Set()

  for (const value of [
    dirname(process.execPath),
    ...binPaths.filter(Boolean).map((binPath) => dirname(binPath)),
    ...String(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    pathParts.push(value)
  }

  return pathParts.join(delimiter)
}

function buildExecutionEnv(...binPaths) {
  return {
    ...process.env,
    PATH: buildExecutionPath(...binPaths),
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"))
  } catch {
    return null
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false

  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function acquireLock(lockPath) {
  const record = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
  }

  try {
    writeFileSync(lockPath, JSON.stringify(record, null, 2), { flag: "wx" })
    return true
  } catch (error) {
    if (error?.code !== "EEXIST") throw error

    const existing = readLock(lockPath)
    if (processIsAlive(existing?.pid)) {
      log(`another amen heartbeat run is active (pid=${existing.pid})`)
      return false
    }

    rmSync(lockPath, { force: true })
    writeFileSync(lockPath, JSON.stringify(record, null, 2), { flag: "wx" })
    return true
  }
}

function releaseLock(lockPath) {
  rmSync(lockPath, { force: true })
}

async function runHeartbeat(options) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      "/bin/bash",
      [
        heartbeatScript,
        "--server-url",
        options.serverUrl,
        "--model",
        options.model,
        "--agent",
        options.agent,
        "--prompt",
        options.prompt,
      ],
      {
        stdio: "inherit",
        env: {
          ...buildExecutionEnv(options.opencodeBin, options.amenBin),
          AMEN_BIN: options.amenBin,
          OPENCODE_BIN: options.opencodeBin,
        },
      },
    )

    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`heartbeat exited from signal ${signal}`))
        return
      }

      if ((code ?? 1) !== 0) {
        reject(new Error(`heartbeat exited with code ${code ?? 1}`))
        return
      }

      resolve()
    })
  })
}

const options = parseArgs(process.argv.slice(2))
const lockPath = resolve(options.runtimeDir, "amen-heartbeat.lock")

mkdirSync(options.runtimeDir, { recursive: true })

if (!acquireLock(lockPath)) {
  process.exit(0)
}

try {
  const healthy = await waitForHealth(options.serverUrl)
  if (!healthy) {
    throw new Error(`OpenCode server failed health check at ${options.serverUrl}`)
  }

  let totalNewMessages = 0
  let result = null

  try {
    const amenCheck = await runAmenCheck(options.amenBin)
    const parsedCheck = parseCheckResult(amenCheck.stdout)
    totalNewMessages = parsedCheck.totalNewMessages
    result = parsedCheck.result
  } catch (error) {
    log(`amen check failed: ${error instanceof Error ? error.message : String(error)}`)

    const amenHeadlines = await runAmenHeadlines(options.amenBin)
    const parsedHeadlines = parseHeadlinesResult(amenHeadlines.stdout)
    totalNewMessages = parsedHeadlines.totalQueuedMessages
    result = parsedHeadlines.result

    if (totalNewMessages <= 0) {
      throw error
    }

    log(`amen still has ${totalNewMessages} queued email(s); continuing with heartbeat`)
  }

  log(`amen queued ${totalNewMessages} new email(s)`)

  if (totalNewMessages > 0) {
    if (process.env.AMEN_CHECK_LOG_JSON === "1") {
      process.stderr.write(`${JSON.stringify(result)}\n`)
    }

    await runHeartbeat(options)
  }
} catch (error) {
  log(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  releaseLock(lockPath)
}

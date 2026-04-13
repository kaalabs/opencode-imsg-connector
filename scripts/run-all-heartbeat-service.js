#!/usr/bin/env node

import { spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const rcWatcherScript = resolve(scriptDir, "watch-rc-heartbeat.js")
const whatsappWatcherScript = resolve(scriptDir, "watch-whatsapp-heartbeat.js")
const whatsappCliWrapper = resolve(scriptDir, "whatsapp-cli.js")

function usage(code = 1) {
  process.stderr.write(
    [
      `Usage: ${process.argv[1].split("/").pop()} [options]`,
      "",
      "Options:",
      "  --hostname HOST               OpenCode bind host (default: 127.0.0.1)",
      "  --port PORT                   OpenCode bind port (default: 4096)",
      "  --model PROVIDER/MODEL        Model to use (default: openai/gpt-5.4)",
      "  --agent AGENT                 Agent to use (default: build)",
      "  --prompt PROMPT               Shared trigger prompt (default: RC_HEARTBEAT)",
      "  --runtime-dir PATH            Runtime directory for pid/log files",
      "  --imsg-bin PATH               Path to imsg binary (default: imsg)",
      "  --whatsapp-bin PATH           Path to WhatsApp CLI or compatible wrapper",
      "  --whatsapp-real-bin PATH      Path to real WhatsApp CLI when using the wrapper",
      "  --opencode-bin PATH           Path to opencode binary (default: opencode)",
      "  --node-bin PATH               Path to node binary (default: node)",
      "  --request-kinds JSON          Shared request-kind override JSON",
      "  --whatsapp-request-kinds JSON WhatsApp-specific request-kind override JSON",
      "  -h, --help                    Show this help",
      "",
      "Environment:",
      "  IMSG_BIN, WHATSAPP_BIN, WHATSAPP_REAL_BIN, OPENCODE_BIN, NODE_BIN",
      "  OWPENBOT_REQUEST_KINDS, WHATSAPP_REQUEST_KINDS",
      "",
    ].join("\n"),
  )
  process.exit(code)
}

function parseArgs(argv) {
  const options = {
    hostname: "127.0.0.1",
    port: "4096",
    model: "openai/gpt-5.4",
    agent: "build",
    prompt: "RC_HEARTBEAT",
    runtimeDir: process.env.RUNTIME_DIR ?? `${process.env.TMPDIR ?? "/tmp"}/opencode-imsg-connector`,
    imsgBin: process.env.IMSG_BIN ?? "imsg",
    whatsappBin: process.env.WHATSAPP_BIN ?? "wu",
    whatsappRealBin: process.env.WHATSAPP_REAL_BIN ?? "",
    opencodeBin: process.env.OPENCODE_BIN ?? "opencode",
    nodeBin: process.env.NODE_BIN ?? "node",
    requestKinds: process.env.OWPENBOT_REQUEST_KINDS ?? "",
    whatsappRequestKinds: process.env.WHATSAPP_REQUEST_KINDS ?? "",
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    switch (arg) {
      case "--hostname":
        options.hostname = argv[index + 1] ?? usage()
        index += 1
        break
      case "--port":
        options.port = argv[index + 1] ?? usage()
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
      case "--imsg-bin":
        options.imsgBin = argv[index + 1] ?? usage()
        index += 1
        break
      case "--whatsapp-bin":
        options.whatsappBin = argv[index + 1] ?? usage()
        index += 1
        break
      case "--whatsapp-real-bin":
        options.whatsappRealBin = argv[index + 1] ?? usage()
        index += 1
        break
      case "--opencode-bin":
        options.opencodeBin = argv[index + 1] ?? usage()
        index += 1
        break
      case "--node-bin":
        options.nodeBin = argv[index + 1] ?? usage()
        index += 1
        break
      case "--request-kinds":
        options.requestKinds = argv[index + 1] ?? usage()
        index += 1
        break
      case "--whatsapp-request-kinds":
        options.whatsappRequestKinds = argv[index + 1] ?? usage()
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function writePid(filePath, pid) {
  writeFileSync(filePath, `${pid}\n`)
}

function removeFile(filePath) {
  rmSync(filePath, { force: true })
}

async function waitForHealth(serverUrl, attempts = 50, delayMs = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${serverUrl}/global/health`)
      if (response.ok) return true
    } catch {}

    await sleep(delayMs)
  }

  return false
}

function log(message) {
  process.stderr.write(`[run-all-heartbeat-service] ${message}\n`)
}

const options = parseArgs(process.argv.slice(2))
const serverUrl = `http://${options.hostname}:${options.port}`
const pidFiles = {
  supervisor: resolve(options.runtimeDir, "heartbeat-supervisor.pid"),
  server: resolve(options.runtimeDir, "opencode-server.pid"),
  rc: resolve(options.runtimeDir, "rc-heartbeat-watcher.pid"),
  whatsapp: resolve(options.runtimeDir, "whatsapp-heartbeat-watcher.pid"),
}
const logFiles = {
  server: resolve(options.runtimeDir, "opencode-server.log"),
  rc: resolve(options.runtimeDir, "rc-heartbeat-watcher.log"),
  whatsapp: resolve(options.runtimeDir, "whatsapp-heartbeat-watcher.log"),
}

mkdirSync(options.runtimeDir, { recursive: true })
writePid(pidFiles.supervisor, process.pid)

const processes = new Map()
let stopping = false

function childIsAlive(name) {
  const child = processes.get(name)
  return Boolean(child && !child.killed && child.exitCode === null)
}

function spawnManagedProcess(name, command, args, env, logFile, pidFile, restartDelayMs = 2000) {
  if (stopping || childIsAlive(name)) return

  const logFd = openSync(logFile, "a")
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", logFd, logFd],
  })
  closeSync(logFd)
  processes.set(name, child)
  writePid(pidFile, child.pid)
  log(`started ${name} pid=${child.pid}`)

  child.once("spawn", () => {
    try {
      process.kill(child.pid, 0)
    } catch (error) {
      log(`${name} failed to spawn: ${error.message}`)
    }
  })

  child.once("error", (error) => {
    log(`${name} errored: ${error.message}`)
  })

  child.once("exit", (code, signal) => {
    removeFile(pidFile)
    processes.delete(name)

    if (stopping) return

    const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`
    log(`${name} exited with ${detail}; restarting in ${restartDelayMs}ms`)
    setTimeout(() => {
      spawnManagedProcess(name, command, args, env, logFile, pidFile, restartDelayMs)
    }, restartDelayMs)
  })
}

async function startServer() {
  const env = {
    OPENCODE_CLIENT: "cli",
  }
  const useWrapper = options.whatsappRealBin || basename(options.whatsappBin) === "wu"

  if (useWrapper) {
    env.WHATSAPP_BIN = whatsappCliWrapper
    env.WHATSAPP_REAL_BIN = options.whatsappRealBin || options.whatsappBin
  } else {
    env.WHATSAPP_BIN = options.whatsappBin
  }

  if (options.whatsappRequestKinds) {
    env.WHATSAPP_REQUEST_KINDS = options.whatsappRequestKinds
  } else if (options.requestKinds) {
    env.WHATSAPP_REQUEST_KINDS = options.requestKinds
  }

  spawnManagedProcess(
    "server",
    options.opencodeBin,
    ["serve", "--hostname", options.hostname, "--port", options.port],
    env,
    logFiles.server,
    pidFiles.server,
  )

  const healthy = await waitForHealth(serverUrl)
  if (!healthy) {
    throw new Error(`OpenCode server failed health check at ${serverUrl}`)
  }
}

function startRcWatcher() {
  const env = {
    IMSG_BIN: options.imsgBin,
    OPENCODE_BIN: options.opencodeBin,
    IMSG_FALLBACK_TO_POLL: "1",
  }

  if (options.requestKinds) {
    env.OWPENBOT_REQUEST_KINDS = options.requestKinds
  }

  spawnManagedProcess(
    "rc-watcher",
    options.nodeBin,
    [
      rcWatcherScript,
      "--server-url",
      serverUrl,
      "--model",
      options.model,
      "--agent",
      options.agent,
      "--prompt",
      options.prompt,
    ],
    env,
    logFiles.rc,
    pidFiles.rc,
  )
}

function startWhatsappWatcher() {
  const env = {
    OPENCODE_BIN: options.opencodeBin,
  }
  const useWrapper = options.whatsappRealBin || basename(options.whatsappBin) === "wu"

  if (useWrapper) {
    env.WHATSAPP_BIN = whatsappCliWrapper
    env.WHATSAPP_REAL_BIN = options.whatsappRealBin || options.whatsappBin
  } else {
    env.WHATSAPP_BIN = options.whatsappBin
  }

  if (options.whatsappRequestKinds) {
    env.WHATSAPP_REQUEST_KINDS = options.whatsappRequestKinds
  } else if (options.requestKinds) {
    env.WHATSAPP_REQUEST_KINDS = options.requestKinds
  }

  spawnManagedProcess(
    "whatsapp-watcher",
    options.nodeBin,
    [
      whatsappWatcherScript,
      "--server-url",
      serverUrl,
      "--model",
      options.model,
      "--agent",
      options.agent,
      "--prompt",
      options.prompt,
    ],
    env,
    logFiles.whatsapp,
    pidFiles.whatsapp,
    3000,
  )
}

function stopChildren(signal = "SIGTERM") {
  for (const [, child] of processes) {
    if (child.exitCode === null) {
      try {
        child.kill(signal)
      } catch {}
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    log(`received ${signal}; shutting down`)
    stopChildren(signal)
    setTimeout(() => {
      removeFile(pidFiles.supervisor)
      process.exit(0)
    }, 1000).unref()
  })
}

process.on("exit", () => {
  removeFile(pidFiles.supervisor)
})

try {
  await startServer()
  startRcWatcher()
  startWhatsappWatcher()
  log(`service ready at ${serverUrl}`)
} catch (error) {
  log(error instanceof Error ? error.message : String(error))
  stopping = true
  stopChildren("SIGTERM")
  removeFile(pidFiles.supervisor)
  process.exit(1)
}

import { spawn } from "node:child_process"
import { chmod, mkdtemp, mkdir, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const testDir = dirname(fileURLToPath(import.meta.url))

export const repoRoot = resolve(testDir, "..")
export const fakeImsgPath = join(repoRoot, "scripts", "fake-imsg.js")
export const fakeWhatsappPath = join(repoRoot, "scripts", "fake-whatsapp.js")
export const fakeAmenPath = join(repoRoot, "scripts", "fake-amen.js")
export const imessageSourcePath = join(repoRoot, "tools-source", "imessage.js")
export const whatsappSourcePath = join(repoRoot, "tools-source", "whatsapp.js")
export const amenSourcePath = join(repoRoot, "tools-source", "amen.js")
export const globalImessagePath = "/Users/rrk/.config/opencode/tools/imessage.js"
export const globalAmenPath = "/Users/rrk/.config/opencode/tools/amen.js"
export const rcHeartbeatPath = join(repoRoot, "scripts", "rc-heartbeat.sh")
export const watchHeartbeatPath = join(repoRoot, "scripts", "watch-rc-heartbeat.js")
export const startStackPath = join(repoRoot, "scripts", "start-rc-heartbeat-stack.sh")
export const watchWhatsappHeartbeatPath = join(repoRoot, "scripts", "watch-whatsapp-heartbeat.js")
export const startWhatsappStackPath = join(repoRoot, "scripts", "start-whatsapp-heartbeat-stack.sh")
export const runAllHeartbeatServicePath = join(repoRoot, "scripts", "run-all-heartbeat-service.js")
export const startAllStackPath = join(repoRoot, "scripts", "start-all-heartbeat-stack.sh")
export const checkAmenHeartbeatPath = join(repoRoot, "scripts", "check-amen-heartbeat.js")

export async function makeTempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function makeTempHome(prefix = "opencode-imsg-home-") {
  const home = await makeTempDir(prefix)
  await mkdir(join(home, ".config", "opencode", "state", "imessage-oc"), { recursive: true })
  await mkdir(join(home, ".config", "opencode", "state", "whatsapp-oc"), { recursive: true })
  return home
}

export function stateDirForHome(home, kind = "imessage") {
  const folder = kind === "whatsapp" ? "whatsapp-oc" : "imessage-oc"
  return join(home, ".config", "opencode", "state", folder)
}

export function encodeStateKey(value) {
  return Buffer.from(value, "utf8").toString("hex")
}

export async function writeStateRecord(home, messageGuid, type, record, options = {}) {
  const stateDir = stateDirForHome(home, options.channel ?? "imessage")
  const suffix = type === "pending" ? ".pending.json" : ".json"
  const filePath = join(stateDir, `${encodeStateKey(messageGuid)}${suffix}`)

  await writeFile(filePath, JSON.stringify(record, null, 2))

  if (options.mtime) {
    await utimes(filePath, options.mtime, options.mtime)
  }

  return filePath
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"))
}

export async function readNdjson(filePath) {
  const content = await readFile(filePath, "utf8")
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

export async function listDirectory(filePath) {
  try {
    return await readdir(filePath)
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}

export function parseToolResult(resultText) {
  return JSON.parse(resultText)
}

export async function importFreshModule(modulePath, envOverrides = {}) {
  return await withEnv(envOverrides, async () => {
    const moduleUrl = `${pathToFileURL(modulePath).href}?t=${Date.now()}-${Math.random()}`
    return await import(moduleUrl)
  })
}

export async function withEnv(envOverrides, callback) {
  const previous = new Map()

  for (const [key, value] of Object.entries(envOverrides)) {
    previous.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = String(value)
  }

  try {
    return await callback()
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

export async function createOpencodeStub(directory) {
  const stubPath = join(directory, "opencode-stub")
  const source = `#!/usr/bin/env node
import { appendFileSync } from "node:fs"

const logFile = process.env.OPENCODE_STUB_LOG_FILE
const sleepMs = Number.parseInt(process.env.OPENCODE_STUB_SLEEP_MS ?? "0", 10)
const exitCode = Number.parseInt(process.env.OPENCODE_STUB_EXIT_CODE ?? "0", 10)

if (logFile) {
  appendFileSync(logFile, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n")
}

if (Number.isFinite(sleepMs) && sleepMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, sleepMs))
}

process.exit(Number.isFinite(exitCode) ? exitCode : 0)
`

  await writeFile(stubPath, source)
  await chmod(stubPath, 0o755)
  return stubPath
}

export async function createOpencodeServeStub(directory) {
  const stubPath = join(directory, "opencode-serve-stub")
  const source = `#!/usr/bin/env node
import { appendFileSync } from "node:fs"
import { createServer } from "node:http"

const args = process.argv.slice(2)
const logFile = process.env.OPENCODE_STUB_LOG_FILE

if (logFile) {
  appendFileSync(logFile, JSON.stringify({ argv: args }) + "\\n")
}

if (args[0] !== "serve") {
  process.exit(0)
}

const hostIndex = args.indexOf("--hostname")
const portIndex = args.indexOf("--port")
const hostname = hostIndex >= 0 ? args[hostIndex + 1] : "127.0.0.1"
const port = portIndex >= 0 ? Number.parseInt(args[portIndex + 1], 10) : 4096

const server = createServer((req, res) => {
  if (req.url === "/global/health") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ healthy: true, version: "test" }))
    return
  }

  res.writeHead(404)
  res.end("not found")
})

server.listen(port, hostname)

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}
`

  await writeFile(stubPath, source)
  await chmod(stubPath, 0o755)
  return stubPath
}

export async function runCommand(command, args, options = {}) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })

    child.on("error", reject)
    child.on("close", (code, signal) => {
      resolvePromise({
        code,
        signal,
        stdout,
        stderr,
      })
    })
  })
}

export async function fileExists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

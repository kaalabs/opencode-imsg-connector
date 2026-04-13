import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { request } from "node:http"
import { join } from "node:path"
import test from "node:test"
import { spawn } from "node:child_process"

import {
  createOpencodeServeStub,
  fakeImsgPath,
  fakeWhatsappPath,
  makeTempDir,
  runAllHeartbeatServicePath,
} from "./helpers.js"

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => {
        body += chunk
      })
      res.on("end", () => {
        resolve({ statusCode: res.statusCode ?? 0, body })
      })
    })

    req.on("error", reject)
    req.end()
  })
}

async function waitFor(check, attempts = 50, delayMs = 200) {
  let lastError

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await check()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  throw lastError ?? new Error("waitFor attempts exhausted")
}

test("run-all-heartbeat-service.js keeps the server and both watchers alive", async (t) => {
  const tempDir = await makeTempDir("opencode-run-all-service-")
  const runtimeDir = join(tempDir, "runtime")
  const logFile = join(tempDir, "opencode-log.ndjson")
  const opencodeStub = await createOpencodeServeStub(tempDir)
  const port = String(47000 + Math.floor(Math.random() * 10000))

  const child = spawn(
    process.execPath,
    [
      runAllHeartbeatServicePath,
      "--hostname",
      "127.0.0.1",
      "--port",
      port,
      "--runtime-dir",
      runtimeDir,
      "--imsg-bin",
      fakeImsgPath,
      "--whatsapp-bin",
      fakeWhatsappPath,
      "--opencode-bin",
      opencodeStub,
      "--node-bin",
      process.execPath,
    ],
    {
      env: {
        ...process.env,
        FAKE_IMSG_WATCH_LINES: " ",
        FAKE_IMSG_WATCH_SLEEP_MS: "5000",
        FAKE_WHATSAPP_WATCH_LINES: " ",
        FAKE_WHATSAPP_WATCH_SLEEP_MS: "5000",
        OPENCODE_STUB_LOG_FILE: logFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  let stderr = ""
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
  })

  t.after(() => {
    child.kill("SIGTERM")
  })

  await waitFor(async () => {
    const response = await httpGet(`http://127.0.0.1:${port}/global/health`)
    assert.equal(response.statusCode, 200)
  })

  const serverPid = await waitFor(async () => (await readFile(join(runtimeDir, "opencode-server.pid"), "utf8")).trim())
  const rcPid = await waitFor(async () => (await readFile(join(runtimeDir, "rc-heartbeat-watcher.pid"), "utf8")).trim())
  const whatsappPid = await waitFor(async () => (await readFile(join(runtimeDir, "whatsapp-heartbeat-watcher.pid"), "utf8")).trim())

  assert.match(serverPid, /^\d+$/)
  assert.match(rcPid, /^\d+$/)
  assert.match(whatsappPid, /^\d+$/)

  process.kill(Number.parseInt(serverPid, 10), 0)
  process.kill(Number.parseInt(rcPid, 10), 0)
  process.kill(Number.parseInt(whatsappPid, 10), 0)

  assert.match(stderr, /service ready/)
})

test("run-all-heartbeat-service.js forwards the shared RC_HEARTBEAT prompt to both watchers", async (t) => {
  const tempDir = await makeTempDir("opencode-run-all-service-shared-prompt-")
  const runtimeDir = join(tempDir, "runtime")
  const logFile = join(tempDir, "opencode-log.ndjson")
  const opencodeStub = await createOpencodeServeStub(tempDir)
  const port = String(47000 + Math.floor(Math.random() * 10000))
  const imessageEvent = JSON.stringify({
    id: 1,
    guid: "IMSG-GUID-1",
    chat_id: 98,
    is_from_me: false,
    text: "@RC: hello from iMessage",
    created_at: "2026-03-30T09:33:23.538Z",
  })
  const whatsappEvent = JSON.stringify({
    id: "1",
    guid: "WA-GUID-1",
    chat_id: "+31612605237",
    from_me: false,
    text: "@RC: hello from WhatsApp",
    created_at: "2026-03-30T09:33:23.538Z",
  })

  const child = spawn(
    process.execPath,
    [
      runAllHeartbeatServicePath,
      "--hostname",
      "127.0.0.1",
      "--port",
      port,
      "--runtime-dir",
      runtimeDir,
      "--imsg-bin",
      fakeImsgPath,
      "--whatsapp-bin",
      fakeWhatsappPath,
      "--opencode-bin",
      opencodeStub,
      "--node-bin",
      process.execPath,
    ],
    {
      env: {
        ...process.env,
        FAKE_IMSG_WATCH_LINES: imessageEvent,
        FAKE_IMSG_WATCH_SLEEP_MS: "5000",
        FAKE_WHATSAPP_WATCH_LINES: whatsappEvent,
        FAKE_WHATSAPP_WATCH_SLEEP_MS: "5000",
        OPENCODE_STUB_LOG_FILE: logFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  t.after(() => {
    child.kill("SIGTERM")
  })

  await waitFor(async () => {
    const response = await httpGet(`http://127.0.0.1:${port}/global/health`)
    assert.equal(response.statusCode, 200)
  })

  const runEntries = await waitFor(async () => {
    const entries = (await readFile(logFile, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.argv[0] === "run")

    assert.equal(entries.length, 2)
    return entries
  })

  assert.deepEqual(
    runEntries.map((entry) => entry.argv),
    [
      ["run", "--attach", `http://127.0.0.1:${port}`, "--model", "openai/gpt-5.4", "--agent", "build", "RC_HEARTBEAT"],
      ["run", "--attach", `http://127.0.0.1:${port}`, "--model", "openai/gpt-5.4", "--agent", "build", "RC_HEARTBEAT"],
    ],
  )
})

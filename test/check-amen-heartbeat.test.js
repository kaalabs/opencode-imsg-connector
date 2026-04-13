import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { request } from "node:http"
import { join } from "node:path"
import test from "node:test"
import { spawn } from "node:child_process"

import {
  checkAmenHeartbeatPath,
  createOpencodeServeStub,
  fakeAmenPath,
  makeTempDir,
  readNdjson,
  runCommand,
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

async function startStubServer(tempDir, logFile, port, t) {
  const opencodeStub = await createOpencodeServeStub(tempDir)
  const child = spawn(opencodeStub, ["serve", "--hostname", "127.0.0.1", "--port", port], {
    env: {
      ...process.env,
      OPENCODE_STUB_LOG_FILE: logFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  t.after(() => {
    child.kill("SIGTERM")
  })

  await waitFor(async () => {
    const response = await httpGet(`http://127.0.0.1:${port}/global/health`)
    assert.equal(response.statusCode, 200)
  })

  return opencodeStub
}

test("check-amen-heartbeat triggers RC_HEARTBEAT when amen reports queued mail", async (t) => {
  const tempDir = await makeTempDir("opencode-check-amen-heartbeat-")
  const runtimeDir = join(tempDir, "runtime")
  const logFile = join(tempDir, "opencode-log.ndjson")
  const port = String(48000 + Math.floor(Math.random() * 10000))
  const opencodeStub = await startStubServer(tempDir, logFile, port, t)

  const result = await runCommand(
    process.execPath,
    [
      checkAmenHeartbeatPath,
      "--server-url",
      `http://127.0.0.1:${port}`,
      "--runtime-dir",
      runtimeDir,
      "--amen-bin",
      fakeAmenPath,
      "--opencode-bin",
      opencodeStub,
    ],
    {
      env: {
        FAKE_AMEN_CHECK_JSON: JSON.stringify({
          mailboxCounts: [{ mailboxDisplayName: "Inbox", newMessageCount: 2 }],
          refreshed: true,
          totalNewMessages: 2,
        }),
        OPENCODE_STUB_LOG_FILE: logFile,
      },
    },
  )

  assert.equal(result.code, 0)
  const entries = await readNdjson(logFile)
  const runEntries = entries.filter((entry) => entry.argv[0] === "run")
  assert.deepEqual(runEntries.map((entry) => entry.argv), [
    ["run", "--attach", `http://127.0.0.1:${port}`, "--model", "openai/gpt-5.4", "--agent", "build", "RC_HEARTBEAT"],
  ])
})

test("check-amen-heartbeat skips RC_HEARTBEAT when amen has no queued mail", async (t) => {
  const tempDir = await makeTempDir("opencode-check-amen-heartbeat-empty-")
  const runtimeDir = join(tempDir, "runtime")
  const logFile = join(tempDir, "opencode-log.ndjson")
  const port = String(48000 + Math.floor(Math.random() * 10000))
  const opencodeStub = await startStubServer(tempDir, logFile, port, t)

  const result = await runCommand(
    process.execPath,
    [
      checkAmenHeartbeatPath,
      "--server-url",
      `http://127.0.0.1:${port}`,
      "--runtime-dir",
      runtimeDir,
      "--amen-bin",
      fakeAmenPath,
      "--opencode-bin",
      opencodeStub,
    ],
    {
      env: {
        FAKE_AMEN_CHECK_JSON: JSON.stringify({
          mailboxCounts: [],
          refreshed: true,
          totalNewMessages: 0,
        }),
        OPENCODE_STUB_LOG_FILE: logFile,
      },
    },
  )

  assert.equal(result.code, 0)
  const entries = await readNdjson(logFile)
  const runEntries = entries.filter((entry) => entry.argv[0] === "run")
  assert.equal(runEntries.length, 0)
})

test("check-amen-heartbeat runs the heartbeat even when PATH is empty", async (t) => {
  const tempDir = await makeTempDir("opencode-check-amen-heartbeat-path-")
  const runtimeDir = join(tempDir, "runtime")
  const logFile = join(tempDir, "opencode-log.ndjson")
  const port = String(48000 + Math.floor(Math.random() * 10000))
  const opencodeStub = await startStubServer(tempDir, logFile, port, t)

  const result = await runCommand(
    process.execPath,
    [
      checkAmenHeartbeatPath,
      "--server-url",
      `http://127.0.0.1:${port}`,
      "--runtime-dir",
      runtimeDir,
      "--amen-bin",
      fakeAmenPath,
      "--opencode-bin",
      opencodeStub,
    ],
    {
      env: {
        PATH: "",
        FAKE_AMEN_CHECK_JSON: JSON.stringify({
          mailboxCounts: [{ mailboxDisplayName: "Inbox", newMessageCount: 1 }],
          refreshed: true,
          totalNewMessages: 1,
        }),
        OPENCODE_STUB_LOG_FILE: logFile,
      },
    },
  )

  assert.equal(result.code, 0)
  const entries = await readNdjson(logFile)
  const runEntries = entries.filter((entry) => entry.argv[0] === "run")
  assert.equal(runEntries.length, 1)
})

test("check-amen-heartbeat falls back to queued headlines when amen check fails", async (t) => {
  const tempDir = await makeTempDir("opencode-check-amen-heartbeat-fallback-")
  const runtimeDir = join(tempDir, "runtime")
  const logFile = join(tempDir, "opencode-log.ndjson")
  const port = String(48000 + Math.floor(Math.random() * 10000))
  const opencodeStub = await startStubServer(tempDir, logFile, port, t)

  const result = await runCommand(
    process.execPath,
    [
      checkAmenHeartbeatPath,
      "--server-url",
      `http://127.0.0.1:${port}`,
      "--runtime-dir",
      runtimeDir,
      "--amen-bin",
      fakeAmenPath,
      "--opencode-bin",
      opencodeStub,
    ],
    {
      env: {
        FAKE_AMEN_FAIL_COMMAND: "check",
        FAKE_AMEN_FAIL_STDERR: "simulated amen check failure",
        FAKE_AMEN_HEADLINES_JSON: JSON.stringify({
          messages: [
            {
              rfcMessageID: "msg-1@example.com",
              sender: "Alice <alice@example.com>",
              subject: "Needs review",
            },
          ],
        }),
        OPENCODE_STUB_LOG_FILE: logFile,
      },
    },
  )

  assert.equal(result.code, 0)
  assert.match(result.stderr, /amen check failed: simulated amen check failure/)
  assert.match(result.stderr, /amen still has 1 queued email\(s\); continuing with heartbeat/)

  const entries = await readNdjson(logFile)
  const runEntries = entries.filter((entry) => entry.argv[0] === "run")
  assert.equal(runEntries.length, 1)
})

test("check-amen-heartbeat exits cleanly when another run holds the lock", async (t) => {
  const tempDir = await makeTempDir("opencode-check-amen-heartbeat-lock-")
  const runtimeDir = join(tempDir, "runtime")
  const logFile = join(tempDir, "opencode-log.ndjson")
  const port = String(48000 + Math.floor(Math.random() * 10000))
  const opencodeStub = await startStubServer(tempDir, logFile, port, t)
  const lockPath = join(runtimeDir, "amen-heartbeat.lock")

  await mkdir(runtimeDir, { recursive: true })
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2))

  const result = await runCommand(
    process.execPath,
    [
      checkAmenHeartbeatPath,
      "--server-url",
      `http://127.0.0.1:${port}`,
      "--runtime-dir",
      runtimeDir,
      "--amen-bin",
      fakeAmenPath,
      "--opencode-bin",
      opencodeStub,
    ],
    {
      env: {
        FAKE_AMEN_CHECK_JSON: JSON.stringify({
          mailboxCounts: [{ mailboxDisplayName: "Inbox", newMessageCount: 1 }],
          refreshed: true,
          totalNewMessages: 1,
        }),
        OPENCODE_STUB_LOG_FILE: logFile,
      },
    },
  )

  assert.equal(result.code, 0)
  assert.match(result.stderr, /another amen heartbeat run is active/)

  const entries = (await readFile(logFile, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.argv[0] === "run")
  assert.equal(entries.length, 0)
})

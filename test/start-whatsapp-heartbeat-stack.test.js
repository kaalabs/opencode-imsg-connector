import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { readFile } from "node:fs/promises"

import {
  createOpencodeServeStub,
  fakeWhatsappPath,
  makeTempDir,
  readNdjson,
  runCommand,
  startWhatsappStackPath,
} from "./helpers.js"

test("start-whatsapp-heartbeat-stack.sh starts the server and watcher and is idempotent", async (t) => {
  const tempDir = await makeTempDir("opencode-start-whatsapp-stack-")
  const runtimeDir = join(tempDir, "runtime")
  const logFile = join(tempDir, "opencode-log.ndjson")
  const opencodeStub = await createOpencodeServeStub(tempDir)
  const port = String(46000 + Math.floor(Math.random() * 10000))

  const env = {
    OPENCODE_BIN: opencodeStub,
    NODE_BIN: process.execPath,
    WHATSAPP_BIN: fakeWhatsappPath,
    FAKE_WHATSAPP_WATCH_LINES: " ",
    FAKE_WHATSAPP_WATCH_SLEEP_MS: "5000",
    OPENCODE_STUB_LOG_FILE: logFile,
  }

  const cleanup = async () => {
    for (const fileName of ["opencode-server.pid", "whatsapp-heartbeat-watcher.pid"]) {
      try {
        const pid = (await readFile(join(runtimeDir, fileName), "utf8")).trim()
        if (pid) {
          process.kill(Number.parseInt(pid, 10), "SIGTERM")
        }
      } catch {}
    }
  }

  t.after(cleanup)

  const first = await runCommand(
    "/bin/bash",
    [startWhatsappStackPath, "--hostname", "127.0.0.1", "--port", port, "--runtime-dir", runtimeDir],
    { env },
  )

  assert.equal(first.code, 0)
  assert.match(first.stdout, /OpenCode server started at http:\/\/127\.0\.0\.1:/)
  assert.match(first.stdout, /WhatsApp heartbeat watcher started/)

  const firstServerPid = (await readFile(join(runtimeDir, "opencode-server.pid"), "utf8")).trim()
  const firstWatcherPid = (await readFile(join(runtimeDir, "whatsapp-heartbeat-watcher.pid"), "utf8")).trim()

  const second = await runCommand(
    "/bin/bash",
    [startWhatsappStackPath, "--hostname", "127.0.0.1", "--port", port, "--runtime-dir", runtimeDir],
    { env },
  )

  assert.equal(second.code, 0)
  assert.match(second.stdout, /OpenCode server already running/)
  assert.match(second.stdout, /WhatsApp heartbeat watcher already running/)

  const secondServerPid = (await readFile(join(runtimeDir, "opencode-server.pid"), "utf8")).trim()
  const secondWatcherPid = (await readFile(join(runtimeDir, "whatsapp-heartbeat-watcher.pid"), "utf8")).trim()

  assert.equal(secondServerPid, firstServerPid)
  assert.equal(secondWatcherPid, firstWatcherPid)

  const invocations = await readNdjson(logFile)
  assert.equal(invocations.filter((entry) => entry.argv[0] === "serve").length, 1)
})

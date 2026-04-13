import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import {
  createOpencodeServeStub,
  fakeImsgPath,
  fakeWhatsappPath,
  makeTempDir,
  runCommand,
  startAllStackPath,
} from "./helpers.js"

test("start-all-heartbeat-stack.sh starts the combined supervisor and is idempotent", async (t) => {
  const tempDir = await makeTempDir("opencode-start-all-stack-")
  const runtimeDir = join(tempDir, "runtime")
  const logFile = join(tempDir, "opencode-log.ndjson")
  const opencodeStub = await createOpencodeServeStub(tempDir)
  const port = String(48000 + Math.floor(Math.random() * 10000))

  const env = {
    OPENCODE_BIN: opencodeStub,
    NODE_BIN: process.execPath,
    IMSG_BIN: fakeImsgPath,
    WHATSAPP_BIN: fakeWhatsappPath,
    FAKE_IMSG_WATCH_LINES: " ",
    FAKE_IMSG_WATCH_SLEEP_MS: "5000",
    FAKE_WHATSAPP_WATCH_LINES: " ",
    FAKE_WHATSAPP_WATCH_SLEEP_MS: "5000",
    OPENCODE_STUB_LOG_FILE: logFile,
  }

  const cleanup = async () => {
    for (const fileName of [
      "heartbeat-supervisor.pid",
      "opencode-server.pid",
      "rc-heartbeat-watcher.pid",
      "whatsapp-heartbeat-watcher.pid",
    ]) {
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
    [startAllStackPath, "--hostname", "127.0.0.1", "--port", port, "--runtime-dir", runtimeDir],
    { env },
  )

  assert.equal(first.code, 0)
  assert.match(first.stdout, /Heartbeat supervisor started/)
  assert.match(first.stdout, /Both watchers started against: http:\/\/127\.0\.0\.1:/)

  const firstSupervisorPid = (await readFile(join(runtimeDir, "heartbeat-supervisor.pid"), "utf8")).trim()
  const firstServerPid = (await readFile(join(runtimeDir, "opencode-server.pid"), "utf8")).trim()
  const firstRcPid = (await readFile(join(runtimeDir, "rc-heartbeat-watcher.pid"), "utf8")).trim()
  const firstWhatsappPid = (await readFile(join(runtimeDir, "whatsapp-heartbeat-watcher.pid"), "utf8")).trim()

  const second = await runCommand(
    "/bin/bash",
    [startAllStackPath, "--hostname", "127.0.0.1", "--port", port, "--runtime-dir", runtimeDir],
    { env },
  )

  assert.equal(second.code, 0)
  assert.match(second.stdout, /Heartbeat supervisor already running/)

  const secondSupervisorPid = (await readFile(join(runtimeDir, "heartbeat-supervisor.pid"), "utf8")).trim()
  const secondServerPid = (await readFile(join(runtimeDir, "opencode-server.pid"), "utf8")).trim()
  const secondRcPid = (await readFile(join(runtimeDir, "rc-heartbeat-watcher.pid"), "utf8")).trim()
  const secondWhatsappPid = (await readFile(join(runtimeDir, "whatsapp-heartbeat-watcher.pid"), "utf8")).trim()

  assert.equal(secondSupervisorPid, firstSupervisorPid)
  assert.equal(secondServerPid, firstServerPid)
  assert.equal(secondRcPid, firstRcPid)
  assert.equal(secondWhatsappPid, firstWhatsappPid)
})

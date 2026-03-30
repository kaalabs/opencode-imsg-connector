import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"

import { createOpencodeStub, makeTempDir, rcHeartbeatPath, readNdjson, runCommand } from "./helpers.js"

test("rc-heartbeat.sh forwards server, model, agent, and prompt to opencode run --attach", async () => {
  const tempDir = await makeTempDir("opencode-rc-heartbeat-")
  const logFile = join(tempDir, "opencode-log.ndjson")
  const stubPath = await createOpencodeStub(tempDir)

  const result = await runCommand(
    "/bin/bash",
    [
      rcHeartbeatPath,
      "--server-url",
      "http://localhost:4096",
      "--model",
      "openai/gpt-5.4-mini",
      "--agent",
      "build",
      "--prompt",
      "RC_HEARTBEAT",
    ],
    {
      env: {
        OPENCODE_BIN: stubPath,
        OPENCODE_STUB_LOG_FILE: logFile,
      },
    },
  )

  assert.equal(result.code, 0)
  assert.deepEqual((await readNdjson(logFile)).map((entry) => entry.argv), [
    ["run", "--attach", "http://localhost:4096", "--model", "openai/gpt-5.4-mini", "--agent", "build", "RC_HEARTBEAT"],
  ])
})

test("rc-heartbeat.sh rejects unknown arguments", async () => {
  const result = await runCommand("/bin/bash", [rcHeartbeatPath, "--bogus"], {})

  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /Unknown argument: --bogus/)
  assert.match(result.stderr, /Usage: rc-heartbeat.sh/)
})

test("rc-heartbeat.sh requires server-url and prompt", async () => {
  const result = await runCommand("/bin/bash", [rcHeartbeatPath, "--server-url", "http://localhost:4096"], {})

  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /Usage: rc-heartbeat.sh/)
})

test("rc-heartbeat.sh fails cleanly when the opencode binary is missing", async () => {
  const result = await runCommand(
    "/bin/bash",
    [rcHeartbeatPath, "--server-url", "http://localhost:4096", "--prompt", "RC_HEARTBEAT"],
    {
      env: {
        OPENCODE_BIN: "/tmp/definitely-missing-opencode",
      },
    },
  )

  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /OpenCode CLI not found: \/tmp\/definitely-missing-opencode/)
})

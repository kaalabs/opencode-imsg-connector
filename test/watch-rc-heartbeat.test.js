import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"

import {
  createOpencodeStub,
  fakeImsgPath,
  makeTempDir,
  readNdjson,
  runCommand,
  watchHeartbeatPath,
} from "./helpers.js"

function messageEvent(overrides) {
  return JSON.stringify({
    id: 1,
    guid: "GUID-1",
    chat_id: 98,
    is_from_me: false,
    text: "@RC: hello!",
    created_at: "2026-03-30T09:33:23.538Z",
    ...overrides,
  })
}

test("watch-rc-heartbeat suppresses duplicate events by guid", async () => {
  const tempDir = await makeTempDir("opencode-watch-dup-")
  const logFile = join(tempDir, "opencode-log.ndjson")
  const stubPath = await createOpencodeStub(tempDir)

  const result = await runCommand(
    process.execPath,
    [watchHeartbeatPath, "--server-url", "http://localhost:4096", "--prompt", "RC_HEARTBEAT"],
    {
      env: {
        IMSG_BIN: fakeImsgPath,
        OPENCODE_BIN: stubPath,
        OPENCODE_STUB_LOG_FILE: logFile,
        FAKE_IMSG_WATCH_LINES: [messageEvent(), messageEvent()].join("\n"),
        FAKE_IMSG_WATCH_SLEEP_MS: "200",
      },
    },
  )

  assert.equal(result.code, 0)
  assert.equal((await readNdjson(logFile)).length, 1)
})

test("watch-rc-heartbeat coalesces burst traffic into one active heartbeat plus one rerun", async () => {
  const tempDir = await makeTempDir("opencode-watch-burst-")
  const logFile = join(tempDir, "opencode-log.ndjson")
  const stubPath = await createOpencodeStub(tempDir)

  const result = await runCommand(
    process.execPath,
    [watchHeartbeatPath, "--server-url", "http://localhost:4096", "--prompt", "RC_HEARTBEAT"],
    {
      env: {
        IMSG_BIN: fakeImsgPath,
        OPENCODE_BIN: stubPath,
        OPENCODE_STUB_LOG_FILE: logFile,
        OPENCODE_STUB_SLEEP_MS: "150",
        FAKE_IMSG_WATCH_LINES: [
          messageEvent({ id: 1, guid: "GUID-1" }),
          messageEvent({ id: 2, guid: "GUID-2" }),
          messageEvent({ id: 3, guid: "GUID-3" }),
        ].join("\n"),
        FAKE_IMSG_WATCH_SLEEP_MS: "600",
      },
    },
  )

  assert.equal(result.code, 0)
  assert.equal((await readNdjson(logFile)).length, 2)
})

test("watch-rc-heartbeat ignores non-JSON watch lines and still processes valid events", async () => {
  const tempDir = await makeTempDir("opencode-watch-junk-")
  const logFile = join(tempDir, "opencode-log.ndjson")
  const stubPath = await createOpencodeStub(tempDir)

  const result = await runCommand(
    process.execPath,
    [watchHeartbeatPath, "--server-url", "http://localhost:4096", "--prompt", "RC_HEARTBEAT"],
    {
      env: {
        IMSG_BIN: fakeImsgPath,
        OPENCODE_BIN: stubPath,
        OPENCODE_STUB_LOG_FILE: logFile,
        FAKE_IMSG_WATCH_LINES: ["not-json", messageEvent({ id: 8, guid: "GUID-8" })].join("\n"),
        FAKE_IMSG_WATCH_SLEEP_MS: "200",
      },
    },
  )

  assert.equal(result.code, 0)
  assert.match(result.stderr, /ignoring non-JSON watch line: not-json/)
  assert.equal((await readNdjson(logFile)).length, 1)
})

test("watch-rc-heartbeat exits nonzero when imsg watch exits nonzero", async () => {
  const tempDir = await makeTempDir("opencode-watch-exit-")
  const stubPath = await createOpencodeStub(tempDir)

  const result = await runCommand(
    process.execPath,
    [watchHeartbeatPath, "--server-url", "http://localhost:4096", "--prompt", "RC_HEARTBEAT"],
    {
      env: {
        IMSG_BIN: fakeImsgPath,
        OPENCODE_BIN: stubPath,
        FAKE_IMSG_WATCH_LINES: "",
        FAKE_IMSG_WATCH_EXIT_CODE: "4",
      },
    },
  )

  assert.equal(result.code, 4)
})

import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"

import {
  createOpencodeStub,
  fakeWhatsappPath,
  makeTempDir,
  readNdjson,
  runCommand,
  watchWhatsappHeartbeatPath,
} from "./helpers.js"

function messageEvent(overrides) {
  return JSON.stringify({
    id: "1",
    guid: "GUID-1",
    chat_id: "+31612605237",
    from_me: false,
    text: "@RC: hello!",
    created_at: "2026-03-30T09:33:23.538Z",
    ...overrides,
  })
}

test("watch-whatsapp-heartbeat uses RC_HEARTBEAT and gpt-5.4 by default", async () => {
  const tempDir = await makeTempDir("opencode-watch-whatsapp-default-model-")
  const logFile = join(tempDir, "opencode-log.ndjson")
  const stubPath = await createOpencodeStub(tempDir)

  const result = await runCommand(process.execPath, [watchWhatsappHeartbeatPath, "--server-url", "http://localhost:4096"], {
    env: {
      WHATSAPP_BIN: fakeWhatsappPath,
      OPENCODE_BIN: stubPath,
      OPENCODE_STUB_LOG_FILE: logFile,
      FAKE_WHATSAPP_WATCH_LINES: messageEvent(),
      FAKE_WHATSAPP_WATCH_SLEEP_MS: "200",
    },
  })

  assert.equal(result.code, 0)
  assert.deepEqual((await readNdjson(logFile)).map((entry) => entry.argv), [
    ["run", "--attach", "http://localhost:4096", "--model", "openai/gpt-5.4", "--agent", "build", "RC_HEARTBEAT"],
  ])
})

test("watch-whatsapp-heartbeat suppresses duplicate events by id", async () => {
  const tempDir = await makeTempDir("opencode-watch-whatsapp-dup-")
  const logFile = join(tempDir, "opencode-log.ndjson")
  const stubPath = await createOpencodeStub(tempDir)

  const result = await runCommand(
    process.execPath,
    [watchWhatsappHeartbeatPath, "--server-url", "http://localhost:4096", "--prompt", "RC_HEARTBEAT"],
    {
      env: {
        WHATSAPP_BIN: fakeWhatsappPath,
        OPENCODE_BIN: stubPath,
        OPENCODE_STUB_LOG_FILE: logFile,
        FAKE_WHATSAPP_WATCH_LINES: [messageEvent({ id: "1", guid: "GUID-1" }), messageEvent({ id: "1", guid: "GUID-1" })].join("\n"),
        FAKE_WHATSAPP_WATCH_SLEEP_MS: "200",
      },
    },
  )

  assert.equal(result.code, 0)
  assert.equal((await readNdjson(logFile)).length, 1)
})

test("watch-whatsapp-heartbeat coalesces burst traffic into one active heartbeat plus one rerun", async () => {
  const tempDir = await makeTempDir("opencode-watch-whatsapp-burst-")
  const logFile = join(tempDir, "opencode-log.ndjson")
  const stubPath = await createOpencodeStub(tempDir)

  const result = await runCommand(
    process.execPath,
    [watchWhatsappHeartbeatPath, "--server-url", "http://localhost:4096", "--prompt", "RC_HEARTBEAT"],
    {
      env: {
        WHATSAPP_BIN: fakeWhatsappPath,
        OPENCODE_BIN: stubPath,
        OPENCODE_STUB_LOG_FILE: logFile,
        OPENCODE_STUB_SLEEP_MS: "150",
        FAKE_WHATSAPP_WATCH_LINES: [
          messageEvent({ id: "1", guid: "GUID-1" }),
          messageEvent({ id: "2", guid: "GUID-2" }),
          messageEvent({ id: "3", guid: "GUID-3" }),
        ].join("\n"),
        FAKE_WHATSAPP_WATCH_SLEEP_MS: "600",
      },
    },
  )

  assert.equal(result.code, 0)
  assert.equal((await readNdjson(logFile)).length, 2)
})

test("watch-whatsapp-heartbeat ignores non-JSON watch lines and still processes valid events", async () => {
  const tempDir = await makeTempDir("opencode-watch-whatsapp-junk-")
  const logFile = join(tempDir, "opencode-log.ndjson")
  const stubPath = await createOpencodeStub(tempDir)

  const result = await runCommand(
    process.execPath,
    [watchWhatsappHeartbeatPath, "--server-url", "http://localhost:4096", "--prompt", "RC_HEARTBEAT"],
    {
      env: {
        WHATSAPP_BIN: fakeWhatsappPath,
        OPENCODE_BIN: stubPath,
        OPENCODE_STUB_LOG_FILE: logFile,
        FAKE_WHATSAPP_WATCH_LINES: ["not-json", messageEvent({ id: "8", guid: "GUID-8" })].join("\n"),
        FAKE_WHATSAPP_WATCH_SLEEP_MS: "200",
      },
    },
  )

  assert.equal(result.code, 0)
  assert.match(result.stderr, /ignoring non-JSON watch line: not-json/)
  assert.equal((await readNdjson(logFile)).length, 1)
})

test("watch-whatsapp-heartbeat exits nonzero when whatsapp watch exits nonzero", async () => {
  const tempDir = await makeTempDir("opencode-watch-whatsapp-exit-")
  const stubPath = await createOpencodeStub(tempDir)

  const result = await runCommand(
    process.execPath,
    [watchWhatsappHeartbeatPath, "--server-url", "http://localhost:4096", "--prompt", "RC_HEARTBEAT"],
    {
      env: {
        WHATSAPP_BIN: fakeWhatsappPath,
        OPENCODE_BIN: stubPath,
        FAKE_WHATSAPP_WATCH_LINES: "",
        FAKE_WHATSAPP_WATCH_EXIT_CODE: "4",
      },
    },
  )

  assert.equal(result.code, 4)
})

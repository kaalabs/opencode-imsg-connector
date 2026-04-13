import assert from "node:assert/strict"
import test from "node:test"

import {
  amenSourcePath,
  fakeAmenPath,
  globalAmenPath,
  importFreshModule,
  makeTempDir,
  parseToolResult,
  readNdjson,
  withEnv,
} from "./helpers.js"

test("amen tools parse headlines, message-id, and fetch JSON", async () => {
  const messageId = "msg-1@example.com"
  const env = {
    AMEN_BIN: fakeAmenPath,
    FAKE_AMEN_HEADLINES_JSON: JSON.stringify({
      messages: [
        {
          rfcMessageID: messageId,
          sender: "Alice <alice@example.com>",
          subject: "Quarterly update",
        },
      ],
    }),
    FAKE_AMEN_MESSAGE_ID_MAP_JSON: JSON.stringify({
      [messageId]: {
        requestedMessageID: messageId,
        messages: [
          {
            rfcMessageID: messageId,
            sender: "Alice <alice@example.com>",
            subject: "Quarterly update",
            content: "Body",
          },
        ],
        errors: [],
      },
    }),
    FAKE_AMEN_FETCH_JSON: JSON.stringify({
      messages: [
        {
          rfcMessageID: messageId,
        },
      ],
      errors: [],
    }),
  }
  const module = await importFreshModule(amenSourcePath, env)

  const headlines = await withEnv(env, async () => parseToolResult(await module.headlines.execute({})))
  const fetched = await withEnv(env, async () => parseToolResult(await module.message_id.execute({ messageId })))
  const cleared = await withEnv(env, async () => parseToolResult(await module.fetch.execute({})))

  assert.equal(headlines.messages[0].rfcMessageID, messageId)
  assert.equal(fetched.messages[0].content, "Body")
  assert.equal(cleared.messages[0].rfcMessageID, messageId)
})

test("amen check passes --no-refresh-mail when refreshMail is false", async () => {
  const tempDir = await makeTempDir("opencode-amen-tool-")
  const logFile = `${tempDir}/fake-amen-log.ndjson`
  const env = {
    AMEN_BIN: fakeAmenPath,
    FAKE_AMEN_LOG_FILE: logFile,
    FAKE_AMEN_CHECK_JSON: JSON.stringify({
      mailboxCounts: [],
      refreshed: false,
      totalNewMessages: 0,
    }),
  }
  const module = await importFreshModule(amenSourcePath, env)

  const result = await withEnv(env, async () => parseToolResult(await module.check.execute({ refreshMail: false })))
  const logEntries = await readNdjson(logFile)

  assert.equal(result.refreshed, false)
  assert.deepEqual(logEntries[0].argv, ["check", "--format", "json", "--no-refresh-mail"])
})

test("global amen tool shim exports the same tool set as the repo source", async () => {
  const repoModule = await importFreshModule(amenSourcePath, {
    AMEN_BIN: fakeAmenPath,
  })
  const globalModule = await importFreshModule(globalAmenPath, {
    AMEN_BIN: fakeAmenPath,
  })

  assert.deepEqual(Object.keys(globalModule).sort(), Object.keys(repoModule).sort())
})

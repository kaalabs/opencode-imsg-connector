import assert from "node:assert/strict"
import test from "node:test"

import {
  fakeWhatsappPath,
  fileExists,
  importFreshModule,
  listDirectory,
  makeTempHome,
  parseToolResult,
  readJson,
  readNdjson,
  stateDirForHome,
  withEnv,
  writeStateRecord,
  whatsappSourcePath,
} from "./helpers.js"

test("whatsapp_pending returns only new and stale inbound trigger requests", async () => {
  const home = await makeTempHome()
  const now = new Date("2026-03-30T10:00:00Z")
  const staleTime = new Date(now.getTime() - 16 * 60 * 1000)

  await writeStateRecord(home, "GUID-HANDLED", "handled", {
    status: "handled",
    messageGuid: "GUID-HANDLED",
    chatId: "+31612605237",
    handledAt: now.toISOString(),
  }, { channel: "whatsapp" })
  await writeStateRecord(home, "GUID-PENDING", "pending", {
    status: "pending",
    messageGuid: "GUID-PENDING",
    chatId: "+31612605237",
    claimedAt: now.toISOString(),
  }, { channel: "whatsapp" })
  await writeStateRecord(
    home,
    "GUID-STALE",
    "pending",
    {
      status: "pending",
      messageGuid: "GUID-STALE",
      chatId: "+31612605237",
      claimedAt: staleTime.toISOString(),
    },
    { channel: "whatsapp", mtime: staleTime },
  )

  const module = await importFreshModule(whatsappSourcePath, {
    HOME: home,
    WHATSAPP_BIN: fakeWhatsappPath,
    FAKE_WHATSAPP_CHATS_JSON: JSON.stringify([
      { id: "+31612605237", identifier: "+31612605237", service: "whatsapp", last_message_at: now.toISOString() },
    ]),
    FAKE_WHATSAPP_HISTORY_JSON: JSON.stringify([
      { id: 12, guid: "GUID-DRBOZ", chat_id: "+31612605237", from_me: false, text: "@DRBOZ: what should I eat first?", created_at: "2026-03-30T09:45:00Z" },
      { id: 11, guid: "GUID-NEW", chat_id: "+31612605237", from_me: false, text: "@RC: newest", created_at: now.toISOString() },
      { id: 10, guid: "GUID-STALE", chat_id: "+31612605237", from_me: false, text: "@RC: stale pending", created_at: "2026-03-30T09:30:00Z" },
      { id: 9, guid: "GUID-HANDLED", chat_id: "+31612605237", from_me: false, text: "@RC: already handled", created_at: "2026-03-30T09:20:00Z" },
      { id: 8, guid: "GUID-PENDING", chat_id: "+31612605237", from_me: false, text: "@RC: still pending", created_at: "2026-03-30T09:10:00Z" },
      { id: 7, guid: "GUID-NORMAL", chat_id: "+31612605237", from_me: false, text: "hello", created_at: "2026-03-30T09:00:00Z" },
      { id: 6, guid: "GUID-FROM-ME", chat_id: "+31612605237", from_me: true, text: "@RC: sent by me", created_at: "2026-03-30T08:50:00Z" },
      { id: 5, guid: "", chat_id: "+31612605237", from_me: false, text: "@RC: empty guid", created_at: "2026-03-30T08:40:00Z" },
    ]),
  })

  const result = await withEnv(
    {
      HOME: home,
      WHATSAPP_BIN: fakeWhatsappPath,
      FAKE_WHATSAPP_CHATS_JSON: JSON.stringify([
        { id: "+31612605237", identifier: "+31612605237", service: "whatsapp", last_message_at: now.toISOString() },
      ]),
      FAKE_WHATSAPP_HISTORY_JSON: JSON.stringify([
        { id: 12, guid: "GUID-DRBOZ", chat_id: "+31612605237", from_me: false, text: "@DRBOZ: what should I eat first?", created_at: "2026-03-30T09:45:00Z" },
        { id: 11, guid: "GUID-NEW", chat_id: "+31612605237", from_me: false, text: "@RC: newest", created_at: now.toISOString() },
        { id: 10, guid: "GUID-STALE", chat_id: "+31612605237", from_me: false, text: "@RC: stale pending", created_at: "2026-03-30T09:30:00Z" },
        { id: 9, guid: "GUID-HANDLED", chat_id: "+31612605237", from_me: false, text: "@RC: already handled", created_at: "2026-03-30T09:20:00Z" },
        { id: 8, guid: "GUID-PENDING", chat_id: "+31612605237", from_me: false, text: "@RC: still pending", created_at: "2026-03-30T09:10:00Z" },
        { id: 7, guid: "GUID-NORMAL", chat_id: "+31612605237", from_me: false, text: "hello", created_at: "2026-03-30T09:00:00Z" },
        { id: 6, guid: "GUID-FROM-ME", chat_id: "+31612605237", from_me: true, text: "@RC: sent by me", created_at: "2026-03-30T08:50:00Z" },
        { id: 5, guid: "", chat_id: "+31612605237", from_me: false, text: "@RC: empty guid", created_at: "2026-03-30T08:40:00Z" },
      ]),
    },
    async () => parseToolResult(await module.whatsapp_pending.execute({ chatLimit: 20, messageLimit: 50, limit: 20 })),
  )

  assert.equal(result.total, 3)
  assert.deepEqual(
    result.requests.map((entry) => ({
      guid: entry.messageGuid,
      status: entry.status,
      requestKind: entry.requestKind,
      requestPrefix: entry.requestPrefix,
      responsePrefix: entry.responsePrefix,
    })),
    [
      {
        guid: "GUID-NEW",
        status: "new",
        requestKind: "rc",
        requestPrefix: "@RC",
        responsePrefix: "RC:",
      },
      {
        guid: "GUID-DRBOZ",
        status: "new",
        requestKind: "drboz",
        requestPrefix: "@DRBOZ",
        responsePrefix: "DRBOZ:",
      },
      {
        guid: "GUID-STALE",
        status: "stale_pending",
        requestKind: "rc",
        requestPrefix: "@RC",
        responsePrefix: "RC:",
      },
    ],
  )
})

test("whatsapp_reply_once infers drboz mode and persists request metadata", async () => {
  const home = await makeTempHome()
  const module = await importFreshModule(whatsappSourcePath, {
    HOME: home,
    WHATSAPP_BIN: fakeWhatsappPath,
  })

  const result = await withEnv(
    {
      HOME: home,
      WHATSAPP_BIN: fakeWhatsappPath,
    },
    async () =>
      parseToolResult(await module.whatsapp_reply_once.execute({
        confirmed: true,
        chatId: "+31612605237",
        messageGuid: "GUID-DRBOZ-REPLY",
        requestText: "@DRBOZ: what should I do first?",
        replyText: "Protect your eating window and keep carbs low.",
        service: "auto",
      })),
  )

  assert.equal(result.sent, true)
  assert.equal(result.text, "DRBOZ: Protect your eating window and keep carbs low.")
  assert.equal(result.statePath.startsWith(stateDirForHome(home, "whatsapp")), true)

  const record = await readJson(result.statePath)
  assert.equal(record.requestKind, "drboz")
  assert.equal(record.requestPrefix, "@DRBOZ")
  assert.equal(record.responsePrefix, "DRBOZ:")
  assert.equal(record.outgoingText, result.text)
})

test("whatsapp_reply_once sends exactly once for concurrent calls", async () => {
  const home = await makeTempHome()
  const logFile = `${stateDirForHome(home, "whatsapp")}/fake-whatsapp.ndjson`
  const module = await importFreshModule(whatsappSourcePath, {
    HOME: home,
    WHATSAPP_BIN: fakeWhatsappPath,
    FAKE_WHATSAPP_SEND_SLEEP_MS: "150",
    FAKE_WHATSAPP_LOG_FILE: logFile,
  })

  const request = {
    confirmed: true,
    chatId: "+31612605237",
    messageGuid: "GUID-RACE",
    requestText: "@RC: hello!",
    replyText: "Hello!",
    service: "auto",
  }

  const [left, right] = await withEnv(
    {
      HOME: home,
      WHATSAPP_BIN: fakeWhatsappPath,
      FAKE_WHATSAPP_SEND_SLEEP_MS: "150",
      FAKE_WHATSAPP_LOG_FILE: logFile,
    },
    async () =>
      Promise.all([
        module.whatsapp_reply_once.execute(request),
        module.whatsapp_reply_once.execute(request),
      ]),
  )

  const results = [parseToolResult(left), parseToolResult(right)]
  assert.equal(results.filter((result) => result.sent === true).length, 1)
  assert.equal(results.filter((result) => result.skipped === true).length, 1)
  assert.equal(results.find((result) => result.skipped === true)?.reason, "already_pending")

  const sendCalls = (await readNdjson(logFile)).filter((entry) => entry.command === "send")
  assert.equal(sendCalls.length, 1)
})

test("whatsapp_reply_once cleans up pending state after send failure and can retry", async () => {
  const home = await makeTempHome()
  const request = {
    confirmed: true,
    chatId: "+31612605237",
    messageGuid: "GUID-FAIL-ONCE",
    requestText: "@RC: hello!",
    replyText: "Hello!",
    service: "auto",
  }

  const failingModule = await importFreshModule(whatsappSourcePath, {
    HOME: home,
    WHATSAPP_BIN: fakeWhatsappPath,
    FAKE_WHATSAPP_SEND_FAIL: "1",
    FAKE_WHATSAPP_SEND_FAIL_STDERR: "intentional send failure",
  })

  await withEnv(
    {
      HOME: home,
      WHATSAPP_BIN: fakeWhatsappPath,
      FAKE_WHATSAPP_SEND_FAIL: "1",
      FAKE_WHATSAPP_SEND_FAIL_STDERR: "intentional send failure",
    },
    async () => {
      await assert.rejects(
        () => failingModule.whatsapp_reply_once.execute(request),
        /intentional send failure/,
      )
    },
  )

  assert.deepEqual(await listDirectory(stateDirForHome(home, "whatsapp")), [])

  const retryModule = await importFreshModule(whatsappSourcePath, {
    HOME: home,
    WHATSAPP_BIN: fakeWhatsappPath,
  })

  const retryResult = await withEnv(
    {
      HOME: home,
      WHATSAPP_BIN: fakeWhatsappPath,
    },
    async () => parseToolResult(await retryModule.whatsapp_reply_once.execute(request)),
  )

  assert.equal(retryResult.sent, true)
  assert.equal(await fileExists(retryResult.statePath), true)
})

test("whatsapp aliases map to the same implementation objects", async () => {
  const home = await makeTempHome()
  const module = await importFreshModule(whatsappSourcePath, {
    HOME: home,
    WHATSAPP_BIN: fakeWhatsappPath,
  })

  assert.equal(module.whatsapp_oc_reply_once, module.whatsapp_reply_once)
  assert.equal(module.whatsapp_oc_status, module.whatsapp_status)
})

test("whatsapp request kind config overrides prefixes", async () => {
  const home = await makeTempHome()
  const env = {
    HOME: home,
    WHATSAPP_BIN: fakeWhatsappPath,
    WHATSAPP_REQUEST_KINDS: JSON.stringify({
      bot: {
        incomingPrefix: "@BOT",
        outgoingPrefix: "BOT:",
      },
    }),
    FAKE_WHATSAPP_CHATS_JSON: JSON.stringify([
      { id: "+31612605238", identifier: "+31612605238", service: "whatsapp", last_message_at: "2026-03-30T10:00:00Z" },
    ]),
    FAKE_WHATSAPP_HISTORY_JSON: JSON.stringify([
      { id: 10, guid: "GUID-BOT", chat_id: "+31612605238", from_me: false, text: "@BOT: status check", created_at: "2026-03-30T10:01:00Z" },
      { id: 9, guid: "GUID-RC", chat_id: "+31612605238", from_me: false, text: "@RC: regular", created_at: "2026-03-30T10:00:00Z" },
    ]),
  }
  const module = await importFreshModule(whatsappSourcePath, env)

  const pending = await withEnv(env, async () =>
    parseToolResult(await module.whatsapp_pending.execute({ chatLimit: 10, messageLimit: 20, limit: 10 })),
  )

  assert.equal(pending.total, 1)
  assert.equal(pending.requests[0].requestKind, "bot")
  assert.equal(pending.requests[0].requestPrefix, "@BOT")
  assert.equal(pending.requests[0].responsePrefix, "BOT:")

  const reply = await parseToolResult(await module.whatsapp_reply_once.execute({
    confirmed: true,
    chatId: "+31612605238",
    messageGuid: "GUID-BOT",
    requestText: "@BOT: status check",
    replyText: "All good.",
    service: "auto",
  }))

  assert.equal(reply.sent, true)
  assert.equal(reply.text, "BOT: All good.")
  assert.equal(reply.target.type, "chatId")
  assert.equal(reply.target.value, "31612605238")
})

import assert from "node:assert/strict"
import test from "node:test"

import {
  fakeImsgPath,
  fileExists,
  globalImessagePath,
  imessageSourcePath,
  importFreshModule,
  listDirectory,
  makeTempHome,
  parseToolResult,
  readJson,
  readNdjson,
  stateDirForHome,
  withEnv,
  writeStateRecord,
} from "./helpers.js"

test("rc_pending returns only new and stale inbound trigger requests", async () => {
  const home = await makeTempHome()
  const now = new Date("2026-03-30T10:00:00Z")
  const staleTime = new Date(now.getTime() - 16 * 60 * 1000)

  await writeStateRecord(home, "GUID-HANDLED", "handled", {
    status: "handled",
    messageGuid: "GUID-HANDLED",
    chatId: 98,
    handledAt: now.toISOString(),
  })
  await writeStateRecord(home, "GUID-PENDING", "pending", {
    status: "pending",
    messageGuid: "GUID-PENDING",
    chatId: 98,
    claimedAt: now.toISOString(),
  })
  await writeStateRecord(
    home,
    "GUID-STALE",
    "pending",
    {
      status: "pending",
      messageGuid: "GUID-STALE",
      chatId: 98,
      claimedAt: staleTime.toISOString(),
    },
    { mtime: staleTime },
  )

  const env = {
    HOME: home,
    IMSG_BIN: fakeImsgPath,
    FAKE_IMSG_CHATS_JSON: JSON.stringify([
      { id: 98, identifier: "+31612605237", service: "iMessage", last_message_at: now.toISOString() },
    ]),
    FAKE_IMSG_HISTORY_JSON: JSON.stringify([
      { id: 12, guid: "GUID-DRBOZ", chat_id: 98, is_from_me: false, text: "@DRBOZ: what should I eat first?", created_at: "2026-03-30T09:45:00Z" },
      { id: 11, guid: "GUID-NEW", chat_id: 98, is_from_me: false, text: "@RC: newest", created_at: now.toISOString() },
      { id: 10, guid: "GUID-STALE", chat_id: 98, is_from_me: false, text: "@RC: stale pending", created_at: "2026-03-30T09:30:00Z" },
      { id: 9, guid: "GUID-HANDLED", chat_id: 98, is_from_me: false, text: "@RC: already handled", created_at: "2026-03-30T09:20:00Z" },
      { id: 8, guid: "GUID-PENDING", chat_id: 98, is_from_me: false, text: "@RC: still pending", created_at: "2026-03-30T09:10:00Z" },
      { id: 7, guid: "GUID-NORMAL", chat_id: 98, is_from_me: false, text: "hello", created_at: "2026-03-30T09:00:00Z" },
      { id: 6, guid: "GUID-FROM-ME", chat_id: 98, is_from_me: true, text: "@RC: sent by me", created_at: "2026-03-30T08:50:00Z" },
      { id: 5, guid: "", chat_id: 98, is_from_me: false, text: "@RC: empty guid", created_at: "2026-03-30T08:40:00Z" },
      { id: 4, guid: "GUID-BAD-CHAT", chat_id: 0, is_from_me: false, text: "@RC: bad chat", created_at: "2026-03-30T08:30:00Z" },
    ]),
  }
  const module = await importFreshModule(imessageSourcePath, env)

  const result = await withEnv(env, async () => parseToolResult(await module.rc_pending.execute({ chatLimit: 20, messageLimit: 50, limit: 20 })))

  assert.equal(result.total, 3)
  assert.deepEqual(
    result.requests.map((request) => ({
      guid: request.messageGuid,
      status: request.status,
      requestKind: request.requestKind,
      requestPrefix: request.requestPrefix,
      responsePrefix: request.responsePrefix,
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

test("oc_reply_once infers drboz mode from requestText and persists request metadata", async () => {
  const home = await makeTempHome()
  const env = {
    HOME: home,
    IMSG_BIN: fakeImsgPath,
  }
  const module = await importFreshModule(imessageSourcePath, env)

  const result = await withEnv(
    env,
    async () => parseToolResult(await module.oc_reply_once.execute({
      confirmed: true,
      chatId: 98,
      messageGuid: "GUID-DRBOZ-REPLY",
      replyText: "Start by protecting your eating window and keeping carbs low.",
      requestText: "@DRBOZ: what should I do first?",
      service: "auto",
      region: "NL",
    })),
  )

  assert.equal(result.sent, true)
  assert.equal(result.text, "DRBOZ: Start by protecting your eating window and keeping carbs low.")

  const record = await readJson(result.statePath)
  assert.equal(record.requestKind, "drboz")
  assert.equal(record.requestPrefix, "@DRBOZ")
  assert.equal(record.responsePrefix, "DRBOZ:")
  assert.equal(record.outgoingText, result.text)
})

test("oc_reply_once sends exactly once for concurrent calls", async () => {
  const home = await makeTempHome()
  const logFile = `${stateDirForHome(home)}/fake-imsg.ndjson`
  const env = {
    HOME: home,
    IMSG_BIN: fakeImsgPath,
    FAKE_IMSG_SEND_SLEEP_MS: "150",
    FAKE_IMSG_LOG_FILE: logFile,
  }
  const module = await importFreshModule(imessageSourcePath, env)

  const request = {
    confirmed: true,
    chatId: 98,
    messageGuid: "GUID-RACE",
    replyText: "Hello!",
    requestText: "@RC: hello!",
    service: "auto",
    region: "NL",
  }

  const [left, right] = await withEnv(env, async () =>
    Promise.all([
      module.oc_reply_once.execute(request),
      module.oc_reply_once.execute(request),
    ]),
  )
  const results = [parseToolResult(left), parseToolResult(right)]

  assert.equal(results.filter((result) => result.sent === true).length, 1)
  assert.equal(results.filter((result) => result.skipped === true).length, 1)
  assert.equal(results.find((result) => result.skipped === true)?.reason, "already_pending")

  const sendCalls = (await readNdjson(logFile)).filter((entry) => entry.command === "send")
  assert.equal(sendCalls.length, 1)
})

test("oc_reply_once cleans up pending state after send failure and can retry", async () => {
  const home = await makeTempHome()
  const stateDir = stateDirForHome(home)

  const failingEnv = {
    HOME: home,
    IMSG_BIN: fakeImsgPath,
    FAKE_IMSG_SEND_FAIL: "1",
    FAKE_IMSG_SEND_FAIL_STDERR: "intentional send failure",
  }
  const failingModule = await importFreshModule(imessageSourcePath, failingEnv)

  const request = {
    confirmed: true,
    chatId: 98,
    messageGuid: "GUID-FAIL-ONCE",
    replyText: "Hello!",
    requestText: "@RC: hello!",
    service: "auto",
    region: "NL",
  }

  await assert.rejects(() => withEnv(failingEnv, async () => failingModule.oc_reply_once.execute(request)), /intentional send failure/)
  assert.deepEqual(await listDirectory(stateDir), [])

  const retryEnv = {
    HOME: home,
    IMSG_BIN: fakeImsgPath,
  }
  const retryModule = await importFreshModule(imessageSourcePath, retryEnv)
  const retryResult = await withEnv(retryEnv, async () => parseToolResult(await retryModule.oc_reply_once.execute(request)))

  assert.equal(retryResult.sent, true)
  assert.equal(await fileExists(retryResult.statePath), true)
})

test("oc_reply_once reclaims stale pending messages", async () => {
  const home = await makeTempHome()
  const staleTime = new Date(Date.now() - 16 * 60 * 1000)

  await writeStateRecord(
    home,
    "GUID-STALE-RECOVER",
    "pending",
    {
      status: "pending",
      messageGuid: "GUID-STALE-RECOVER",
      chatId: 98,
      claimedAt: staleTime.toISOString(),
      replyText: "Old reply",
    },
    { mtime: staleTime },
  )

  const env = {
    HOME: home,
    IMSG_BIN: fakeImsgPath,
  }
  const module = await importFreshModule(imessageSourcePath, env)

  const result = await withEnv(
    env,
    async () => parseToolResult(await module.oc_reply_once.execute({
      confirmed: true,
      chatId: 98,
      messageGuid: "GUID-STALE-RECOVER",
      replyText: "Fresh reply",
      requestText: "@RC: retry",
      service: "auto",
      region: "NL",
    })),
  )

  assert.equal(result.sent, true)
  const record = await readJson(result.statePath)
  assert.equal(record.outgoingText, "RC: Fresh reply")
  assert.equal(record.status, "handled")
})

test("global tool shim exports the same tool set as the repo source", async () => {
  const home = await makeTempHome()
  const repoModule = await importFreshModule(imessageSourcePath, {
    HOME: home,
    IMSG_BIN: fakeImsgPath,
  })
  const globalModule = await importFreshModule(globalImessagePath, {
    HOME: home,
    IMSG_BIN: fakeImsgPath,
  })

  assert.deepEqual(Object.keys(globalModule).sort(), Object.keys(repoModule).sort())
})

test("owpenbot alias exports reuse primary tool implementations", async () => {
  const home = await makeTempHome()
  const module = await importFreshModule(imessageSourcePath, {
    HOME: home,
    IMSG_BIN: fakeImsgPath,
  })

  assert.equal(module.owpenbot_chats, module.chats)
  assert.equal(module.owpenbot_history, module.history)
  assert.equal(module.owpenbot_send, module.send)
  assert.equal(module.owpenbot_pending, module.rc_pending)
  assert.equal(module.owpenbot_reply_once, module.oc_reply_once)
  assert.equal(module.owpenbot_oc_reply_once, module.oc_reply_once)
  assert.equal(module.owpenbot_status, module.oc_status)
  assert.equal(module.owpenbot_oc_status, module.oc_status)
})

test("owpenbot request kind config overrides incoming/outgoing trigger prefixes", async () => {
  const home = await makeTempHome()
  const env = {
    HOME: home,
    IMSG_BIN: fakeImsgPath,
    OWPENBOT_REQUEST_KINDS: JSON.stringify({
      bot: {
        incomingPrefix: "@BOT",
        outgoingPrefix: "BOT:",
      },
    }),
    FAKE_IMSG_CHATS_JSON: JSON.stringify([
      { id: 99, identifier: "+31612605238", service: "iMessage", last_message_at: "2026-03-30T10:00:00Z" },
    ]),
    FAKE_IMSG_HISTORY_JSON: JSON.stringify([
      { id: 10, guid: "GUID-BOT", chat_id: 99, is_from_me: false, text: "@BOT: status check", created_at: "2026-03-30T10:01:00Z" },
      { id: 9, guid: "GUID-RC", chat_id: 99, is_from_me: false, text: "@RC: regular", created_at: "2026-03-30T10:00:00Z" },
    ]),
  }
  const module = await importFreshModule(imessageSourcePath, env)

  const pending = await withEnv(env, async () =>
    parseToolResult(
      await module.owpenbot_pending.execute({
        chatLimit: 10,
        messageLimit: 20,
        limit: 10,
      }),
    ),
  )

  assert.equal(pending.total, 1)
  assert.equal(pending.requests[0].requestKind, "bot")
  assert.equal(pending.requests[0].requestPrefix, "@BOT")
  assert.equal(pending.requests[0].responsePrefix, "BOT:")

  const reply = await withEnv(env, async () =>
    parseToolResult(
      await module.owpenbot_reply_once.execute({
        confirmed: true,
        chatId: 99,
        messageGuid: "GUID-BOT",
        requestText: "@BOT: status check",
        replyText: "All good.",
        service: "auto",
      }),
    ),
  )

  assert.equal(reply.sent, true)
  assert.equal(reply.text, "BOT: All good.")
  assert.equal(reply.target.type, "chatId")
  assert.equal(reply.target.value, "99")
})

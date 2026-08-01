// Are tool calls written to the DATABASE BEFORE the UI sees them.
//
// This test guards against three specific faults:
//   1) the call going out over WS but never reaching the database — if the
//      stream was cut, the command that ran vanished without a trace;
//   2) the permission decision (who granted it) not being stored;
//   3) the cards of an interrupted reply not showing up in the history — they
//      used to live only in `chat_messages.tool_cards`, written at the END of
//      the stream.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerEvent } from '@barpo/shared'

let fakeEvents: unknown[] = []

const realAi = await import('@barpo/ai')

mock.module('@barpo/ai', () => ({
  ...realAi,
  conversationStream: async function* () {
    for (const e of fakeEvents) yield e
  },
  agentStream: async function* () {
    for (const e of fakeEvents) yield e
  },
}))

const { openDb, setDb } = await import('../src/db.ts')
const { streamReply } = await import('../src/orchestrator.ts')
const { createSession, readToolCalls, readMessages } = await import('../src/repo.ts')
const { hub } = await import('../src/ws/hub.ts')

let db: Database
let received: ServerEvent[]
let worksDir: string

const choice = { provider: 'ollama', model: 'qwen3:0.6b' }

beforeEach(() => {
  worksDir = mkdtempSync(join(tmpdir(), 'tool-call-'))
  process.env.PLATFORM_WORKS = worksDir
  db = openDb(':memory:')
  setDb(db)
  received = []
  hub.connected({
    data: { id: 'fake', channels: new Set(['chat', 'audit']) },
    send: (m: string) => received.push(JSON.parse(m) as ServerEvent),
  } as never)
  received.length = 0
  fakeEvents = []
})

afterEach(() => {
  delete process.env.PLATFORM_WORKS
  rmSync(worksDir, { recursive: true, force: true })
  setDb(null)
  hub.clear()
  db.close()
})

describe('tool calls are written to the database', () => {
  test('every stage is recorded — the start as well as the finish', async () => {
    fakeEvents = [
      { kind: 'tool_start', id: 't1', name: 'bash', args: 'ls -la' },
      { kind: 'tool_end', id: 't1', result: 'files', isError: false },
      { kind: 'done', text: 'ready', usage: { input: 1, output: 1, cost: 0 } },
    ]

    const s = createSession('test', db)
    await streamReply(s.id, 'm-1', choice)

    const calls = readToolCalls('m-1', db)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      id: 't1',
      name: 'bash',
      args: 'ls -la',
      status: 'done',
      result: 'files',
    })
  })

  test('a command that ran stays in the database EVEN IF THE STREAM IS CUT', async () => {
    // The error arrives AFTER the tool finished: cards used to be written only
    // together with the message, and the message might never be written at all
    fakeEvents = [
      { kind: 'tool_start', id: 't1', name: 'bash', args: 'ssh server-107 uptime' },
      { kind: 'tool_end', id: 't1', result: 'up 3 days', isError: false },
      { kind: 'error', message: 'the provider dropped the connection' },
    ]

    const s = createSession('test', db)
    await streamReply(s.id, 'm-cut', choice)

    const calls = readToolCalls('m-cut', db)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toBe('ssh server-107 uptime')
    expect(calls[0]?.result).toBe('up 3 days')
  })

  test('the permission decision is stored attached to the call', async () => {
    fakeEvents = [
      { kind: 'tool_start', id: 't1', name: 'bash', args: 'sudo systemctl restart nginx' },
      {
        kind: 'permission_required',
        request: {
          id: 'r1',
          sessionId: 's',
          kind: 'command',
          action: 'bash',
          target: 'sudo systemctl restart nginx',
          reason: 'sudo',
          pattern: 'sudo',
          time: new Date().toISOString(),
        },
      },
      {
        kind: 'permission_decision',
        decision: {
          requestId: 'r1',
          origin: 'user-always',
          granted: true,
          pattern: 'sudo',
          time: new Date().toISOString(),
        },
      },
      { kind: 'tool_end', id: 't1', result: 'ok', isError: false },
      { kind: 'done', text: 'restarted', usage: { input: 1, output: 1, cost: 0 } },
    ]

    const s = createSession('test', db)
    await streamReply(s.id, 'm-permission', choice)

    const call = readToolCalls('m-permission', db)[0]
    expect(call?.permission).toMatchObject({
      requestId: 'r1',
      origin: 'user-always',
      granted: true,
      pattern: 'sudo',
    })
    // The completion event knows nothing about the permission — it must not
    // overwrite it
    expect(call?.status).toBe('done')
    expect(call?.result).toBe('ok')
  })

  test('an auto-mode decision is stored too', async () => {
    fakeEvents = [
      { kind: 'tool_start', id: 't1', name: 'bash', args: 'curl -s example.com' },
      {
        kind: 'permission_decision',
        decision: { origin: 'auto', granted: true, pattern: 'curl', time: new Date().toISOString() },
      },
      { kind: 'classifier', verdict: 'allow', note: 'does not stray beyond what the user asked for' },
      { kind: 'tool_end', id: 't1', result: '<html>', isError: false },
      { kind: 'done', text: 'fetched', usage: { input: 1, output: 1, cost: 0 } },
    ]

    const s = createSession('test', db)
    await streamReply(s.id, 'm-auto', choice)

    const call = readToolCalls('m-auto', db)[0]
    expect(call?.permission?.origin).toBe('auto')
    expect(call?.classifier?.verdict).toBe('allow')
  })

  test('a denied command is stored with its reason', async () => {
    fakeEvents = [
      { kind: 'tool_start', id: 't1', name: 'bash', args: 'rm -rf /' },
      {
        kind: 'permission_decision',
        decision: {
          origin: 'forbidden',
          granted: false,
          pattern: 'rm',
          time: new Date().toISOString(),
        },
      },
      { kind: 'tool_end', id: 't1', result: 'Permission denied: forbidden', isError: true },
      { kind: 'done', text: 'I did not run it', usage: { input: 1, output: 1, cost: 0 } },
    ]

    const s = createSession('test', db)
    await streamReply(s.id, 'm-forbidden', choice)

    const call = readToolCalls('m-forbidden', db)[0]
    expect(call?.permission).toMatchObject({ origin: 'forbidden', granted: false })
    expect(call?.status).toBe('denied')
  })

  test('the database write happens BEFORE the WS event', async () => {
    // We check the order indirectly: by the time the `chat.tool` event arrives
    // the record must already be sitting in the database.
    const s = createSession('test', db)
    let alreadyInDb = false

    hub.connected({
      data: { id: 'checker', channels: new Set(['chat']) },
      send: (m: string) => {
        const e = JSON.parse(m) as ServerEvent
        if (e.type === 'chat.tool' && !alreadyInDb) {
          alreadyInDb = readToolCalls('m-order', db).length > 0
        }
      },
    } as never)

    fakeEvents = [
      { kind: 'tool_start', id: 't1', name: 'read', args: 'a.txt' },
      { kind: 'done', text: 'ok', usage: { input: 1, output: 1, cost: 0 } },
    ]
    await streamReply(s.id, 'm-order', choice)

    expect(alreadyInDb).toBe(true)
  })

  test('the decision for a foreign request is written to NO card at all', async () => {
    // Two streams can briefly live side by side in one session (the user
    // stopped one and immediately sent a new message). If a decision arrives
    // for the old stream's request it must not stick to the NEW stream's card —
    // otherwise the "who granted this" trail would be a lie.
    fakeEvents = [
      { kind: 'tool_start', id: 't1', name: 'read', args: 'config.ts' },
      {
        kind: 'permission_decision',
        decision: {
          requestId: 'belongs-to-another-stream',
          origin: 'timeout',
          granted: false,
          pattern: 'rm',
          time: new Date().toISOString(),
        },
      },
      { kind: 'tool_end', id: 't1', result: 'contents', isError: false },
      { kind: 'done', text: 'ok', usage: { input: 1, output: 1, cost: 0 } },
    ]

    const s = createSession('test', db)
    await streamReply(s.id, 'm-foreign', choice)

    const call = readToolCalls('m-foreign', db)[0]
    expect(call?.name).toBe('read')
    expect(call?.permission).toBeUndefined()
  })

  test('the decision goes to the call that ASKED, not to the next one', async () => {
    // The permission answer is slow: by the time it arrives the agent may
    // already be running a different tool. The decision still belongs to the
    // card that asked for it.
    fakeEvents = [
      { kind: 'tool_start', id: 't1', name: 'bash', args: 'ssh server-107 uptime' },
      {
        kind: 'permission_required',
        request: {
          id: 'r1',
          sessionId: 's',
          kind: 'command',
          action: 'bash',
          target: 'ssh server-107 uptime',
          reason: 'ssh',
          pattern: 'ssh',
          time: new Date().toISOString(),
        },
      },
      { kind: 'tool_end', id: 't1', result: 'up 3 days', isError: false },
      // Now a different tool is running...
      { kind: 'tool_start', id: 't2', name: 'read', args: 'a.txt' },
      // ...and only now does the first one's decision arrive
      {
        kind: 'permission_decision',
        decision: {
          requestId: 'r1',
          origin: 'user',
          granted: true,
          pattern: 'ssh',
          time: new Date().toISOString(),
        },
      },
      { kind: 'tool_end', id: 't2', result: 'text', isError: false },
      { kind: 'done', text: 'ok', usage: { input: 1, output: 1, cost: 0 } },
    ]

    const s = createSession('test', db)
    await streamReply(s.id, 'm-late', choice)

    const calls = readToolCalls('m-late', db)
    const ssh = calls.find((c) => c.id === 't1')
    const read = calls.find((c) => c.id === 't2')
    expect(ssh?.permission?.origin).toBe('user')
    expect(read?.permission).toBeUndefined()
  })

  test('calls whose message was never written DO NOT VANISH from the history', async () => {
    // When the process stops mid-stream the assistant message is not written,
    // while the tool records stay in the database. They must not disappear as
    // orphans — preventing exactly this loss is why the table exists.
    const s = createSession('test', db)
    const { writeToolCall } = await import('../src/repo.ts')
    writeToolCall(
      {
        id: 'orphan-1',
        sessionId: s.id,
        messageId: 'message-never-written',
        name: 'bash',
        args: 'ssh server-107 systemctl restart nginx',
        status: 'done',
        result: 'ok',
        permission: {
          origin: 'user',
          granted: true,
          pattern: 'ssh',
          time: new Date().toISOString(),
        },
      },
      db,
    )

    const messages = readMessages(s.id, db)
    const restored = messages.find((m) => m.id === 'message-never-written')
    expect(restored).toBeDefined()
    expect(restored?.role).toBe('assistant')
    expect(restored?.text).toContain('interrupted')
    expect(restored?.toolCards?.[0]?.args).toBe('ssh server-107 systemctl restart nginx')
    expect(restored?.toolCards?.[0]?.permission?.origin).toBe('user')
    // A half-built context must not break the next turn
    expect(restored?.agentMessages).toBeUndefined()
  })

  test('the history takes cards from the tool table (an interrupted reply shows up too)', async () => {
    fakeEvents = [
      { kind: 'tool_start', id: 't1', name: 'bash', args: 'ssh server-107 df -h' },
      {
        kind: 'permission_decision',
        decision: { origin: 'user', granted: true, pattern: 'ssh', time: new Date().toISOString() },
      },
      { kind: 'tool_end', id: 't1', result: '/dev/sda1 40%', isError: false },
      { kind: 'error', message: 'the provider dropped the connection' },
    ]

    const s = createSession('test', db)
    await streamReply(s.id, 'm-history', choice)

    const messages = readMessages(s.id, db)
    const reply = messages.find((m) => m.role === 'assistant')
    expect(reply?.toolCards).toHaveLength(1)
    // The permission decision only exists in the tool table — it does not come
    // from the old `tool_cards` column, so this field proves the right source
    // was picked
    expect(reply?.toolCards?.[0]?.permission?.origin).toBe('user')
  })
})

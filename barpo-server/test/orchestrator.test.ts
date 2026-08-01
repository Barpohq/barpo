// Orchestrator: LLM stream → WS events → DB.
//
// The real LLM is never called — the @barpo/ai module is replaced with a
// fake stream (mock.module has to run BEFORE the imports, which is why it sits
// at the top of the file).
//
// By default `streamReply` uses `agentStream` (with tools); with
// `{ tools: false }` it uses `conversationStream`. Both are mocked.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerEvent } from '@barpo/shared'

/** The fake events returned by the next call */
let fakeEvents: unknown[] = []
/** The arguments the stream function was last called with */
let lastCall: { choice: unknown; messages: unknown; options?: unknown } | null = null

// CAREFUL: mock.module replaces the WHOLE module, so we keep the real exports
// and only overwrite the ones we need. Otherwise exports such as
// `detectModels` would disappear, and because this mock is global other test
// files (barpo-ai/test/permission.test.ts, for example) would receive
// incomplete objects and fall over.
const realAi = await import('@barpo/ai')

/**
 * The permission manager — taken from the REAL registry, with a listener added
 * on top that denies every request immediately.
 *
 * Why it is not mocked: this mock.module is global, so it would leak into
 * barpo-ai/test/permission.test.ts too. If we wrote our own registry it
 * would fall out of sync with the `closePermissionManager` / `clearPermissions`
 * used over there. The real registry works correctly in both files.
 */
// The reference is captured BEFORE the mock — calling through
// `realAi.permissionManager` would hit the refreshed namespace once the mock is
// applied, and the function would call itself for ever.
const realPermissionManager = realAi.permissionManager
const listenerAdded = new WeakSet<object>()

function denyingPermissions(sessionId: string) {
  const manager = realPermissionManager(sessionId)
  if (!listenerAdded.has(manager)) {
    listenerAdded.add(manager)
    manager.subscribe((request) => manager.answer(request.id, 'deny'))
  }
  return manager
}

mock.module('@barpo/ai', () => ({
  ...realAi,
  conversationStream: async function* (choice: unknown, messages: unknown, options: unknown) {
    lastCall = { choice, messages, options }
    for (const e of fakeEvents) yield e
  },
  agentStream: async function* (choice: unknown, messages: unknown, options: unknown) {
    lastCall = { choice, messages, options }
    for (const e of fakeEvents) yield e
  },
  permissionManager: denyingPermissions,
}))

const { app } = await import('../src/app.ts')
const { openDb, setDb } = await import('../src/db.ts')
const { runningSessions, streamReply, isStreaming, stopStream, clearRunningStreams } = await import(
  '../src/orchestrator.ts'
)
const { createSession, readMessages, writeMessage } = await import('../src/repo.ts')
const { hub } = await import('../src/ws/hub.ts')

let db: Database
let received: ServerEvent[]
let worksDir: string

/** A fake WS connection subscribed to the chat channel */
function fakeWs() {
  const collected: ServerEvent[] = []
  const ws = {
    data: { id: 'fake', channels: new Set(['chat', 'audit']) },
    send: (m: string) => collected.push(JSON.parse(m) as ServerEvent),
  }
  return { ws: ws as never, collected }
}

beforeEach(() => {
  // The stream registry is module level, so it is shared with every other test
  // file. `POST /api/chat/send` starts its stream WITHOUT awaiting it, so
  // another file may have left an entry behind — and the `runningSessions()`
  // tests below would then count somebody else's session.
  clearRunningStreams()

  // The work directories go into a temporary place, not the home directory
  worksDir = mkdtempSync(join(tmpdir(), 'orch-works-'))
  process.env.PLATFORM_WORKS = worksDir

  db = openDb(':memory:')
  setDb(db)
  const fake = fakeWs()
  received = fake.collected
  hub.connected(fake.ws)
  received.length = 0 // drop the `hello` event
  fakeEvents = []
  lastCall = null
})

afterEach(() => {
  delete process.env.PLATFORM_WORKS
  rmSync(worksDir, { recursive: true, force: true })
  setDb(null)
  hub.clear()
  db.close()
})

const choice = { provider: 'ollama', model: 'qwen3:0.6b' }

/**
 * The events of the reply STREAM — delta/tool/done/error.
 *
 * `chat.status` is deliberately filtered out: it is not reply content but a
 * meta-event about the state of the stream (for the sidebar indicators), and it
 * wraps the whole stream. The tests below check the reply sequence, so for them
 * it is noise. `chat.status` has tests of its own.
 */
function chatEvents(): ServerEvent[] {
  return received.filter((e) => e.type.startsWith('chat.') && e.type !== 'chat.status')
}

describe('streamReply — a successful stream', () => {
  test('delta events arrive in order and are followed by done', async () => {
    fakeEvents = [
      { kind: 'delta', text: 'He' },
      { kind: 'delta', text: 'llo' },
      { kind: 'done', text: 'Hello', usage: { input: 10, output: 5, cost: 0 } },
    ]

    const s = createSession('test', db)
    await streamReply(s.id, 'message-1', choice)

    const events = chatEvents()
    expect(events.map((e) => e.type)).toEqual(['chat.delta', 'chat.delta', 'chat.done'])

    const deltas = events.filter((e) => e.type === 'chat.delta')
    expect(deltas.map((e) => (e as { delta: string }).delta).join('')).toBe('Hello')

    const done = events.at(-1) as { usage?: { input: number; output: number } }
    expect(done.usage?.input).toBe(10)
    expect(done.usage?.output).toBe(5)
  })

  test('the reply is written to the database once, in full', async () => {
    fakeEvents = [
      { kind: 'delta', text: 'One' },
      { kind: 'delta', text: ' two' },
      { kind: 'done', text: 'One two', usage: { input: 1, output: 2, cost: 0 } },
    ]

    const s = createSession('test', db)
    await streamReply(s.id, 'message-2', choice)

    const messages = readMessages(s.id, db)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.id).toBe('message-2')
    expect(messages[0]?.role).toBe('assistant')
    expect(messages[0]?.text).toBe('One two')
  })

  test('the session history is handed to the LLM', async () => {
    fakeEvents = [{ kind: 'done', text: 'ok', usage: { input: 0, output: 0, cost: 0 } }]

    const s = createSession('test', db)
    writeMessage({ sessionId: s.id, role: 'user', text: 'first question' }, db)
    writeMessage({ sessionId: s.id, role: 'assistant', text: 'first answer' }, db)
    writeMessage({ sessionId: s.id, role: 'user', text: 'second question' }, db)

    await streamReply(s.id, 'message-3', choice)

    expect(lastCall?.choice).toEqual(choice)
    expect(lastCall?.messages).toEqual([
      { role: 'user', text: 'first question' },
      { role: 'assistant', text: 'first answer' },
      { role: 'user', text: 'second question' },
    ])
  })

  test('messages with empty text are left out of the history', async () => {
    fakeEvents = [{ kind: 'done', text: 'ok', usage: { input: 0, output: 0, cost: 0 } }]

    const s = createSession('test', db)
    writeMessage({ sessionId: s.id, role: 'user', text: 'question' }, db)
    writeMessage({ sessionId: s.id, role: 'assistant', text: '   ' }, db)

    await streamReply(s.id, 'message-4', choice)
    expect(lastCall?.messages).toEqual([{ role: 'user', text: 'question' }])
  })
})

describe('streamReply — error cases', () => {
  test('on error chat.error arrives and chat.done does not', async () => {
    fakeEvents = [{ kind: 'error', message: 'Invalid key' }]

    const s = createSession('test', db)
    await streamReply(s.id, 'message-5', choice)

    const types = chatEvents().map((e) => e.type)
    expect(types).toContain('chat.error')
    expect(types).not.toContain('chat.done')

    const errorEvent = chatEvents().find((e) => e.type === 'chat.error') as { error: string }
    expect(errorEvent.error).toBe('Invalid key')
  })

  test('a half-arrived reply is stored with an error marker', async () => {
    fakeEvents = [
      { kind: 'delta', text: 'Half ' },
      { kind: 'error', message: 'connection lost' },
    ]

    const s = createSession('test', db)
    await streamReply(s.id, 'message-6', choice)

    const messages = readMessages(s.id, db)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.text).toContain('Half')
    expect(messages[0]?.text).toContain('connection lost')
  })

  test('an error with nothing received at all — the reason is still stored', async () => {
    fakeEvents = [{ kind: 'error', message: 'Model not found' }]

    const s = createSession('test', db)
    await streamReply(s.id, 'message-7', choice)

    const messages = readMessages(s.id, db)
    expect(messages[0]?.text).toContain('Model not found')
  })

  test('the error comes back on the result object', async () => {
    fakeEvents = [{ kind: 'error', message: 'something' }]
    const s = createSession('test', db)
    const result = await streamReply(s.id, 'message-8', choice)
    expect(result.error).toBe('something')
    expect(result.messageId).toBe('message-8')
  })
})

// The user pressing "Stop" IS NOT AN ERROR. An abort used to travel the error
// path too, which appended "⚠︎ The response did not arrive in full: ..." to the
// reply text and made the UI draw a red warning — one event showing up as a
// second warning on top of a tool card that already said "stopped".
describe('streamReply — the user stopped it', () => {
  /** Fake events that call `stopStream` in the middle of the stream */
  function stoppingStream(sessionId: string) {
    return [
      { kind: 'delta', text: 'Half a reply' },
      {
        get kind() {
          // The getter runs when the stream reaches this event — that is,
          // inside `streamReply`, after the registry entry has been added.
          stopStream(sessionId)
          return 'error'
        },
        message: 'Request cancelled',
      },
    ]
  }

  test('no error marker is added to the text when it was stopped', async () => {
    const s = createSession('test', db)
    fakeEvents = stoppingStream(s.id)

    await streamReply(s.id, 'stop-1', choice)

    const messages = readMessages(s.id, db)
    expect(messages[0]?.text).toBe('Half a reply')
    expect(messages[0]?.text).not.toContain('did not arrive in full')
  })

  test('stopping produces chat.done, not chat.error', async () => {
    const s = createSession('test', db)
    fakeEvents = stoppingStream(s.id)

    await streamReply(s.id, 'stop-2', choice)

    const types = chatEvents().map((e) => e.type)
    expect(types).not.toContain('chat.error')
    expect(types).toContain('chat.done')
  })

  test("the final status after stopping is 'done'", async () => {
    const s = createSession('test', db)
    fakeEvents = stoppingStream(s.id)

    await streamReply(s.id, 'stop-3', choice)

    const statuses = received
      .filter((e) => e.type === 'chat.status')
      .map((e) => (e as { status: string }).status)
    expect(statuses.at(-1)).toBe('done')
    expect(statuses).not.toContain('error')
  })

  test('a genuine error (with no abort) still gets the error marker', async () => {
    // A control test: the fix above must not swallow ordinary errors
    fakeEvents = [
      { kind: 'delta', text: 'Half' },
      { kind: 'error', message: 'connection lost' },
    ]
    const s = createSession('test', db)

    await streamReply(s.id, 'stop-4', choice)

    expect(readMessages(s.id, db)[0]?.text).toContain('did not arrive in full')
    expect(chatEvents().map((e) => e.type)).toContain('chat.error')
  })
})

describe('stream state', () => {
  test('the stream leaves the registry once it has finished', async () => {
    fakeEvents = [{ kind: 'done', text: 'ok', usage: { input: 0, output: 0, cost: 0 } }]
    const s = createSession('test', db)

    expect(isStreaming(s.id)).toBe(false)
    await streamReply(s.id, 'message-9', choice)
    expect(isStreaming(s.id)).toBe(false)
  })
})

describe('the tool stream', () => {
  test('a tool starting and finishing both become chat.tool', async () => {
    fakeEvents = [
      { kind: 'tool_start', id: 't1', name: 'read', args: 'a.txt' },
      { kind: 'tool_end', id: 't1', result: 'hello', isError: false },
      { kind: 'delta', text: 'In the file: hello' },
      { kind: 'done', text: 'In the file: hello', usage: { input: 5, output: 3, cost: 0 } },
    ]

    const s = createSession('test', db)
    await streamReply(s.id, 'm-tool', choice)

    const toolEvents = received.filter((e) => e.type === 'chat.tool') as {
      tool: { id: string; name: string; status: string; result?: string }
    }[]
    expect(toolEvents).toHaveLength(2)
    expect(toolEvents[0]?.tool.status).toBe('running')
    expect(toolEvents[0]?.tool.name).toBe('read')
    expect(toolEvents[1]?.tool.status).toBe('done')
    expect(toolEvents[1]?.tool.result).toBe('hello')
    // The arguments are kept on the second event as well
    expect(toolEvents[1]?.tool.name).toBe('read')
  })

  test('tool cards are stored alongside the message', async () => {
    fakeEvents = [
      { kind: 'tool_start', id: 't1', name: 'write', args: 'b.txt' },
      { kind: 'tool_end', id: 't1', result: 'written', isError: false },
      { kind: 'done', text: 'Ready', usage: { input: 1, output: 1, cost: 0 } },
    ]

    const s = createSession('test', db)
    await streamReply(s.id, 'm-store', choice)

    const messages = readMessages(s.id, db)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.toolCards).toHaveLength(1)
    expect(messages[0]?.toolCards?.[0]?.name).toBe('write')
    expect(messages[0]?.toolCards?.[0]?.status).toBe('done')
  })

  test('a refused permission is marked as its own status', async () => {
    fakeEvents = [
      { kind: 'tool_start', id: 't1', name: 'bash', args: 'rm -rf x' },
      { kind: 'tool_end', id: 't1', result: 'Permission denied: `rm`', isError: true },
      { kind: 'done', text: '', usage: { input: 0, output: 0, cost: 0 } },
    ]

    const s = createSession('test', db)
    await streamReply(s.id, 'm-denied', choice)

    const last = (
      received.filter((e) => e.type === 'chat.tool').at(-1) as { tool: { status: string } }
    ).tool
    expect(last.status).toBe('denied')
  })

  test("an ordinary tool failure gets the 'error' status", async () => {
    fakeEvents = [
      { kind: 'tool_start', id: 't1', name: 'read', args: 'missing.txt' },
      { kind: 'tool_end', id: 't1', result: 'ENOENT: file not found', isError: true },
      { kind: 'done', text: '', usage: { input: 0, output: 0, cost: 0 } },
    ]

    const s = createSession('test', db)
    await streamReply(s.id, 'm-error', choice)

    const last = (
      received.filter((e) => e.type === 'chat.tool').at(-1) as { tool: { status: string } }
    ).tool
    expect(last.status).toBe('error')
  })

  test('a permission request becomes chat.permission', async () => {
    const request = {
      id: 'r1',
      sessionId: 's',
      kind: 'command' as const,
      action: 'bash',
      target: 'rm -rf x',
      reason: 'dangerous',
      pattern: 'rm',
      time: new Date().toISOString(),
    }
    fakeEvents = [
      { kind: 'permission_required', request },
      { kind: 'done', text: 'ok', usage: { input: 0, output: 0, cost: 0 } },
    ]

    const s = createSession('test', db)
    await streamReply(s.id, 'm-permission', choice)

    const permissionEvent = received.find((e) => e.type === 'chat.permission') as {
      request: { id: string }
    }
    expect(permissionEvent?.request.id).toBe('r1')
  })

  test('with tools: false the plain conversation stream is used', async () => {
    fakeEvents = [{ kind: 'done', text: 'ok', usage: { input: 0, output: 0, cost: 0 } }]
    const s = createSession('test', db)
    await streamReply(s.id, 'm-toolless', choice, { tools: false })

    // `conversationStream` receives no work directory in its options
    expect((lastCall?.options as { workDir?: string })?.workDir).toBeUndefined()
  })

  test('the work directory is supplied when tools are in play', async () => {
    fakeEvents = [{ kind: 'done', text: 'ok', usage: { input: 0, output: 0, cost: 0 } }]
    const s = createSession('test', db)
    await streamReply(s.id, 'm-dir', choice)

    const options = lastCall?.options as { workDir?: string; sessionId?: string }
    expect(options?.workDir).toBeTruthy()
    expect(options?.sessionId).toBe(s.id)
  })
})

describe('chat.status — broadcasting the stream state', () => {
  /** Only the statuses of the status events, in arrival order */
  function statuses(): string[] {
    return received
      .filter((e) => e.type === 'chat.status')
      .map((e) => (e as { status: string }).status)
  }

  test('a successful stream: running → done', async () => {
    fakeEvents = [
      { kind: 'delta', text: 'ok' },
      { kind: 'done', text: 'ok', usage: { input: 0, output: 0, cost: 0 } },
    ]

    const s = createSession('test', db)
    await streamReply(s.id, 'st-1', choice)

    expect(statuses()).toEqual(['running', 'done'])
  })

  test("on error the final state is 'error'", async () => {
    fakeEvents = [{ kind: 'error', message: 'connection lost' }]

    const s = createSession('test', db)
    await streamReply(s.id, 'st-2', choice)

    expect(statuses()).toEqual(['running', 'error'])
  })

  test('the status event carries the session id', async () => {
    fakeEvents = [{ kind: 'done', text: 'ok', usage: { input: 0, output: 0, cost: 0 } }]
    const s = createSession('test', db)
    await streamReply(s.id, 'st-3', choice)

    const status = received.find((e) => e.type === 'chat.status') as { sessionId: string }
    expect(status.sessionId).toBe(s.id)
  })

  test("asking for permission gives 'awaiting-permission', carrying on gives 'running' again", async () => {
    const request = {
      id: 'r-status',
      sessionId: 's',
      kind: 'command' as const,
      action: 'bash',
      target: 'rm -rf x',
      reason: 'dangerous',
      pattern: 'rm',
      time: new Date().toISOString(),
    }
    fakeEvents = [
      { kind: 'permission_required', request },
      // Once the answer arrives the agent carries on — the next event is the
      // "it has moved again" signal
      { kind: 'delta', text: 'carrying on' },
      { kind: 'done', text: 'carrying on', usage: { input: 0, output: 0, cost: 0 } },
    ]

    const s = createSession('test', db)
    await streamReply(s.id, 'st-4', choice)

    expect(statuses()).toEqual(['running', 'awaiting-permission', 'running', 'done'])
  })

  test("consecutive permission requests do not produce a surplus 'running'", async () => {
    const request = (id: string) => ({
      id,
      sessionId: 's',
      kind: 'command' as const,
      action: 'bash',
      target: 'ls',
      reason: 'x',
      pattern: 'ls',
      time: new Date().toISOString(),
    })
    fakeEvents = [
      { kind: 'permission_required', request: request('a') },
      { kind: 'permission_required', request: request('b') },
      { kind: 'done', text: '', usage: { input: 0, output: 0, cost: 0 } },
    ]

    const s = createSession('test', db)
    await streamReply(s.id, 'st-5', choice)

    expect(statuses()).toEqual([
      'running',
      'awaiting-permission',
      'awaiting-permission',
      'running',
      'done',
    ])
  })
})

describe('chat.status — when one stream replaces another', () => {
  test("an old stream does not mark the new one's state as 'done'", async () => {
    // A RACE: the user sent a new message without waiting for the reply. The
    // old stream is stopped and finishes — but by then it is the NEW stream
    // that sits in the registry. If the old one broadcast a final status, the
    // stream that had only just started would immediately show as "done" in the
    // UI and the indicator would disappear.
    const s = createSession('test', db)

    fakeEvents = [{ kind: 'done', text: 'first', usage: { input: 0, output: 0, cost: 0 } }]
    const first = streamReply(s.id, 'race-1', choice)
    // We start the second without waiting for the first to finish
    const second = streamReply(s.id, 'race-2', choice)
    await Promise.all([first, second])

    // The session leaves the registry in the end (the second one finished too)
    expect(runningSessions()).toEqual([])

    // The point: 'done' exactly ONCE — the second stream's. The old one stayed quiet.
    const final = received.filter(
      (e) => e.type === 'chat.status' && (e as { status: string }).status === 'done',
    )
    expect(final).toHaveLength(1)
  })
})

describe('runningSessions()', () => {
  test('an empty list when no stream is running', () => {
    expect(runningSessions()).toEqual([])
  })

  test('a session in flight appears in the list, with its status', async () => {
    const s = createSession('test', db)
    let duringStream: { sessionId: string; status: string }[] = []

    // We read the list IN THE MIDDLE of the stream: while the `delta` event is
    // arriving the session should still be running.
    fakeEvents = [
      { kind: 'delta', text: 'a' },
      { kind: 'done', text: 'a', usage: { input: 0, output: 0, cost: 0 } },
    ]
    // We do not await `streamReply` — it runs synchronously up to the first
    // `await`, which means the registry entry has already been added by then.
    const promise = streamReply(s.id, 'run-1', choice)
    duringStream = runningSessions()
    await promise

    expect(duringStream).toEqual([{ sessionId: s.id, status: 'running' }])
    // Once finished it leaves the list
    expect(runningSessions()).toEqual([])
  })

  test("a session waiting for permission shows as 'awaiting-permission'", async () => {
    const s = createSession('test', db)
    let whileWaiting: { sessionId: string; status: string }[] = []

    fakeEvents = [
      {
        kind: 'permission_required',
        request: {
          id: 'r-list',
          sessionId: s.id,
          kind: 'command' as const,
          action: 'bash',
          target: 'ls',
          reason: 'x',
          pattern: 'ls',
          time: new Date().toISOString(),
        },
      },
      { kind: 'done', text: '', usage: { input: 0, output: 0, cost: 0 } },
    ]

    // We catch the status event and read the list at exactly that moment — the
    // "awaiting-permission" state only exists while the stream is running.
    const observer = {
      data: { id: 'observer', channels: new Set(['chat']) },
      send: (m: string) => {
        const e = JSON.parse(m) as { type: string; status?: string }
        if (e.type === 'chat.status' && e.status === 'awaiting-permission') {
          whileWaiting = runningSessions()
        }
      },
    }
    hub.connected(observer as never)

    await streamReply(s.id, 'run-2', choice)

    expect(whileWaiting).toEqual([{ sessionId: s.id, status: 'awaiting-permission' }])
  })
})

describe('GET /api/chat/running — while a stream is in flight', () => {
  test('a running session comes back with its title', async () => {
    const s = createSession('Background task', db)
    fakeEvents = [
      { kind: 'delta', text: 'a' },
      { kind: 'done', text: 'a', usage: { input: 0, output: 0, cost: 0 } },
    ]

    const promise = streamReply(s.id, 'run-api-1', choice)
    const response = await app.request('/api/chat/running')
    const body = (await response.json()) as {
      running: { sessionId: string; status: string; title?: string }[]
    }
    await promise

    expect(body.running).toEqual([
      { sessionId: s.id, status: 'running', title: 'Background task' },
    ])
  })

  test('the list empties once the stream has finished', async () => {
    const s = createSession('test', db)
    fakeEvents = [{ kind: 'done', text: 'ok', usage: { input: 0, output: 0, cost: 0 } }]
    await streamReply(s.id, 'run-api-2', choice)

    const response = await app.request('/api/chat/running')
    expect(await response.json()).toEqual({ running: [] })
  })
})

describe('audit', () => {
  test('every reply reaches the audit log', async () => {
    fakeEvents = [{ kind: 'done', text: 'ok', usage: { input: 0, output: 0, cost: 0 } }]
    const s = createSession('test', db)
    await streamReply(s.id, 'message-10', choice)

    const entries = db
      .query<{ actor: string; target: string; result: string }, []>(
        "SELECT actor, target, result FROM audit_log WHERE actor = 'chat'",
      )
      .all()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.target).toBe('ollama/qwen3:0.6b')
    expect(entries[0]?.result).toBe('OK')
  })

  test('an error case is marked as denied in the audit log', async () => {
    fakeEvents = [{ kind: 'error', message: 'error' }]
    const s = createSession('test', db)
    await streamReply(s.id, 'message-11', choice)

    const entry = db
      .query<{ result: string }, []>("SELECT result FROM audit_log WHERE actor = 'chat'")
      .get()
    expect(entry?.result).toBe('denied')
  })
})

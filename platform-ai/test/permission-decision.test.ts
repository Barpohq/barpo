// Is the permission DECISION ORIGIN recorded?
//
// "Why was this command run?" — the user's most important question, and the
// answer used to be stored nowhere: `ask()` returned only
// `'allow' | 'deny'`, so whether auto mode allowed it, the user pressed a
// button, or an "always" pattern matched — all of it looked the same. This
// test forces an origin to be recorded for every path.

import { beforeEach, describe, expect, test } from 'bun:test'
import type { PermissionDecision } from '@platforma/shared'
import { PermissionManager } from '../src/permission.ts'

function ask(pattern = 'bash:ls') {
  return {
    kind: 'command' as const,
    action: 'bash',
    target: 'ls',
    reason: 'test',
    pattern,
  }
}

let manager: PermissionManager
let decisions: PermissionDecision[]

beforeEach(() => {
  manager = new PermissionManager('test-session')
  decisions = []
  manager.subscribeDecisions((d) => decisions.push(d))
})

describe('permission decision origin', () => {
  test("the user granted permission — origin is 'user'", async () => {
    const waiting = manager.ask(ask())
    const request = manager.pendingRequests[0]!
    manager.answer(request.id, 'allow')

    expect(await waiting).toBe('allow')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({
      requestId: request.id,
      origin: 'user',
      granted: true,
      pattern: 'bash:ls',
    })
    expect(decisions[0]!.time).toBeString()
  })

  test('"always" gives two different origins: the press and its later use', async () => {
    const first = manager.ask(ask())
    manager.answer(manager.pendingRequests[0]!.id, 'always')
    expect(await first).toBe('allow')
    expect(decisions[0]).toMatchObject({ origin: 'user-always', granted: true })

    // It is not asked a second time — but the decision still has to be
    // recorded, otherwise the action that ran would leave no trace
    expect(await manager.ask(ask())).toBe('allow')
    expect(decisions).toHaveLength(2)
    expect(decisions[1]).toMatchObject({ origin: 'always', granted: true, pattern: 'bash:ls' })
    expect(decisions[1]!.requestId).toBeUndefined()
  })

  test('a denial is recorded', async () => {
    const waiting = manager.ask(ask())
    manager.answer(manager.pendingRequests[0]!.id, 'deny')

    expect(await waiting).toBe('deny')
    expect(decisions[0]).toMatchObject({ origin: 'denied', granted: false })
  })

  test('a timeout is a decision too — it does not vanish silently', async () => {
    manager.setWaitTimeout(10)
    expect(await manager.ask(ask())).toBe('deny')
    expect(decisions[0]).toMatchObject({ origin: 'timeout', granted: false })
  })

  test('a pending request is recorded when the session closes', async () => {
    const waiting = manager.ask(ask())
    manager.close()

    expect(await waiting).toBe('deny')
    // `cancelled`, NOT `denied`: the session was closed from outside (registry
    // TTL, the process stopping) — the user did not deny this action. Writing
    // that down as "you denied it" would pin on them something they never did.
    expect(decisions[0]).toMatchObject({ origin: 'cancelled', granted: false })
  })

  test('the request is closed IMMEDIATELY when the stream is cancelled', async () => {
    // ┌──────────────────────────────────────────────────────────────────┐
    // │ The reason for this test is a heavy one. `ask()` used to not see │
    // │ cancellation at all: a stream whose "Stop" was pressed would     │
    // │ hang here for 5 MINUTES. During that time:                       │
    // │   - the old stream's card stayed alive in the UI, and pressing   │
    // │     it would RUN the command the user had STOPPED;               │
    // │   - once the deadline passed the decision was written onto the   │
    // │     NEW stream's tool card, making the "who granted permission"  │
    // │     trail a lie.                                                 │
    // └──────────────────────────────────────────────────────────────────┘
    const controller = new AbortController()
    const collected: PermissionDecision[] = []
    const m = new PermissionManager('cancel-session')
    m.subscribeDecisions((d) => collected.push(d))
    // The signal arrives through the classifier context (that is how agent.ts
    // supplies it)
    m.setClassifierContext({
      mode: { mode: 'confirm' } as never,
      conversation: [],
      workDir: '/tmp',
      signal: controller.signal,
    })

    const waiting = m.ask(ask('bash:ssh'))
    expect(m.pendingRequests).toHaveLength(1)

    controller.abort()

    expect(await waiting).toBe('deny')
    // The request left the list — the UI will not restore and show it
    expect(m.pendingRequests).toHaveLength(0)
    // `cancelled`, NOT `denied`: the user did not deny this action
    expect(collected).toHaveLength(1)
    expect(collected[0]).toMatchObject({ origin: 'cancelled', granted: false })
  })

  test('on an already cancelled stream the request never enters the list', async () => {
    const controller = new AbortController()
    controller.abort()
    const m = new PermissionManager('cancel-2')
    const collected: PermissionDecision[] = []
    m.subscribeDecisions((d) => collected.push(d))
    m.setClassifierContext({
      mode: { mode: 'confirm' } as never,
      conversation: [],
      workDir: '/tmp',
      signal: controller.signal,
    })

    expect(await m.ask(ask())).toBe('deny')
    expect(m.pendingRequests).toHaveLength(0)
    expect(collected[0]?.origin).toBe('cancelled')
  })

  test('cancelling an already answered request writes NO SECOND decision', async () => {
    const controller = new AbortController()
    const m = new PermissionManager('cancel-3')
    const collected: PermissionDecision[] = []
    m.subscribeDecisions((d) => collected.push(d))
    m.setClassifierContext({
      mode: { mode: 'confirm' } as never,
      conversation: [],
      workDir: '/tmp',
      signal: controller.signal,
    })

    const waiting = m.ask(ask())
    m.answer(m.pendingRequests[0]!.id, 'allow')
    expect(await waiting).toBe('allow')

    controller.abort()
    // One request — one decision. Otherwise the correct row in the database
    // would be overwritten with "cancelled".
    expect(collected).toHaveLength(1)
    expect(collected[0]?.origin).toBe('user')
  })

  test('a hard deny is recorded with its own origin', () => {
    manager.recordForbidden('rm -rf /')
    expect(decisions[0]).toMatchObject({
      origin: 'forbidden',
      granted: false,
      pattern: 'rm -rf /',
    })
  })

  test('a listener error does not break the permission flow', async () => {
    manager.subscribeDecisions(() => {
      throw new Error('the listener failed')
    })
    const waiting = manager.ask(ask())
    manager.answer(manager.pendingRequests[0]!.id, 'allow')
    expect(await waiting).toBe('allow')
  })
})

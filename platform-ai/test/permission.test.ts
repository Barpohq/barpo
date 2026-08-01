// The permission manager — requests, answers, the "always" pattern, timeout.

import { afterEach, describe, expect, test } from 'bun:test'
import type { PermissionRequest } from '@barpo/shared'
import { PermissionManager, permissionManager, closePermissionManager, clearPermissions } from '../src/permission.ts'

afterEach(() => {
  clearPermissions()
})

const ask = (pattern = 'rm') => ({
  kind: 'command' as const,
  action: 'bash',
  target: 'rm -rf x',
  reason: 'test',
  pattern,
})

describe('request and answer', () => {
  test('the listener receives the request', async () => {
    const manager = new PermissionManager('s1')
    const received: PermissionRequest[] = []
    manager.subscribe((r) => received.push(r))

    const waiting = manager.ask(ask())
    expect(received).toHaveLength(1)
    expect(received[0]?.sessionId).toBe('s1')
    expect(received[0]?.target).toBe('rm -rf x')

    manager.answer(received[0]!.id, 'allow')
    expect(await waiting).toBe('allow')
  })

  test('a deny answer comes back', async () => {
    const manager = new PermissionManager('s1')
    manager.subscribe((r) => manager.answer(r.id, 'deny'))
    expect(await manager.ask(ask())).toBe('deny')
  })

  test('answer() returns false for an unknown id', () => {
    const manager = new PermissionManager('s1')
    expect(manager.answer('no-such-id', 'allow')).toBe(false)
  })

  test('pending requests show up in the list', async () => {
    const manager = new PermissionManager('s1')
    const waiting = manager.ask(ask())
    expect(manager.pendingRequests).toHaveLength(1)

    manager.answer(manager.pendingRequests[0]!.id, 'deny')
    await waiting
    expect(manager.pendingRequests).toHaveLength(0)
  })
})

describe('always allow', () => {
  test('the pattern is remembered and not asked again', async () => {
    const manager = new PermissionManager('s1')
    let askedCount = 0
    manager.subscribe((r) => {
      askedCount += 1
      manager.answer(r.id, 'always')
    })

    expect(await manager.ask(ask('git push'))).toBe('allow')
    expect(askedCount).toBe(1)

    // The second and third time it is not asked
    expect(await manager.ask(ask('git push'))).toBe('allow')
    expect(await manager.ask(ask('git push'))).toBe('allow')
    expect(askedCount).toBe(1)
    expect(manager.alwaysList).toEqual(['git push'])
  })

  test('a different pattern is asked again', async () => {
    const manager = new PermissionManager('s1')
    let askedCount = 0
    manager.subscribe((r) => {
      askedCount += 1
      manager.answer(r.id, 'always')
    })

    await manager.ask(ask('git push'))
    await manager.ask(ask('rm'))
    expect(askedCount).toBe(2)
  })

  test('the isAlwaysAllowed check', async () => {
    const manager = new PermissionManager('s1')
    manager.subscribe((r) => manager.answer(r.id, 'always'))
    expect(manager.isAlwaysAllowed('rm')).toBe(false)
    await manager.ask(ask('rm'))
    expect(manager.isAlwaysAllowed('rm')).toBe(true)
  })

  test('a deny answer does not remember the pattern', async () => {
    const manager = new PermissionManager('s1')
    manager.subscribe((r) => manager.answer(r.id, 'deny'))
    await manager.ask(ask('rm'))
    expect(manager.alwaysList).toHaveLength(0)
  })

  test('an empty pattern is not remembered', async () => {
    const manager = new PermissionManager('s1')
    manager.subscribe((r) => manager.answer(r.id, 'always'))
    await manager.ask({ ...ask(''), pattern: '' })
    expect(manager.alwaysList).toHaveLength(0)
  })
})

describe('parallel requests', () => {
  test('each one gets its own answer', async () => {
    const manager = new PermissionManager('s1')
    const received: PermissionRequest[] = []
    manager.subscribe((r) => received.push(r))

    const a = manager.ask({ ...ask('a'), target: 'A' })
    const c = manager.ask({ ...ask('b'), target: 'B' })
    expect(received).toHaveLength(2)

    // We answer in reverse order
    const requestB = received.find((r) => r.target === 'B')!
    const requestA = received.find((r) => r.target === 'A')!
    manager.answer(requestB.id, 'deny')
    manager.answer(requestA.id, 'allow')

    expect(await a).toBe('allow')
    expect(await c).toBe('deny')
  })
})

describe('closing', () => {
  test('pending requests are denied on close', async () => {
    const manager = new PermissionManager('s1')
    const waiting = manager.ask(ask())
    manager.close()
    expect(await waiting).toBe('deny')
  })

  test('a request after closing is denied immediately', async () => {
    const manager = new PermissionManager('s1')
    manager.close()
    expect(await manager.ask(ask())).toBe('deny')
  })
})

describe('registry', () => {
  test('the same session gets the same manager', () => {
    const a = permissionManager('s1')
    const b = permissionManager('s1')
    expect(a).toBe(b)
  })

  test('different sessions are isolated', () => {
    expect(permissionManager('s1')).not.toBe(permissionManager('s2'))
  })

  test('a new manager is given after closing', () => {
    const a = permissionManager('s1')
    closePermissionManager('s1')
    expect(permissionManager('s1')).not.toBe(a)
  })

  test('one session\'s always list does not leak into another', async () => {
    const a = permissionManager('s1')
    a.subscribe((r) => a.answer(r.id, 'always'))
    await a.ask(ask('rm'))

    const b = permissionManager('s2')
    expect(b.isAlwaysAllowed('rm')).toBe(false)
  })
})

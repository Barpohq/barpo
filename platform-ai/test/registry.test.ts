// The session registry — TTL and LRU cleanup.
//
// These tests check exactly the MEMORY LEAK: the Maps in `permission.ts` and
// `mode.ts` never used to shrink, and every new session stayed in them
// forever.
//
// The time is supplied from outside (`get(id, now)`) — the tests do not wait
// on the real clock and are stable because of it.

import { describe, expect, test } from 'bun:test'
import { REGISTRY_LIMIT, REGISTRY_TTL_MS, SessionRegistry } from '../src/registry.ts'

/** A fake manager that records having been closed */
class FakeManager {
  closed = false
  constructor(readonly sessionId: string) {}
  close(): void {
    this.closed = true
  }
}

function createRegistry(ttlMs = REGISTRY_TTL_MS, limit = REGISTRY_LIMIT) {
  return new SessionRegistry<FakeManager>(
    (id) => new FakeManager(id),
    ttlMs,
    limit,
  )
}

describe('basic behaviour', () => {
  test('the same session gives the same object', () => {
    const registry = createRegistry()
    expect(registry.get('s1')).toBe(registry.get('s1'))
  })

  test('different sessions are isolated', () => {
    const registry = createRegistry()
    expect(registry.get('s1')).not.toBe(registry.get('s2'))
    expect(registry.count).toBe(2)
  })

  test('close() closes the object and removes it from the registry', () => {
    const registry = createRegistry()
    const a = registry.get('s1')
    registry.close('s1')

    expect(a.closed).toBe(true)
    expect(registry.count).toBe(0)
    expect(registry.get('s1')).not.toBe(a) // a new one is created
  })

  test('closing a session that does not exist does not fail', () => {
    const registry = createRegistry()
    expect(() => registry.close('none')).not.toThrow()
  })

  test('clear() closes them all', () => {
    const registry = createRegistry()
    const a = registry.get('s1')
    const b = registry.get('s2')
    registry.clear()

    expect(a.closed).toBe(true)
    expect(b.closed).toBe(true)
    expect(registry.count).toBe(0)
  })
})

describe('TTL — cleanup by inactivity', () => {
  test('a session whose TTL has passed is cleaned up', () => {
    const registry = createRegistry(1000)
    const a = registry.get('s1', 0)
    expect(registry.count).toBe(1)

    // A request to another session after the TTL — the old one is cleaned up
    registry.get('s2', 5000)

    expect(a.closed).toBe(true)
    expect(registry.count).toBe(1)
  })

  test('an ACTIVE session is not cleaned up — every request refreshes the time', () => {
    // The most important guarantee: a session whose answer is streaming must
    // not disappear
    const registry = createRegistry(1000)
    const a = registry.get('s1', 0)

    // We keep making requests (that is what the agent does on every tool call)
    for (let t = 500; t <= 10_000; t += 500) {
      expect(registry.get('s1', t)).toBe(a)
    }

    expect(a.closed).toBe(false)
  })

  test('a repeat request within the TTL gives the same object', () => {
    const registry = createRegistry(1000)
    const a = registry.get('s1', 0)
    expect(registry.get('s1', 900)).toBe(a)
    expect(a.closed).toBe(false)
  })

  test('a request to a session whose TTL has passed gives a NEW object', () => {
    const registry = createRegistry(1000)
    const a = registry.get('s1', 0)
    const b = registry.get('s1', 5000)

    expect(b).not.toBe(a)
    expect(a.closed).toBe(true)
  })

  test('sweepStale returns how many were cleaned up', () => {
    const registry = createRegistry(1000)
    registry.get('s1', 0)
    registry.get('s2', 0)
    registry.get('s3', 0)
    expect(registry.count).toBe(3)

    // All three whose TTL has passed get cleaned up
    expect(registry.sweepStale(5000)).toBe(3)
    expect(registry.count).toBe(0)
  })

  test('stale entries are cleaned up inside get() too', () => {
    // `get()` evicts the stale ones first — no separate timer is needed
    const registry = createRegistry(1000)
    registry.get('s1', 0)
    registry.get('s2', 0)
    expect(registry.count).toBe(2)

    registry.get('s3', 4000) // the TTL passed → s1 and s2 are cleaned up here

    expect(registry.count).toBe(1)
    expect(registry.sweepStale(4000)).toBe(0) // nothing left to clean up
  })

  test('several old sessions are cleaned up at once', () => {
    const registry = createRegistry(1000)
    for (let i = 0; i < 50; i += 1) registry.get(`old-${i}`, 0)
    expect(registry.count).toBe(50)

    registry.get('new', 5000)

    expect(registry.count).toBe(1) // only the new one is left
  })
})

describe('LRU — the limit on the count', () => {
  test('the oldest is evicted when the limit is exceeded', () => {
    const registry = createRegistry(REGISTRY_TTL_MS, 3)
    const a = registry.get('s1', 0)
    registry.get('s2', 1)
    registry.get('s3', 2)
    registry.get('s4', 3) // the limit was exceeded

    expect(a.closed).toBe(true)
    expect(registry.count).toBe(3)
  })

  test('a recently used session is kept', () => {
    // The LRU works by "least recently TOUCHED", not "oldest CREATED"
    const registry = createRegistry(REGISTRY_TTL_MS, 3)
    const a = registry.get('s1', 0)
    registry.get('s2', 1)
    registry.get('s3', 2)

    registry.get('s1', 3) // s1 is requested again — now it is the newest
    registry.get('s4', 4) // the limit was exceeded → s2 must go, not s1

    expect(a.closed).toBe(false)
    expect(registry.get('s1', 5)).toBe(a)
  })

  test('the limit holds firmly (the many-sessions anomaly)', () => {
    const registry = createRegistry(REGISTRY_TTL_MS, 10)
    // A script opened 1000 sessions — the TTL cannot keep up, the LRU holds
    for (let i = 0; i < 1000; i += 1) registry.get(`s${i}`, i)

    expect(registry.count).toBe(10)
  })
})

describe('robustness', () => {
  test('a close() error does not stop the cleanup', () => {
    const registry = new SessionRegistry<{ close(): void }>(
      () => ({
        close() {
          throw new Error('error while closing')
        },
      }),
      1000,
      100,
    )
    registry.get('s1', 0)
    registry.get('s2', 0)

    expect(() => registry.clear()).not.toThrow()
    expect(registry.count).toBe(0)
  })

  test('the default values are sensible', () => {
    // Too short a TTL cuts off an active conversation, too long a one leaves
    // the leak in place
    expect(REGISTRY_TTL_MS).toBeGreaterThanOrEqual(5 * 60 * 1000)
    expect(REGISTRY_LIMIT).toBeGreaterThan(0)
  })
})

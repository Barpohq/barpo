// auditWrite / auditRead tests — writing, reading, filtering and WS broadcast.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { auditRead, auditCount, auditWrite } from '../src/audit.ts'
import { openDb, setDb } from '../src/db.ts'
import { hub } from '../src/ws/hub.ts'

let db: Database

beforeEach(() => {
  db = openDb(':memory:')
  setDb(db)
})

afterEach(() => {
  setDb(null)
  hub.clear()
  db.close()
})

describe('auditWrite', () => {
  test('an entry reaches the database and reads back', () => {
    auditWrite('firdavs', 'Trial action', 'frankfurt-1', 'write', 'OK')

    const entries = auditRead()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.actor).toBe('firdavs')
    expect(entries[0]?.action).toBe('Trial action')
    expect(entries[0]?.level).toBe('write')
    expect(entries[0]?.result).toBe('OK')
    expect(entries[0]?.time).toMatch(/^\d{2}:\d{2}$/)
  })

  test('the result defaults to OK when it is not given', () => {
    const entry = auditWrite('daemon', 'Health check', 'nyc-1', 'read')
    expect(entry.result).toBe('OK')
  })

  test('the newest entry comes back first', () => {
    auditWrite('a', 'first', 't', 'read')
    auditWrite('b', 'second', 't', 'read')
    auditWrite('c', 'third', 't', 'read')

    const entries = auditRead()
    expect(entries.map((e) => e.action)).toEqual(['third', 'second', 'first'])
  })

  test('entries are filtered by level', () => {
    auditWrite('a', 'a read action', 't', 'read')
    auditWrite('b', 'a dangerous action', 't', 'dangerous', 'denied')
    auditWrite('c', 'another read', 't', 'read')

    const dangerous = auditRead({ level: 'dangerous' })
    expect(dangerous).toHaveLength(1)
    expect(dangerous[0]?.action).toBe('a dangerous action')
  })

  test('entries are filtered by actor', () => {
    auditWrite('ai-news-bot', 'post', 't', 'write')
    auditWrite('firdavs', 'approval', 't', 'write')
    auditWrite('ai-news-bot', 'another post', 't', 'write')

    expect(auditRead({ actor: 'ai-news-bot' })).toHaveLength(2)
    expect(auditCount({ actor: 'firdavs' })).toBe(1)
  })

  test('limit and offset paginate the log', () => {
    for (let i = 0; i < 10; i++) auditWrite('bot', `action-${i}`, 't', 'read')

    const firstPage = auditRead({ limit: 4 })
    expect(firstPage).toHaveLength(4)
    expect(firstPage[0]?.action).toBe('action-9')

    const secondPage = auditRead({ limit: 4, offset: 4 })
    expect(secondPage).toHaveLength(4)
    expect(secondPage[0]?.action).toBe('action-5')

    expect(auditCount()).toBe(10)
  })

  test('the entry is broadcast through the WS hub', () => {
    const received: unknown[] = []
    // A fake connection is added to the hub: we intercept its send()
    const fake = {
      data: { id: 'test', channels: new Set(['audit']) },
      send: (m: string) => received.push(JSON.parse(m)),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hub.connected(fake as any)
    received.length = 0 // drop the hello event

    auditWrite('firdavs', 'WS trial', 'target', 'dangerous', 'denied')

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      type: 'audit.entry',
      entry: { actor: 'firdavs', action: 'WS trial', level: 'dangerous', result: 'denied' },
    })
  })
})

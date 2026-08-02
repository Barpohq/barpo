// Presence: which sibling sessions share a project, and who is live.
//
// `siblingSessions` is the SQL half (repo.ts), `sessionPresence` marks the
// rows against the streaming set the orchestrator supplies. The prompt text
// itself is tested in barpo-ai (presence-prompt.test.ts).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { openDb, setDb } from '../src/db.ts'
import { createProject, createSession, siblingSessions, writeMessage } from '../src/repo.ts'
import { sessionPresence } from '../src/presence.ts'

let db: Database

beforeEach(() => {
  db = openDb(':memory:')
  setDb(db)
})

afterEach(() => {
  setDb(null)
  db.close()
})

describe('siblingSessions', () => {
  test('two sessions of one project see each other, never themselves', () => {
    const p = createProject('shop', '/tmp/shop', db)
    const a = createSession('chat a', db, p.id)
    const b = createSession('chat b', db, p.id)

    const forA = siblingSessions(a.id, db)
    expect(forA.map((s) => s.id)).toEqual([b.id])
    const forB = siblingSessions(b.id, db)
    expect(forB.map((s) => s.id)).toEqual([a.id])
  })

  test('a session with no project has no siblings — even among other loners', () => {
    const lonerA = createSession('loner a', db)
    createSession('loner b', db)
    expect(siblingSessions(lonerA.id, db)).toEqual([])
  })

  test('sessions of a DIFFERENT project are not returned', () => {
    const p1 = createProject('one', '/tmp/one', db)
    const p2 = createProject('two', '/tmp/two', db)
    const mine = createSession('mine', db, p1.id)
    createSession('other project', db, p2.id)
    createSession('no project', db)
    expect(siblingSessions(mine.id, db)).toEqual([])
  })

  test('ordered by last activity — a message bumps a session up', () => {
    const p = createProject('busy', '/tmp/busy', db)
    const me = createSession('me', db, p.id)
    const older = createSession('older', db, p.id)
    const newer = createSession('newer', db, p.id)

    // `older` becomes the most recently active by receiving a message with
    // a future timestamp — the real bump path, not a fabricated UPDATE.
    writeMessage(
      { sessionId: older.id, role: 'user', text: 'hi', createdAt: '2999-01-01T00:00:00Z' },
      db,
    )

    const ids = siblingSessions(me.id, db).map((s) => s.id)
    expect(ids[0]).toBe(older.id)
    expect(ids).toContain(newer.id)
  })

  test('the list is capped at 20 in the query', () => {
    const p = createProject('crowded', '/tmp/crowded', db)
    const me = createSession('me', db, p.id)
    for (let i = 0; i < 30; i += 1) createSession(`chat ${i}`, db, p.id)
    expect(siblingSessions(me.id, db).length).toBe(20)
  })

  test('an unknown session id returns an empty list, not an error', () => {
    expect(siblingSessions('no-such-session', db)).toEqual([])
  })
})

describe('sessionPresence', () => {
  test('marks streaming from the supplied set', () => {
    const p = createProject('live', '/tmp/live', db)
    const me = createSession('me', db, p.id)
    const active = createSession('active', db, p.id)
    const idle = createSession('idle', db, p.id)

    const result = sessionPresence(me.id, new Set([active.id]), db)
    const byTitle = new Map(result.map((s) => [s.title, s.streaming]))
    expect(byTitle.get('active')).toBe(true)
    expect(byTitle.get('idle')).toBe(false)
  })

  test('an empty streaming set marks nobody', () => {
    const p = createProject('quiet', '/tmp/quiet', db)
    const me = createSession('me', db, p.id)
    createSession('other', db, p.id)
    const result = sessionPresence(me.id, new Set(), db)
    expect(result.every((s) => !s.streaming)).toBe(true)
  })

  test('carries title and updatedAt through for the prompt', () => {
    const p = createProject('carry', '/tmp/carry', db)
    const me = createSession('me', db, p.id)
    const other = createSession('the other one', db, p.id)
    const [s] = sessionPresence(me.id, new Set(), db)
    expect(s!.title).toBe('the other one')
    expect(s!.updatedAt).toBe(other.updatedAt)
  })
})

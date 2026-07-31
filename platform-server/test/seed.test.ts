// Seed idempotency — restarting must not duplicate the seeded data.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { AppManifest } from '@platforma/shared'
import { openDb } from '../src/db.ts'
import { saveApp, readApps } from '../src/repo.ts'
import { applySeed } from '../src/seed.ts'

let db: Database

beforeEach(() => {
  db = openDb(':memory:')
})

afterEach(() => {
  db.close()
})

/** Test manifest — the seed ships no apps, so the tests create their own */
const testApp: AppManifest = {
  id: 'expense-bot',
  icon: '💸',
  name: 'expense-bot',
  tagline: 'Expense tracker',
  version: 'v0.1.0',
  service: 'frankfurt-1 · docker',
  status: 'running',
  widgets: [{ type: 'note', text: 'trial' }],
}

describe('applySeed', () => {
  test('the first call fills every table', () => {
    const result = applySeed(db)
    expect(result.audit).toBe(12)
    // The app seed is deliberately empty: a dashboard is built from a real
    // manifest.
    expect(result.apps).toBe(0)
    expect(readApps(db)).toHaveLength(0)
  })

  test('a second call writes nothing (idempotent)', () => {
    applySeed(db)
    const second = applySeed(db)

    expect(second).toEqual({ audit: 0, apps: 0 })
  })
})

describe('saveApp (upsert)', () => {
  test('a new manifest is inserted and reported as new', () => {
    const { record, isNew } = saveApp(testApp, db)

    expect(isNew).toBe(true)
    expect(record.id).toBe('expense-bot')
    expect(readApps(db)).toHaveLength(1)
  })

  test('an existing manifest is updated and reported as not new', () => {
    saveApp(testApp, db)

    const { isNew } = saveApp({ ...testApp, version: 'v9.9.9', status: 'idle' }, db)

    expect(isNew).toBe(false)
    expect(readApps(db)).toHaveLength(1)
    expect(readApps(db)[0]?.manifest.version).toBe('v9.9.9')
    expect(readApps(db)[0]?.status).toBe('idle')
  })
})

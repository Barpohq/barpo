// Seed idempotency — restarting must not duplicate the seeded data.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { openDb } from '../src/db.ts'
import { publishApp, readApps, readPublication } from '../src/repo.ts'
import { applySeed } from '../src/seed.ts'
import { cleanupApps, publishTestApp, useTempApps, writeManifest } from './app-fixture.ts'

let db: Database
let root: string

beforeEach(() => {
  db = openDb(':memory:')
  root = useTempApps()
})

afterEach(() => {
  db.close()
  cleanupApps(root)
})

describe('applySeed', () => {
  test('the first call fills every table', async () => {
    const result = applySeed(db)
    expect(result.audit).toBe(12)
    // The app seed is deliberately empty — and now it CANNOT be anything else:
    // an app is a folder on disk, so a seeded row would point nowhere.
    expect(result.apps).toBe(0)
    expect(await readApps(db)).toHaveLength(0)
  })

  test('a second call writes nothing (idempotent)', () => {
    applySeed(db)
    const second = applySeed(db)

    expect(second).toEqual({ audit: 0, apps: 0 })
  })
})

describe('publishApp (upsert)', () => {
  test('a new folder is recorded and reported as new', async () => {
    await publishTestApp(root, 'expense-bot', {}, db)

    expect(readPublication('expense-bot', db)).not.toBeNull()
    expect(await readApps(db)).toHaveLength(1)
  })

  test('publishing the same id again is not a duplicate', async () => {
    await publishTestApp(root, 'expense-bot', {}, db)

    const { isNew } = publishApp('expense-bot', `${root}/expense-bot`, 'idle', db)

    expect(isNew).toBe(false)
    expect(await readApps(db)).toHaveLength(1)
  })

  test('the manifest comes from the FILE, not from the publish row', async () => {
    // The row records only that a folder was published. Everything the user
    // sees is read back from disk, which is why editing the file is enough.
    await publishTestApp(root, 'expense-bot', { version: 'v0.1.0' }, db)
    writeManifest(root, 'expense-bot', { version: 'v9.9.9', status: 'idle' })

    const apps = await readApps(db)
    expect(apps[0]?.manifest.version).toBe('v9.9.9')
    expect(apps[0]?.status).toBe('idle')
  })
})

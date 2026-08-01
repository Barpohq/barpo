// The live state layer — execution, caching and per-state intervals.
//
// THE CORE REQUIREMENT: every state is INDEPENDENT. If CPU refreshes every 5
// seconds and disk every 60, neither may force the other to recompute.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../src/db.ts'
import { publishDashboard } from '../src/dashboard-save.ts'
import { readApp } from '../src/repo.ts'
import { MIN_INTERVAL, normaliseInterval, runState, validateCode } from '../src/state-run.ts'
import { cacheSize, clearAppCache, clearCache, getState } from '../src/state-cache.ts'
import {
  cleanupApps,
  publishManifest,
  useTempApps,
  writeAppFile,
  writeManifestAsFolder,
} from './app-fixture.ts'

let db: Database
let appsRoot: string

beforeEach(() => {
  db = openDb(':memory:')
  clearCache()
  appsRoot = useTempApps()
})

afterEach(() => {
  db.close()
  cleanupApps(appsRoot)
})

describe('runState', () => {
  test('returns a plain value', async () => {
    const result = await runState('module.exports = async () => ({ a: 1 })', 'x')
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ a: 1 })
  })

  test('require and child_process work', async () => {
    // The whole point of this layer is fetching real data from the server
    const result = await runState(
      `module.exports = async () => {
         const { execSync } = require('child_process')
         return { output: execSync('echo hello').toString().trim() }
       }`,
      'x',
    )
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ output: 'hello' })
  })

  test('code that throws DOES NOT THROW here, it returns a result', async () => {
    const result = await runState("module.exports = async () => { throw new Error('crashed') }", 'x')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('crashed')
  })

  test('a syntax error is caught', async () => {
    const result = await runState('this ( is a syntax error', 'x')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Syntax error')
  })

  test('code that does not export a function is rejected', async () => {
    const result = await runState('module.exports = 42', 'x')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('module.exports')
  })

  test('a result that cannot be turned into JSON is rejected', async () => {
    const result = await runState(
      'module.exports = async () => { const a = {}; a.self = a; return a }',
      'x',
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('JSON')
  })
})

describe('normaliseInterval — stops polling that is too fast', () => {
  test('an interval below the floor is raised to it', () => {
    expect(normaliseInterval(1)).toBe(MIN_INTERVAL)
    expect(normaliseInterval(0.5)).toBe(MIN_INTERVAL)
  })

  test('a sensible interval is left alone', () => {
    expect(normaliseInterval(30)).toBe(30)
  })

  test('missing or zero means no automatic refresh', () => {
    expect(normaliseInterval(undefined)).toBe(0)
    expect(normaliseInterval(0)).toBe(0)
    expect(normaliseInterval(-5)).toBe(0)
  })
})

describe('the cache — every state is INDEPENDENT', () => {
  test('within the interval the code IS NOT RE-EXECUTED', async () => {
    // A value that changes on every call: if the cache works, it stays put
    const code = 'module.exports = async () => ({ n: Math.random() })'
    const a = await getState('app', 'cpu', code, 60)
    const b = await getState('app', 'cpu', code, 60)
    expect(b.value).toEqual(a.value!)
  })

  test('different states DO NOT force one another to recompute', async () => {
    // This is the requirement itself: CPU refreshing every 3s must leave the
    // 60s disk state alone
    const code = 'module.exports = async () => ({ n: Math.random() })'
    const cpu = await getState('app', 'cpu', code, 3)
    const disk = await getState('app', 'disk', code, 60)
    expect(cpu.value).not.toEqual(disk.value!)

    // The disk cache is untouched by the CPU request
    const diskAgain = await getState('app', 'disk', code, 60)
    expect(diskAgain.value).toEqual(disk.value!)
  })

  test('when the code changes the cache IS NOT USED', async () => {
    const a = await getState('app', 's', 'module.exports = async () => 1', 60)
    const b = await getState('app', 's', 'module.exports = async () => 2', 60)
    expect(a.value).toBe(1)
    expect(b.value).toBe(2)
  })

  test('force bypasses the cache', async () => {
    const code = 'module.exports = async () => ({ n: Math.random() })'
    const a = await getState('app', 's', code, 60)
    const b = await getState('app', 's', code, 60, true)
    expect(b.value).not.toEqual(a.value!)
  })

  test('concurrent requests SHARE a single execution', async () => {
    // Otherwise 3 open tabs would mean 3 times the `ssh` load
    const code = 'module.exports = async () => ({ n: Math.random() })'
    const [a, b, c] = await Promise.all([
      getState('app', 's', code, 60),
      getState('app', 's', code, 60),
      getState('app', 's', code, 60),
    ])
    expect(b.value).toEqual(a.value!)
    expect(c.value).toEqual(a.value!)
  })

  test('a failed result is cached too', async () => {
    // If failing code re-ran on every request, the timeouts would pile up
    const code = "module.exports = async () => { throw new Error('x') }"
    await getState('app', 's', code, 60)
    const size = cacheSize()
    await getState('app', 's', code, 60)
    expect(cacheSize()).toBe(size)
  })

  test("an app's cache can be cleared on its own", async () => {
    await getState('app1', 's', 'module.exports = async () => 1', 60)
    await getState('app2', 's', 'module.exports = async () => 1', 60)
    clearAppCache('app1')
    expect(cacheSize()).toBe(1)
  })
})

describe('validateCode', () => {
  test('valid code passes without errors', () => {
    expect(validateCode('module.exports = async () => ({})')).toEqual([])
  })

  test('empty code is rejected', () => {
    expect(validateCode('   ').length).toBeGreaterThan(0)
  })

  test('a syntax error is caught', () => {
    expect(validateCode('function ( {').length).toBeGreaterThan(0)
  })
})

describe('integration with the app folder', () => {
  const base = {
    id: 'state-test',
    name: 'State test',
    widgets: [{ type: 'note', text: 'hello' }],
  }

  test('each state keeps its own interval', async () => {
    await publishManifest(
      appsRoot,
      {
        ...base,
        states: [
          { name: 'cpu', code: 'module.exports = async () => 1', interval: 5 },
          { name: 'disk', code: 'module.exports = async () => 2', interval: 60 },
        ],
      },
      db,
    )

    const states = (await readApp('state-test', db))?.manifest.states
    expect(states).toHaveLength(2)
    // Each state MUST keep its own interval — otherwise `df` would run as
    // often as the CPU reading, for no reason.
    expect(states?.find((s) => s.name === 'cpu')?.interval).toBe(5)
    expect(states?.find((s) => s.name === 'disk')?.interval).toBe(60)
  })

  test('a state with broken syntax is REPORTED, and the file is left alone', async () => {
    writeManifestAsFolder(appsRoot, {
      ...base,
      states: [
        { name: 'good', code: 'module.exports = async () => 1' },
        { name: 'broken', code: 'this ( is a syntax error' },
      ],
    })
    const result = await publishDashboard('state-test', db)

    expect(result.ok).toBe(true)
    expect(result.warnings?.join(' ')).toContain('broken')

    // ┌────────────────────────────────────────────────────────────────┐
    // │ THE FILE MODEL CHANGED WHAT "DROPPED" MEANS.                   │
    // │                                                                │
    // │ The old path deleted the broken state from the stored blob.    │
    // │ There is no blob now — the file is on disk where the agent or  │
    // │ the user put it, so silently erasing it would be a far worse   │
    // │ surprise than a state that does not run. It is reported and    │
    // │ left in place to be fixed.                                     │
    // └────────────────────────────────────────────────────────────────┘
    expect(existsSync(join(appsRoot, 'state-test', 'states', 'broken.js'))).toBe(true)
    expect((await readApp('state-test', db))?.manifest.states).toHaveLength(2)
  })

  test('a file whose name is not a valid state name is skipped', async () => {
    // The name ends up in a URL path, so only `[a-z][a-z0-9_]*` is accepted.
    // A file called `../etc.js` cannot exist in the first place — the folder
    // layout closes that off — but an editor's leftovers can.
    writeManifestAsFolder(appsRoot, base)
    writeAppFile(appsRoot, 'state-test', join('states', 'Bad-Name.js'), 'module.exports = 1')
    const result = await publishDashboard('state-test', db)

    expect(result.ok).toBe(true)
    expect(result.warnings?.join(' ')).toContain('not a valid state name')
    expect((await readApp('state-test', db))?.manifest.states).toBeUndefined()
  })

  test('a duplicate state name is IMPOSSIBLE — the file name is the name', async () => {
    // `data[name]` is a single slot, so two states sharing a name used to be a
    // rejection. The folder model removes the failure mode entirely: writing
    // `states/cpu.js` twice is one file.
    writeManifestAsFolder(appsRoot, base)
    writeAppFile(appsRoot, 'state-test', join('states', 'cpu.js'), 'module.exports = async () => 1')
    writeAppFile(appsRoot, 'state-test', join('states', 'cpu.js'), 'module.exports = async () => 2')
    const result = await publishDashboard('state-test', db)

    expect(result.ok).toBe(true)
    const states = (await readApp('state-test', db))?.manifest.states
    expect(states).toHaveLength(1)
    expect(states?.[0]?.code).toContain('2')
  })
})

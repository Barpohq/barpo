// The live state layer — execution, caching and per-state intervals.
//
// THE CORE REQUIREMENT: every state is INDEPENDENT. If CPU refreshes every 5
// seconds and disk every 60, neither may force the other to recompute.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { openDb } from '../src/db.ts'
import { saveDashboard } from '../src/dashboard-save.ts'
import { readApp } from '../src/repo.ts'
import { MIN_INTERVAL, normaliseInterval, runState, validateCode } from '../src/state-run.ts'
import { cacheSize, clearAppCache, clearCache, getState } from '../src/state-cache.ts'

let db: Database

beforeEach(() => {
  db = openDb(':memory:')
  clearCache()
})

afterEach(() => {
  db.close()
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

describe('integration with the manifest', () => {
  const base = {
    id: 'state-test',
    name: 'State test',
    widgets: [{ type: 'note', text: 'hello' }],
  }

  test('states are stored alongside the manifest', async () => {
    const result = await saveDashboard(
      {
        ...base,
        states: [
          { name: 'cpu', code: 'module.exports = async () => 1', interval: 5 },
          { name: 'disk', code: 'module.exports = async () => 2', interval: 60 },
        ],
      },
      db,
    )
    expect(result.ok).toBe(true)

    const states = readApp('state-test', db)?.manifest.states
    expect(states).toHaveLength(2)
    // Each state MUST keep its own interval
    expect(states?.find((s) => s.name === 'cpu')?.interval).toBe(5)
    expect(states?.find((s) => s.name === 'disk')?.interval).toBe(60)
  })

  test('a broken state is DROPPED and the healthy one survives', async () => {
    const result = await saveDashboard(
      {
        ...base,
        states: [
          { name: 'good', code: 'module.exports = async () => 1' },
          { name: 'broken', code: 'this ( is a syntax error' },
        ],
      },
      db,
    )
    expect(result.ok).toBe(true)
    expect(readApp('state-test', db)?.manifest.states).toHaveLength(1)
    expect(result.warnings?.join(' ')).toContain('broken')
  })

  test('an invalid name is dropped (it ends up in a URL path)', async () => {
    const result = await saveDashboard(
      { ...base, states: [{ name: '../etc', code: 'module.exports = async () => 1' }] },
      db,
    )
    expect(result.ok).toBe(true)
    expect(readApp('state-test', db)?.manifest.states).toBeUndefined()
  })

  test('a duplicate name REJECTS the manifest', async () => {
    // `data[name]` is a single slot — which code survived would be down to chance
    const result = await saveDashboard(
      {
        ...base,
        states: [
          { name: 'cpu', code: 'module.exports = async () => 1' },
          { name: 'cpu', code: 'module.exports = async () => 2' },
        ],
      },
      db,
    )
    expect(result.ok).toBe(false)
    expect(result.errors?.join(' ')).toContain('Duplicate')
  })
})

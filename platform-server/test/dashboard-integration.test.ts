// The dynamic dashboard — the end-to-end flow.
//
// The whole chain from the `appPublish` tool down to the database is checked
// here: validation → compilation → saving → reading back.
//
// THE CORE REQUIREMENT: A MISTAKE BY THE AI MUST NOT BRING THE PLATFORM DOWN.
// Most of these tests exist to pin exactly that down — when broken code or a
// broken manifest arrives, they check what SURVIVES.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createAppPublishTool } from '@platforma/ai'
import { openDb } from '../src/db.ts'
import { saveDashboard } from '../src/dashboard-save.ts'
import { readApp } from '../src/repo.ts'

let db: Database

beforeEach(() => {
  db = openDb(':memory:')
})

afterEach(() => {
  db.close()
})

const base = {
  id: 'test-app',
  name: 'Test app',
  widgets: [{ type: 'note', text: 'hello' }],
}

describe('saveDashboard — the main flow', () => {
  test('a manifest with widgets is saved and read back', async () => {
    const result = await saveDashboard(base, db)
    expect(result.ok).toBe(true)
    expect(result.isNew).toBe(true)

    const row = readApp('test-app', db)
    expect(row?.manifest.name).toBe('Test app')
    expect(row?.manifest.widgets).toHaveLength(1)
  })

  test('publishing again under the same id REPLACES the app', async () => {
    await saveDashboard(base, db)
    const result = await saveDashboard({ ...base, name: 'Updated' }, db)

    expect(result.ok).toBe(true)
    expect(result.isNew).toBe(false)
    expect(readApp('test-app', db)?.manifest.name).toBe('Updated')
  })

  test('a broken manifest is REJECTED and nothing is saved', async () => {
    const result = await saveDashboard({ name: 'no id' }, db)
    expect(result.ok).toBe(false)
    expect(result.errors?.length).toBeGreaterThan(0)
    expect(readApp('no id', db)).toBeNull()
  })
})

describe('the JSX code flow', () => {
  test('correct code is compiled and stored', async () => {
    const result = await saveDashboard(
      { ...base, view: { code: 'export default function View({ data }) { return <i>{data.a}</i> }' } },
      db,
    )
    expect(result.ok).toBe(true)

    const view = readApp('test-app', db)?.manifest.view
    // What lands in the database is the COMPILED code, not the source
    expect(view?.code).toContain('React.createElement')
    // In the shape `new Function` runs: it returns the component
    expect(view?.code).toContain('return __result__')
    expect(view?.hash).toBeTruthy()
  })

  test('the data snapshot is stored alongside the manifest', async () => {
    const result = await saveDashboard(
      { ...base, data: { clusters: 247, posts: ['a', 'b'] } },
      db,
    )
    expect(result.ok).toBe(true)
    expect(readApp('test-app', db)?.manifest.data).toEqual({
      clusters: 247,
      posts: ['a', 'b'],
    })
  })
})

describe('ERROR ISOLATION — the core requirement', () => {
  test('broken code is DROPPED, the widgets are KEPT', async () => {
    const result = await saveDashboard(
      { ...base, view: { code: 'export default () => <div>' } },
      db,
    )

    // The app MUST be saved: losing an entire dashboard over one broken piece
    // of code hurts the user.
    expect(result.ok).toBe(true)
    expect(result.warnings?.join(' ')).toContain('did not compile')

    const manifest = readApp('test-app', db)?.manifest
    expect(manifest?.widgets).toHaveLength(1)
    expect(manifest?.view).toBeUndefined()
  })

  test('code using fetch is dropped, the widgets remain', async () => {
    const result = await saveDashboard(
      { ...base, view: { code: 'export default () => { fetch("/api/x"); return <i/> }' } },
      db,
    )
    expect(result.ok).toBe(true)
    expect(readApp('test-app', db)?.manifest.view).toBeUndefined()
  })

  test('no widgets + broken code = REJECTED', async () => {
    // There would be nothing left to display — better to hand the error back
    // to the AI and have it fixed than to show an empty page.
    const result = await saveDashboard(
      { ...base, widgets: [], view: { code: 'export default () => <div>' } },
      db,
    )
    expect(result.ok).toBe(false)
    expect(readApp('test-app', db)).toBeNull()
  })

  test('a broken widget is dropped, the healthy ones are saved', async () => {
    const result = await saveDashboard(
      {
        ...base,
        widgets: [
          { type: 'note', text: 'good' },
          { type: 'unknown-type' },
          { type: 'bars', title: 'T', items: [{ label: 'a', value: 'not-a-number' }] },
        ],
      },
      db,
    )
    expect(result.ok).toBe(true)
    expect(readApp('test-app', db)?.manifest.widgets).toHaveLength(1)
    expect(result.warnings?.length).toBeGreaterThan(0)
  })
})

describe('the full chain through the appPublish tool', () => {
  /** Runs the tool the way the agent calls it */
  async function publish(params: Record<string, unknown>) {
    const tool = createAppPublishTool((m) => saveDashboard(m, db))
    const result = await tool.execute('id-1', params as never, undefined, undefined, {
      env: { cwd: '/anywhere' },
    })
    return {
      text: result.content.map((b) => ('text' in b ? b.text : '')).join(''),
      isError: result.isError,
    }
  }

  test('a tool call writes to the database', async () => {
    const result = await publish({
      id: 'final-test',
      name: 'Final test',
      widgets: [{ type: 'stats', items: [{ label: 'A', value: '1' }] }],
    })

    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('published')
    expect(readApp('final-test', db)?.manifest.widgets).toHaveLength(1)
  })

  test('the tool carries a `view` string all the way through compilation', async () => {
    await publish({
      id: 'with-code',
      name: 'With code',
      data: { count: 5 },
      view: 'export default function View({ data }) { return <b>{data.count}</b> }',
    })

    const manifest = readApp('with-code', db)?.manifest
    expect(manifest?.view?.code).toContain('React.createElement')
    expect(manifest?.data).toEqual({ count: 5 })
  })

  test('a rejected call comes back to the model AS AN ERROR', async () => {
    const result = await publish({ id: 'BAD ID', name: 'x' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('REJECTED')
  })
})

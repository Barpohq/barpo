// The dynamic dashboard — the end-to-end flow.
//
// The whole chain from the `appPublish` tool down to the rendered manifest is
// checked here: files on disk → validation → compilation → publish record →
// reading back.
//
// THE CORE REQUIREMENT: A MISTAKE BY THE AI MUST NOT BRING THE PLATFORM DOWN.
// Most of these tests exist to pin exactly that down — when broken code or a
// broken `app.json` arrives, they check what SURVIVES.
//
// THE SECOND REQUIREMENT, new with the folder model: EDITING A FILE IS THE
// UPDATE. Several tests below write a file, read the app back, and assert the
// change is live without anything being re-published — that is the behaviour
// the whole change exists for.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAppPublishTool } from '@platforma/ai'
import { openDb } from '../src/db.ts'
import { publishDashboard } from '../src/dashboard-save.ts'
import { deleteApp } from '../src/app-delete.ts'
import { readApp, readApps, readPublication } from '../src/repo.ts'
import { setDb } from '../src/db.ts'

let db: Database
let root: string

beforeEach(() => {
  db = openDb(':memory:')
  // `deleteApp` and the audit trail reach for the global database.
  setDb(db)

  root = mkdtempSync(join(tmpdir(), 'platforma-apps-'))
  process.env.PLATFORM_APPS = root
})

afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
  delete process.env.PLATFORM_APPS
})

/** Writes a file inside an app folder, creating the directories it needs */
function writeApp(id: string, file: string, content: string): void {
  const path = join(root, id, file)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

/** The smallest publishable app */
function writeBase(id = 'test-app', extra: Record<string, unknown> = {}): void {
  writeApp(
    id,
    'app.json',
    JSON.stringify({
      id,
      name: 'Test app',
      widgets: [{ type: 'note', text: 'hello' }],
      ...extra,
    }),
  )
}

describe('publishDashboard — the main flow', () => {
  test('a folder with app.json is published and read back', async () => {
    writeBase()
    const result = await publishDashboard('test-app', db)
    expect(result.ok).toBe(true)
    expect(result.isNew).toBe(true)

    const row = await readApp('test-app', db)
    expect(row?.manifest.name).toBe('Test app')
    expect(row?.manifest.widgets).toHaveLength(1)
    // The folder is reported so the UI can tell the user where to edit
    expect(row?.dir).toBe(join(root, 'test-app'))
  })

  test('publishing again is a re-publish, not a duplicate', async () => {
    writeBase()
    await publishDashboard('test-app', db)
    const result = await publishDashboard('test-app', db)

    expect(result.ok).toBe(true)
    expect(result.isNew).toBe(false)
    expect(await readApps(db)).toHaveLength(1)
  })

  test('publishing a folder that does not exist FAILS and says where files go', async () => {
    const result = await publishDashboard('never-written', db)
    expect(result.ok).toBe(false)
    // The likeliest mistake is publishing before writing, so the message has
    // to point at the path rather than just reporting failure.
    expect(result.errors?.join(' ')).toContain('app.json')
    expect(await readApp('never-written', db)).toBeNull()
  })

  test('an id that is not a usable folder name is refused', async () => {
    const result = await publishDashboard('BAD ID', db)
    expect(result.ok).toBe(false)
    expect(result.errors?.join(' ')).toContain('lowercase')
  })

  test('app.json that is not valid JSON fails with the reason', async () => {
    writeApp('broken', 'app.json', '{ this is not json')
    const result = await publishDashboard('broken', db)
    expect(result.ok).toBe(false)
    expect(result.errors?.join(' ')).toContain('not valid JSON')
  })

  test('the id inside app.json must match the folder', async () => {
    // Otherwise the URL, the sidebar entry and the file path would disagree
    // about which app this is.
    writeApp(
      'folder-name',
      'app.json',
      JSON.stringify({ id: 'different-id', name: 'X', widgets: [] }),
    )
    const result = await publishDashboard('folder-name', db)
    expect(result.ok).toBe(false)
    expect(result.errors?.join(' ')).toContain('must match')
  })
})

describe('EDITING A FILE IS THE UPDATE — no republish', () => {
  test('editing app.json changes the app on the next read', async () => {
    writeBase()
    await publishDashboard('test-app', db)

    writeApp(
      'test-app',
      'app.json',
      JSON.stringify({
        id: 'test-app',
        name: 'Renamed by hand',
        widgets: [{ type: 'note', text: 'a' }, { type: 'note', text: 'b' }],
      }),
    )

    // NOTHING is re-published here — this is the whole point of the model.
    const row = await readApp('test-app', db)
    expect(row?.manifest.name).toBe('Renamed by hand')
    expect(row?.manifest.widgets).toHaveLength(2)
  })

  test('editing view.jsx recompiles it on the next read', async () => {
    writeBase()
    writeApp('test-app', 'view.jsx', 'export default function View() { return <i>one</i> }')
    await publishDashboard('test-app', db)

    const first = await readApp('test-app', db)
    const firstHash = first?.manifest.view?.hash

    writeApp('test-app', 'view.jsx', 'export default function View() { return <b>two</b> }')

    const second = await readApp('test-app', db)
    // A different source means a different hash and a fresh compile — the
    // cache must not serve what the file no longer says.
    expect(second?.manifest.view?.hash).not.toBe(firstHash)
    expect(second?.manifest.view?.code).toContain('React.createElement')
  })

  test('adding a state file makes the state appear without a republish', async () => {
    writeBase('test-app', { states: { cpu: { interval: 5 } } })
    await publishDashboard('test-app', db)
    expect((await readApp('test-app', db))?.manifest.states).toBeUndefined()

    writeApp('test-app', 'states/cpu.js', 'module.exports = async () => ({ percent: 3 })')

    const states = (await readApp('test-app', db))?.manifest.states
    expect(states).toHaveLength(1)
    expect(states?.[0]?.name).toBe('cpu')
    expect(states?.[0]?.interval).toBe(5)
  })

  test('deleting a file removes that part of the app', async () => {
    writeBase()
    writeApp('test-app', 'view.jsx', 'export default () => <i/>')
    await publishDashboard('test-app', db)
    expect((await readApp('test-app', db))?.manifest.view).toBeDefined()

    rmSync(join(root, 'test-app', 'view.jsx'))

    const row = await readApp('test-app', db)
    expect(row?.manifest.view).toBeUndefined()
    // …and the rest of the app is untouched
    expect(row?.manifest.widgets).toHaveLength(1)
  })

  test('a folder deleted by hand makes the app disappear from the list', async () => {
    writeBase()
    await publishDashboard('test-app', db)
    expect(await readApps(db)).toHaveLength(1)

    rmSync(join(root, 'test-app'), { recursive: true, force: true })

    // The app drops off the list rather than breaking the page. The publish
    // row survives, so restoring the files brings it straight back.
    expect(await readApps(db)).toHaveLength(0)
    expect(readPublication('test-app', db)).not.toBeNull()
  })
})

describe('the code files', () => {
  test('a state file name becomes the state name', async () => {
    writeBase('test-app', { states: { disk_usage: { interval: 30 } } })
    writeApp('test-app', 'states/disk_usage.js', 'module.exports = async () => ({ pct: 1 })')
    await publishDashboard('test-app', db)

    const states = (await readApp('test-app', db))?.manifest.states
    expect(states?.[0]?.name).toBe('disk_usage')
    expect(states?.[0]?.code).toContain('module.exports')
  })

  test('a state file with an invalid name is skipped, the app still publishes', async () => {
    // An editor leaving `.cpu.js.swp` behind must not break the dashboard.
    writeBase()
    writeApp('test-app', 'states/Bad-Name.js', 'module.exports = async () => ({})')
    const result = await publishDashboard('test-app', db)

    expect(result.ok).toBe(true)
    expect(result.warnings?.join(' ')).toContain('not a valid state name')
    expect((await readApp('test-app', db))?.manifest.widgets).toHaveLength(1)
  })

  test('an action needs its label in app.json, or it is reported', async () => {
    writeBase()
    writeApp('test-app', 'actions/restart.js', 'module.exports = async () => ({})')
    const result = await publishDashboard('test-app', db)

    expect(result.ok).toBe(true)
    // Silently hiding a button the user wrote would be worse than saying why
    expect(result.warnings?.join(' ')).toContain('has no entry')
    expect((await readApp('test-app', db))?.manifest.actions).toBeUndefined()
  })

  test('an action with its config becomes a button', async () => {
    writeBase('test-app', {
      actions: { restart: { label: 'Restart', confirm: true, risk: 'dangerous' } },
    })
    writeApp('test-app', 'actions/restart.js', 'module.exports = async () => ({})')
    await publishDashboard('test-app', db)

    const actions = (await readApp('test-app', db))?.manifest.actions
    expect(actions).toHaveLength(1)
    expect(actions?.[0]).toMatchObject({ name: 'restart', label: 'Restart', confirm: true })
  })

  test('settings declared without settings.js is reported and dropped', async () => {
    writeBase('test-app', {
      settings: { fields: [{ key: 'token', kind: 'secret', label: 'Token' }] },
    })
    const result = await publishDashboard('test-app', db)

    expect(result.ok).toBe(true)
    expect(result.warnings?.join(' ')).toContain('settings.js is missing')
    expect((await readApp('test-app', db))?.manifest.settings).toBeUndefined()
  })

  test('settings.js and settings.read.js are folded into the manifest', async () => {
    writeBase('test-app', {
      settings: { fields: [{ key: 'mode', kind: 'text', label: 'Mode' }] },
    })
    writeApp('test-app', 'settings.js', 'module.exports = async () => ({ message: "ok" })')
    writeApp('test-app', 'settings.read.js', 'module.exports = async () => ({ mode: "polling" })')
    await publishDashboard('test-app', db)

    const settings = (await readApp('test-app', db))?.manifest.settings
    expect(settings?.write).toContain('message')
    expect(settings?.read).toContain('polling')
  })
})

describe('the JSX code flow', () => {
  test('correct code is compiled and cached', async () => {
    writeBase()
    writeApp(
      'test-app',
      'view.jsx',
      'export default function View({ data }) { return <i>{data.a}</i> }',
    )
    const result = await publishDashboard('test-app', db)
    expect(result.ok).toBe(true)

    const view = (await readApp('test-app', db))?.manifest.view
    // What reaches the browser is the COMPILED code, not the source
    expect(view?.code).toContain('React.createElement')
    // In the shape `new Function` runs: it returns the component
    expect(view?.code).toContain('return __result__')
    expect(view?.hash).toBeTruthy()

    // The cache lives next to the source, so the compile is not repeated
    expect(existsSync(join(root, 'test-app', '.build', 'view.js'))).toBe(true)
  })

  test('the data snapshot comes through app.json', async () => {
    writeBase('test-app', { data: { clusters: 247, posts: ['a', 'b'] } })
    await publishDashboard('test-app', db)
    expect((await readApp('test-app', db))?.manifest.data).toEqual({
      clusters: 247,
      posts: ['a', 'b'],
    })
  })
})

describe('ERROR ISOLATION — the core requirement', () => {
  test('broken code is DROPPED, the widgets are KEPT', async () => {
    writeBase()
    writeApp('test-app', 'view.jsx', 'export default () => <div>')
    const result = await publishDashboard('test-app', db)

    // The app MUST publish: losing an entire dashboard over one broken piece
    // of code hurts the user.
    expect(result.ok).toBe(true)
    expect(result.warnings?.join(' ')).toContain('did not compile')

    const row = await readApp('test-app', db)
    expect(row?.manifest.widgets).toHaveLength(1)
    expect(row?.manifest.view).toBeUndefined()
    // The reason is carried to the USER too — they own these files now
    expect(row?.errors?.join(' ')).toContain('did not compile')
  })

  test('code using fetch is dropped, the widgets remain', async () => {
    writeBase()
    writeApp('test-app', 'view.jsx', 'export default () => { fetch("/api/x"); return <i/> }')
    const result = await publishDashboard('test-app', db)
    expect(result.ok).toBe(true)
    expect((await readApp('test-app', db))?.manifest.view).toBeUndefined()
  })

  test('a broken view with NO widgets FAILS — there would be nothing to show', async () => {
    // The broken view is dropped, which leaves an app with no widgets, no
    // view, no settings and no actions. Publishing that would put an empty
    // page in the sidebar, so it fails instead and the compiler error goes
    // back to whoever is fixing it.
    //
    // The FILES are untouched either way: unlike the old blob model, nothing
    // was lost — `view.jsx` is still on disk waiting to be corrected.
    writeBase('test-app', { widgets: [] })
    writeApp('test-app', 'view.jsx', 'export default () => <div>')
    const result = await publishDashboard('test-app', db)

    expect(result.ok).toBe(false)
    expect(result.errors?.join(' ')).toContain('did not compile')
    expect(result.errors?.join(' ')).toContain('nothing to display')
    expect(existsSync(join(root, 'test-app', 'view.jsx'))).toBe(true)
  })

  test('a broken widget is dropped, the healthy ones are kept', async () => {
    writeApp(
      'test-app',
      'app.json',
      JSON.stringify({
        id: 'test-app',
        name: 'Test app',
        widgets: [
          { type: 'note', text: 'good' },
          { type: 'unknown-type' },
          { type: 'bars', title: 'T', items: [{ label: 'a', value: 'not-a-number' }] },
        ],
      }),
    )
    const result = await publishDashboard('test-app', db)
    expect(result.ok).toBe(true)
    expect((await readApp('test-app', db))?.manifest.widgets).toHaveLength(1)
    expect(result.warnings?.length).toBeGreaterThan(0)
  })

  test('a state with broken syntax is reported but the app still works', async () => {
    writeBase('test-app', { states: { cpu: {} } })
    writeApp('test-app', 'states/cpu.js', 'module.exports = async () => { this is not js')
    const result = await publishDashboard('test-app', db)

    expect(result.ok).toBe(true)
    expect(result.warnings?.join(' ')).toContain('cpu.js')
    // The FILE is left alone — silently deleting what the user can see would
    // be a worse surprise than a broken state.
    expect(existsSync(join(root, 'test-app', 'states', 'cpu.js'))).toBe(true)
  })
})

describe('deleting an app', () => {
  test('the record AND the folder go', async () => {
    writeBase()
    await publishDashboard('test-app', db)

    const result = deleteApp('test-app', 'user', db)

    expect(result.ok).toBe(true)
    expect(result.folderRemoved).toBe(true)
    expect(readPublication('test-app', db)).toBeNull()
    expect(existsSync(join(root, 'test-app'))).toBe(false)
  })

  test('deleting one app leaves the others alone', async () => {
    writeBase('keep-me')
    writeBase('delete-me')
    await publishDashboard('keep-me', db)
    await publishDashboard('delete-me', db)

    deleteApp('delete-me', 'user', db)

    expect(existsSync(join(root, 'keep-me'))).toBe(true)
    expect(await readApps(db)).toHaveLength(1)
  })

  test('an app that was never published cannot be deleted', async () => {
    const result = deleteApp('ghost', 'user', db)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not published')
  })

  test('a folder already gone is not an error', async () => {
    writeBase()
    await publishDashboard('test-app', db)
    rmSync(join(root, 'test-app'), { recursive: true, force: true })

    const result = deleteApp('test-app', 'user', db)
    expect(result.ok).toBe(true)
    expect(result.folderRemoved).toBe(false)
    expect(readPublication('test-app', db)).toBeNull()
  })
})

describe('the full chain through the appPublish tool', () => {
  /** Runs the tool the way the agent calls it */
  async function publish(id: string) {
    const tool = createAppPublishTool((appId: string) => publishDashboard(appId, db))
    const result = await tool.execute('id-1', { id } as never, undefined, undefined, {
      env: { cwd: '/anywhere' },
    })
    return {
      text: result.content.map((b) => ('text' in b ? b.text : '')).join(''),
      // `AgentToolResult` has no `isError` field: a failure is reported by the
      // result text ("FAILED and nothing was registered") and by `details.ok`.
      details: result.details,
    }
  }

  test('a tool call registers the folder', async () => {
    writeApp(
      'final-test',
      'app.json',
      JSON.stringify({
        id: 'final-test',
        name: 'Final test',
        widgets: [{ type: 'stats', items: [{ label: 'A', value: '1' }] }],
      }),
    )

    const result = await publish('final-test')

    expect(result.details?.ok).toBe(true)
    expect(result.text).toContain('published')
    expect((await readApp('final-test', db))?.manifest.widgets).toHaveLength(1)
  })

  test('the tool carries view.jsx all the way through compilation', async () => {
    writeApp(
      'with-code',
      'app.json',
      JSON.stringify({ id: 'with-code', name: 'With code', widgets: [], data: { count: 5 } }),
    )
    writeApp(
      'with-code',
      'view.jsx',
      'export default function View({ data }) { return <b>{data.count}</b> }',
    )

    await publish('with-code')

    const manifest = (await readApp('with-code', db))?.manifest
    expect(manifest?.view?.code).toContain('React.createElement')
    expect(manifest?.data).toEqual({ count: 5 })
  })

  test('a failed call comes back to the model AS AN ERROR', async () => {
    const result = await publish('BAD ID')
    expect(result.details?.ok).toBe(false)
    expect(result.text).toContain('FAILED and nothing was registered')
  })

  test('a successful call tells the model that editing files is the update', async () => {
    writeBase('advice-test')
    const result = await publish('advice-test')
    expect(result.text).toContain('EDIT ITS FILES')
  })
})

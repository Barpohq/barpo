// The behaviour of the `appPublish` and `appDelete` tools: the source
// inversion, their conditional declaration, how a failure is conveyed to the
// model, the confirmation `appDelete` demands, and their agreement with the
// prompt.
//
// These tools have neither a database nor a file system — they rely only on
// the functions the caller supplies. That is why the tests work with fakes.

import { describe, expect, test } from 'bun:test'
import { AGENT_SYSTEM_PROMPT } from '../src/agent.ts'
import { PermissionManager } from '../src/permission.ts'
import {
  DASHBOARD_PROMPT_SECTION,
  createAppDeleteTool,
  createAppPublishTool,
  dashboardTools,
  dashboardToolsRaw,
  resultToText,
  type AppPublishInput,
  type DashboardRemover,
  type DashboardSink,
  type DashboardResult,
} from '../src/dashboard-tools.ts'

const input: AppPublishInput = { id: 'test-app' }

/** Runs the publish tool in the shape `agent.ts` calls it */
async function callTool(sink: DashboardSink, params: AppPublishInput = input) {
  const tool = createAppPublishTool(sink)
  const result = await tool.execute('id-1', params, undefined, undefined, {
    env: { cwd: '/any/where' },
  })
  return {
    text: result.content.map((b) => ('text' in b ? b.text : '')).join(''),
    details: result.details,
  }
}

/**
 * Runs the delete tool, answering the permission request as instructed.
 *
 * The answer is given ASYNCHRONOUSLY, exactly as it arrives in real life: the
 * tool blocks on `ask()` until the user presses a button.
 */
async function callDelete(
  remover: DashboardRemover,
  answer: 'allow' | 'deny' | 'always' | null,
  id = 'test-app',
) {
  const permission = new PermissionManager('session-1')
  const tool = createAppDeleteTool(remover, permission)

  permission.subscribe((request) => {
    if (answer === null) return
    // A microtask, so the tool is already waiting when the answer lands.
    queueMicrotask(() => permission.answer(request.id, answer))
  })

  const result = await tool.execute('id-1', { id }, undefined, undefined, {
    env: { cwd: '/any/where' },
  })

  return {
    text: result.content.map((b) => ('text' in b ? b.text : '')).join(''),
    details: result.details,
    permission,
  }
}

describe('source inversion', () => {
  test('the id is passed to the sink — and nothing else', async () => {
    // The agent does not name a directory: the id determines where the files
    // live, otherwise an app could be published from anywhere on disk.
    let received: unknown
    await callTool((id) => {
      received = id
      return { ok: true, isNew: true }
    })
    expect(received).toBe('test-app')
  })

  test('an async sink is supported', async () => {
    const r = await callTool(async () => ({ ok: true, isNew: true }))
    expect(r.details?.ok).toBe(true)
  })
})

describe('a failure reaches the model as a failure', () => {
  test('when ok is false the details say so and the reasons land in the text', async () => {
    const r = await callTool(() => ({
      ok: false,
      errors: ['app.json is missing', '`data` is too large'],
    }))
    // Without a failure signal the model would carry on believing it was done
    expect(r.details?.ok).toBe(false)
    expect(r.text).toContain('FAILED')
    expect(r.text).toContain('app.json is missing')
    expect(r.text).toContain('`data` is too large')
    // The model must be shown a concrete next step
    expect(r.text).toContain('appPublish again')
  })

  test('on failure "nothing was registered" is stated plainly', async () => {
    const r = await callTool(() => ({ ok: false, errors: ['x'] }))
    expect(r.text.toLowerCase()).toContain('nothing was registered')
  })
})

describe('resultToText', () => {
  test('a new and a re-published app read differently', () => {
    expect(resultToText('a', { ok: true, isNew: true })).toContain('published')
    expect(resultToText('a', { ok: true, isNew: false })).toContain('re-published')
  })

  test('warnings are shown, but not called a failure', () => {
    const m = resultToText('a', {
      ok: true,
      isNew: true,
      warnings: ["Unknown widget type: 'chart' — dropped"],
    })
    expect(m).toContain('published')
    expect(m).toContain("'chart'")
    expect(m).not.toContain('FAILED')
  })

  test('every success tells the model that updating means EDITING THE FILES', () => {
    // This is the whole point of the folder model. If the model does not learn
    // it here it will keep re-publishing the world to change one widget — the
    // exact behaviour that used to lose states and settings.
    for (const isNew of [true, false]) {
      const m = resultToText('a', { ok: true, isNew })
      expect(m).toContain('EDIT ITS FILES')
      expect(m).toContain('do not need to call appPublish again')
    }
  })
})

describe('details (for the UI tool card)', () => {
  test('the app id and the outcome come back', async () => {
    const r = await callTool(() => ({ ok: true, isNew: true }))
    expect(r.details).toEqual({ appId: 'test-app', ok: true, isNew: true })
  })

  test('a failure is carried in the details too', async () => {
    const r = await callTool(() => ({ ok: false, errors: ['x'] }))
    expect(r.details?.ok).toBe(false)
  })
})

describe('appDelete asks before it erases anything', () => {
  test('a denied request deletes NOTHING', async () => {
    let called = false
    const r = await callDelete(() => {
      called = true
      return { ok: true }
    }, 'deny')

    expect(called).toBe(false)
    expect(r.details).toEqual({ appId: 'test-app', ok: false, denied: true })
    expect(r.text).toContain('did NOT allow')
    // The model must not treat a refusal as a retryable error
    expect(r.text).toContain('Do not try again')
  })

  test('an allowed request deletes, and the folder removal is reported', async () => {
    const r = await callDelete(() => ({ ok: true, folderRemoved: true }), 'allow')
    expect(r.details).toEqual({ appId: 'test-app', ok: true, folderRemoved: true })
    expect(r.text).toContain('along with its folder')
  })

  test('a missing folder is not reported as a failure', async () => {
    const r = await callDelete(() => ({ ok: true, folderRemoved: false }), 'allow')
    expect(r.details?.ok).toBe(true)
    expect(r.text).toContain('already gone')
  })

  test('a failing remover comes back as text the model can read', async () => {
    const r = await callDelete(() => ({ ok: false, error: 'not published' }), 'allow')
    expect(r.details?.ok).toBe(false)
    expect(r.text).toContain('not published')
  })

  test('the permission request names the app and warns it cannot be undone', async () => {
    const permission = new PermissionManager('session-1')
    const tool = createAppDeleteTool(() => ({ ok: true }), permission)

    let seen: { target: string; reason: string; action: string } | null = null
    permission.subscribe((request) => {
      seen = { target: request.target, reason: request.reason, action: request.action }
      queueMicrotask(() => permission.answer(request.id, 'deny'))
    })

    await tool.execute('id-1', { id: 'my-app' }, undefined, undefined, {
      env: { cwd: '/x' },
    })

    expect(seen).not.toBeNull()
    expect(seen!.target).toBe('my-app')
    expect(seen!.action).toBe('appDelete')
    expect(seen!.reason).toContain('cannot be undone')
  })

  test('"always" does NOT authorise the next deletion', async () => {
    // ┌──────────────────────────────────────────────────────────────────┐
    // │ THE RULE THE USER ASKED FOR: an app disappears only when a HUMAN │
    // │ said so — every time. If "always" were remembered here, one      │
    // │ answer would silently authorise every future deletion.           │
    // └──────────────────────────────────────────────────────────────────┘
    const permission = new PermissionManager('session-1')
    const tool = createAppDeleteTool(() => ({ ok: true }), permission)

    let asked = 0
    permission.subscribe((request) => {
      asked++
      queueMicrotask(() => permission.answer(request.id, 'always'))
    })

    const context = { env: { cwd: '/x' } }
    await tool.execute('id-1', { id: 'my-app' }, undefined, undefined, context)
    await tool.execute('id-2', { id: 'my-app' }, undefined, undefined, context)

    // Asked BOTH times — the "always" answer was honoured once and not stored.
    expect(asked).toBe(2)
  })
})

describe('conditional declaration', () => {
  test('with no sink and no remover NOTHING is declared', () => {
    // Better than "present, but broken": the model then does not keep trying
    // a capability that is not there.
    expect(dashboardToolsRaw(undefined)).toHaveLength(0)
    expect(dashboardTools(undefined)).toHaveLength(0)
  })

  test('with a sink only appPublish comes out', () => {
    const sink: DashboardSink = () => ({ ok: true })
    expect(dashboardToolsRaw(sink).map((t) => t.name)).toEqual(['appPublish'])
    expect(dashboardTools(sink).map((t) => t.name)).toEqual(['appPublish'])
  })

  test('appDelete needs BOTH a remover and the permission manager', () => {
    // A delete tool that cannot ask is exactly the thing this design refuses
    // to ship, so a missing permission manager silently drops the tool rather
    // than declaring one that would delete unasked.
    const sink: DashboardSink = () => ({ ok: true })
    const remover: DashboardRemover = () => ({ ok: true })
    const permission = new PermissionManager('s')

    expect(dashboardToolsRaw(sink, remover, undefined).map((t) => t.name)).toEqual(['appPublish'])
    expect(dashboardToolsRaw(sink, undefined, permission).map((t) => t.name)).toEqual(['appPublish'])
    expect(dashboardToolsRaw(sink, remover, permission).map((t) => t.name)).toEqual([
      'appPublish',
      'appDelete',
    ])
  })

  test('a remover alone declares appDelete without appPublish', () => {
    // Publishing and deleting are separate capabilities — a caller may offer
    // one without the other.
    const remover: DashboardRemover = () => ({ ok: true })
    const permission = new PermissionManager('s')
    expect(dashboardToolsRaw(undefined, remover, permission).map((t) => t.name)).toEqual([
      'appDelete',
    ])
  })
})

describe('the prompt agrees with the tool', () => {
  test('when the tool exists the prompt mentions it', () => {
    const p = AGENT_SYSTEM_PROMPT('/work', undefined, undefined, undefined, false, true)
    expect(p).toContain('appPublish')
    // The core rule has to be in the prompt — otherwise the agent writes an endpoint
    expect(p).toContain('do NOT write an HTTP endpoint')
  })

  test('when the tool is absent the prompt does NOT mention it at all', () => {
    const p = AGENT_SYSTEM_PROMPT('/work', undefined, undefined, undefined, false, false)
    expect(p).not.toContain('appPublish')
  })

  test('the prompt section states the same rules as the tool description', () => {
    const rules = DASHBOARD_PROMPT_SECTION.rules.join(' ')
    expect(rules).toContain('appPublish')
    // That live data comes through a state file has to be stated in the prompt:
    // otherwise the AI puts the values into app.json and the dashboard freezes
    expect(rules).toContain('states/')
    // And the update rule, which is the reason apps became folders
    expect(rules).toContain('EDIT ITS FILES')
  })
})

describe('the core rules are stated in the description', () => {
  test('appPublish explains the folder, the update rule and the no-API rule', async () => {
    const tool = createAppPublishTool(() => ({ ok: true }))
    // Line breaks must not get in the way of the check
    const description = tool.description.replace(/\s+/g, ' ')

    expect(description).toContain('do NOT write an API')
    expect(description).toContain('~/.barpo/apps/<id>/')
    // The most valuable single line: how to change an app afterwards
    expect(description).toContain('TO UPDATE AN APP, EDIT ITS FILES')
    expect(description).toContain('states/<name>.js')
  })

  test('appDelete states plainly that it erases the folder and cannot be undone', () => {
    const permission = new PermissionManager('s')
    const tool = createAppDeleteTool(() => ({ ok: true }), permission)
    const description = tool.description.replace(/\s+/g, ' ')

    expect(description).toContain('CANNOT BE UNDONE')
    expect(description).toContain('entire folder')
    // The model must not reach for deletion when an edit would do
    expect(description).toContain('prefer editing its files')
  })
})

describe('the result shape', () => {
  test('DashboardResult works without its optional fields too', () => {
    const r: DashboardResult = { ok: true }
    expect(resultToText('a', r)).toContain('re-published')
  })
})

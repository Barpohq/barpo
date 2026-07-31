// The behaviour of the `appPublish` tool: the source inversion, its
// conditional declaration, how a rejection is conveyed to the model, and its
// agreement with the prompt.
//
// This tool has neither a database nor a file system — it relies only on the
// function the caller supplies. That is why the tests work with a fake sink.

import { describe, expect, test } from 'bun:test'
import { AGENT_SYSTEM_PROMPT } from '../src/agent.ts'
import {
  DASHBOARD_PROMPT_SECTION,
  createAppPublishTool,
  dashboardTools,
  dashboardToolsRaw,
  resultToText,
  type AppPublishInput,
  type DashboardSink,
  type DashboardResult,
} from '../src/dashboard-tools.ts'

const input: AppPublishInput = {
  id: 'test-app',
  name: 'Test app',
  widgets: [{ type: 'note', text: 'hello' }],
}

/** Runs the tool in the shape `agent.ts` calls it */
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

describe('source inversion', () => {
  test('the manifest is passed to the sink', async () => {
    let received: unknown
    await callTool((m) => {
      received = m
      return { ok: true, isNew: true }
    })
    expect(received).toMatchObject({ id: 'test-app', name: 'Test app' })
  })

  test('view arrives as a STRING and lands in the manifest as an OBJECT', async () => {
    // Asking the model for a nested object confuses it, while the contract
    // expects `{ code, hash }` — the conversion has to happen inside the tool.
    let received: Record<string, unknown> = {}
    await callTool(
      (m) => {
        received = m as Record<string, unknown>
        return { ok: true }
      },
      { ...input, view: 'export default () => null' },
    )
    expect(received.view).toEqual({ code: 'export default () => null', hash: '' })
  })

  test('an empty view does not land in the manifest at all', async () => {
    let received: Record<string, unknown> = {}
    await callTool(
      (m) => {
        received = m as Record<string, unknown>
        return { ok: true }
      },
      { ...input, view: '   ' },
    )
    expect('view' in received).toBe(false)
  })

  test('an async sink is supported', async () => {
    const r = await callTool(async () => ({ ok: true, isNew: true }))
    expect(r.details?.ok).toBe(true)
  })
})

describe('a rejection reaches the model as a failure', () => {
  test('when ok is false the details say so and the reasons land in the text', async () => {
    const r = await callTool(() => ({
      ok: false,
      errors: ['`id` is required', '`data` is too large'],
    }))
    // Without a failure signal the model would carry on believing it was done
    expect(r.details?.ok).toBe(false)
    expect(r.text).toContain('REJECTED')
    expect(r.text).toContain('`id` is required')
    expect(r.text).toContain('`data` is too large')
    // The model must be shown a concrete next step
    expect(r.text).toContain('appPublish again')
  })

  test('on rejection "nothing was saved" is stated plainly', async () => {
    const r = await callTool(() => ({ ok: false, errors: ['x'] }))
    expect(r.text.toLowerCase()).toContain('nothing was saved')
  })
})

describe('resultToText', () => {
  test('a new and an updated dashboard read differently', () => {
    expect(resultToText('a', { ok: true, isNew: true })).toContain('published')
    expect(resultToText('a', { ok: true, isNew: false })).toContain('updated')
  })

  test('warnings are shown, but not called an error', () => {
    const m = resultToText('a', {
      ok: true,
      isNew: true,
      warnings: ["Unknown widget type: 'chart' — dropped"],
    })
    expect(m).toContain('published')
    expect(m).toContain("'chart'")
    expect(m).not.toContain('REJECTED')
  })
})

describe('details (for the UI tool card)', () => {
  test('the widget count and whether there is code come back', async () => {
    const r = await callTool(() => ({ ok: true }), {
      ...input,
      widgets: [{ type: 'note', text: 'a' }, { type: 'note', text: 'b' }],
      view: 'export default () => null',
    })
    expect(r.details).toEqual({
      appId: 'test-app',
      ok: true,
      widgets: 2,
      hasCode: true,
      settings: 0,
      actions: 0,
    })
  })

  test('a call without widgets does not fall over either', async () => {
    const r = await callTool(() => ({ ok: true }), { id: 'a', name: 'A' })
    expect(r.details?.widgets).toBe(0)
    expect(r.details?.hasCode).toBe(false)
  })

  test('the control layer is counted', async () => {
    const r = await callTool(() => ({ ok: true }), {
      ...input,
      settings: {
        fields: [
          { key: 'token', kind: 'secret', label: 'Token' },
          { key: 'mode', kind: 'text', label: 'Mode' },
        ],
        write: 'module.exports = async () => {}',
      },
      actions: [{ name: 'restart', label: 'Restart', code: 'module.exports = async () => {}' }],
    })

    expect(r.details?.settings).toBe(2)
    expect(r.details?.actions).toBe(1)
  })
})

describe('conditional declaration', () => {
  test('with no sink the tool is NOT DECLARED AT ALL', () => {
    // Better than "present, but broken": the model then does not keep trying
    // a capability that is not there.
    expect(dashboardToolsRaw(undefined)).toHaveLength(0)
    expect(dashboardTools(undefined)).toHaveLength(0)
  })

  test('with a sink one tool comes out', () => {
    const sink: DashboardSink = () => ({ ok: true })
    expect(dashboardToolsRaw(sink).map((t) => t.name)).toEqual(['appPublish'])
    expect(dashboardTools(sink).map((t) => t.name)).toEqual(['appPublish'])
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

  test('the prompt section states the same rule as the tool description', () => {
    const rules = DASHBOARD_PROMPT_SECTION.rules.join(' ')
    expect(rules).toContain('appPublish')
    // That live data comes through `states` has to be stated in the prompt:
    // otherwise the AI puts the values into `data` and the dashboard freezes
    expect(rules).toContain('states')
  })
})

describe('the core rules are stated in the description', () => {
  test('the tool description says plainly not to write an API, and mentions `states`', async () => {
    const tool = createAppPublishTool(() => ({ ok: true }))
    // Line breaks must not get in the way of the check
    const description = tool.description.replace(/\s+/g, ' ')

    expect(description).toContain('do NOT write an API')
    // That `states` is needed for a changing value is the most misleading
    // point, so it has to be in the description
    expect(description).toContain('states')
    expect(description).toContain('frozen forever')
  })
})

describe('the result shape', () => {
  test('DashboardResult works without its optional fields too', () => {
    const r: DashboardResult = { ok: true }
    expect(resultToText('a', r)).toContain('updated')
  })
})

// JSX compilation — this pins down that a mistake in AI-written code cannot
// bring the whole dashboard down, and that constructs which do not work in
// the sandbox are caught early.

import { describe, expect, test } from 'bun:test'
import { buildView, codeHash, escapeForScript, findForbidden } from '../src/view-build.ts'

describe('buildView — the happy path', () => {
  test('JSX is turned into React.createElement', async () => {
    const result = await buildView('export default function View({ data }) { return <div>{data.a}</div> }')
    expect(result.ok).toBe(true)
    expect(result.code).toContain('React.createElement')
    // The classic transform: NO import may be added, otherwise the code would
    // not run at all in the browser, where there is no module loader.
    expect(result.code).not.toContain('jsx-runtime')
    expect(result.code).not.toMatch(/^\s*import\s/m)
  })

  test('React hooks are left as globals', async () => {
    const result = await buildView(
      'export default function View() { const [a] = useState(0); return <b>{a}</b> }',
    )
    expect(result.ok).toBe(true)
    expect(result.code).toContain('useState')
  })

  test('the hash is stable for a given source and changes when the source does', async () => {
    const a = await buildView('export default () => <i>a</i>')
    const b = await buildView('export default () => <i>a</i>')
    const c = await buildView('export default () => <i>b</i>')
    expect(a.hash).toBe(b.hash!)
    expect(a.hash).not.toBe(c.hash!)
    expect(a.hash).toBe(codeHash('export default () => <i>a</i>'))
  })

  test('fragments and nested elements work', async () => {
    const result = await buildView('export default () => <><span>a</span><span>b</span></>')
    expect(result.ok).toBe(true)
    expect(result.code).toContain('React.Fragment')
  })

  test('the output ACTUALLY runs and returns a component', async () => {
    // This is the most important test: the code is called in the browser
    // through `new Function` in exactly this way (`AiView.tsx`). If the shape
    // breaks, the dashboard stops working entirely — and none of the other
    // tests would notice.
    const result = await buildView(
      'export default function View({ data, ui }) { return <ui.Card>{data.a}</ui.Card> }',
    )
    expect(result.ok).toBe(true)

    const fakeReact = {
      createElement: (kind: unknown, _p: unknown, ...children: unknown[]) => ({ kind, children }),
      Fragment: 'fragment',
    }
    const component = new Function('React', 'useState', result.code!)(fakeReact, () => [])
    expect(typeof component).toBe('function')

    const element = component({ data: { a: 'hello' }, ui: { Card: 'CARD' } })
    expect(element).toEqual({ kind: 'CARD', children: ['hello'] })
  })

  test('hooks reach the component as arguments', async () => {
    const result = await buildView(
      'export default function View() { const [x] = useState(7); return <i>{x}</i> }',
    )
    expect(result.ok).toBe(true)

    const fakeReact = { createElement: (_t: unknown, _p: unknown, ...c: unknown[]) => c }
    const component = new Function('React', 'useState', result.code!)(fakeReact, (v: unknown) => [v])
    expect(component({})).toEqual([7])
  })
})

describe('buildView — a failure RETURNS A RESULT, it does not throw', () => {
  test('a syntax error is caught', async () => {
    const result = await buildView('export default () => <div>')
    expect(result.ok).toBe(false)
    expect(result.code).toBeUndefined()
    expect(result.errors.length).toBeGreaterThan(0)
  })

  test('an import is rejected and the reason is explained', async () => {
    const result = await buildView('import React from "react"\nexport default () => <i/>')
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('import')
  })

  test('empty code is an error', async () => {
    const result = await buildView('')
    expect(result.ok).toBe(false)
  })

  test('a dynamic import() is rejected too', async () => {
    // The bundler would let this through as an external dependency and the
    // code would fail SILENTLY in the sandbox — the AI would never learn why.
    const result = await buildView('export default () => { import("react"); return <i/> }')
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('import')
  })
})

describe('escapeForScript — stops an inline script from being cut short', () => {
  // REGRESSION. This bug really did happen in the browser: a `"<script></script>"`
  // string inside React's code closed the sandbox HTML's script block early,
  // and the rest of the bundle rendered as PAGE TEXT. As a result `window.React`
  // was never defined and the sandbox reported "React runtime failed to load".
  test('a </script sequence is escaped', () => {
    expect(escapeForScript('a = "</script>"')).toBe('a = "<\\/script>"')
  })

  test('the match is case-insensitive', () => {
    // The HTML parser reads `</SCRIPT` as a closing tag as well
    expect(escapeForScript('x = "</SCRIPT>"')).toContain('<\\/SCRIPT')
    expect(escapeForScript('x = "</ScRiPt>"')).toContain('<\\/ScRiPt')
  })

  test('other tags are left alone', () => {
    expect(escapeForScript('x = "</div>"')).toBe('x = "</div>"')
  })

  test('the compiler output is already escaped', async () => {
    // The protection sits where the code is BUILT — the UI does not have to
    // repeat it
    const result = await buildView('export default () => { const s = "</script>"; return <i>{s}</i> }')
    expect(result.ok).toBe(true)
    expect(result.code).not.toContain('</script')
    expect(result.code).toContain('<\\/script')
  })
})

describe('findForbidden — view code only draws', () => {
  test('fetch is rejected and the author is pointed at `states`', async () => {
    // The view runs in the host page, so `fetch` is TECHNICALLY possible. It
    // must not be used, though: data arrives through `states`, and only then
    // do the cache and the interval control apply.
    const result = await buildView('export default () => { fetch("/api/x"); return <i/> }')
    expect(result.ok).toBe(false)
    // Stating the reason MATTERS: otherwise the AI would repeat the same mistake
    expect(result.errors.join(' ')).toContain('states')
  })

  test('network APIs are detected', () => {
    expect(findForbidden('new WebSocket("ws://x")')).toHaveLength(1)
    expect(findForbidden('new XMLHttpRequest()')).toHaveLength(1)
  })

  test('browser storage is detected', () => {
    expect(findForbidden('localStorage.getItem("a")')).toHaveLength(1)
    expect(findForbidden('document.cookie')).toHaveLength(1)
  })

  test('clean code produces no warnings', () => {
    expect(findForbidden('const a = data.x.map(v => v * 2)')).toHaveLength(0)
  })
})

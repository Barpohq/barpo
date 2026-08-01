// Hook system tests.
//
// The behaviours being enforced:
//   1) in `before` the FIRST hook that blocks wins — a later hook cannot
//      override it (otherwise hook ordering would affect security);
//   2) a `before` hook error BLOCKS THE TOOL (fail-closed) — if a hook that
//      hides secrets does not run, letting the result through unfiltered is
//      more dangerous;
//   3) an `after` hook error does not lose the result, but does not pass
//      silently either.

import { describe, expect, test } from 'bun:test'
import {
  afterChain,
  observerHook,
  redactSecretsHook,
  beforeChain,
  extraDenyHook,
  lengthHook,
  type ToolHook,
} from '../src/hooks.ts'

const context = {
  name: 'bash',
  args: { command: 'ls' },
  workDir: '/work',
  sessionId: 's1',
}

const resultContext = { ...context, result: 'output', isError: false }

describe('the before chain', () => {
  test('undefined when nobody blocks', async () => {
    const hooks: ToolHook[] = [{ name: 'a' }, { name: 'b', before: () => undefined }]
    expect(await beforeChain(hooks, context)).toBeUndefined()
  })

  test('a blocking hook stops the tool', async () => {
    const hooks: ToolHook[] = [{ name: 'a', before: () => ({ block: true, reason: 'not allowed' }) }]
    const result = await beforeChain(hooks, context)
    expect(result?.block).toBe(true)
    expect(result?.reason).toBe('not allowed')
  })

  test('the FIRST hook that blocks wins — the rest are not called', async () => {
    // A later hook must not be able to undo the block
    let secondCalled = false
    const hooks: ToolHook[] = [
      { name: 'a', before: () => ({ block: true, reason: 'first' }) },
      {
        name: 'b',
        before: () => {
          secondCalled = true
          return undefined
        },
      },
    ]
    const result = await beforeChain(hooks, context)
    expect(result?.reason).toBe('first')
    expect(secondCalled).toBe(false)
  })

  test('a hook ERROR BLOCKS the tool (fail-closed)', async () => {
    const hooks: ToolHook[] = [
      {
        name: 'broken',
        before: () => {
          throw new Error('it did not work')
        },
      },
    ]
    const result = await beforeChain(hooks, context)
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('broken')
  })

  test('an async hook is supported', async () => {
    const hooks: ToolHook[] = [
      { name: 'a', before: async () => ({ block: true, reason: 'async block' }) },
    ]
    expect((await beforeChain(hooks, context))?.reason).toBe('async block')
  })

  test('the hook name is used when no reason is given', async () => {
    const hooks: ToolHook[] = [{ name: 'nameless', before: () => ({ block: true }) }]
    expect((await beforeChain(hooks, context))?.reason).toContain('nameless')
  })
})

describe('the after chain', () => {
  test('the result is unchanged when nobody modifies it', async () => {
    const result = await afterChain([{ name: 'a' }], resultContext)
    expect(result.result).toBe('output')
    expect(result.isError).toBe(false)
  })

  test('a hook replaces the result', async () => {
    const hooks: ToolHook[] = [{ name: 'a', after: () => ({ result: 'new' }) }]
    expect((await afterChain(hooks, resultContext)).result).toBe('new')
  })

  test('hooks work as a CHAIN — the next one sees the previous one\'s result', async () => {
    const hooks: ToolHook[] = [
      { name: 'a', after: ({ result }) => ({ result: `${result}-1` }) },
      { name: 'b', after: ({ result }) => ({ result: `${result}-2` }) },
    ]
    expect((await afterChain(hooks, resultContext)).result).toBe('output-1-2')
  })

  test('a hook error does not lose the result, but it is visible', async () => {
    const hooks: ToolHook[] = [
      {
        name: 'broken',
        after: () => {
          throw new Error('it failed')
        },
      },
    ]
    const result = await afterChain(hooks, resultContext)
    expect(result.result).toContain('output')
    expect(result.result).toContain('broken')
  })

  test('the error flag can be changed', async () => {
    const hooks: ToolHook[] = [{ name: 'a', after: () => ({ isError: true }) }]
    expect((await afterChain(hooks, resultContext)).isError).toBe(true)
  })
})

describe('hiding secrets', () => {
  const hook = redactSecretsHook()

  async function redact(result: string): Promise<string> {
    return (await afterChain([hook], { ...resultContext, result })).result
  }

  test('env-shaped keys are hidden', async () => {
    const output = await redact('OPENAI_API_KEY=sk-abcdefghijklmnopqrst\nPORT=3000')
    expect(output).not.toContain('sk-abcdefghijklmnopqrst')
    expect(output).toContain('OPENAI_API_KEY')
    // A non-secret value stays
    expect(output).toContain('PORT=3000')
  })

  test('JSON-shaped keys are hidden', async () => {
    const output = await redact('{"api_key": "very-secret-value", "port": 3000}')
    expect(output).not.toContain('very-secret-value')
    expect(output).toContain('port')
  })

  test('recognised key shapes are hidden regardless of the name', async () => {
    const output = await redact('the token is: ghp_abcdefghijklmnopqrstuvwxyz12')
    expect(output).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz12')
  })

  test('the result is untouched when there is nothing secret', async () => {
    const text = 'ordinary output, no secrets at all'
    expect(await redact(text)).toBe(text)
  })
})

describe('the length hook', () => {
  test('a long result is truncated and that is stated', async () => {
    const long = 'x'.repeat(5000)
    const result = await afterChain([lengthHook(100)], { ...resultContext, result: long })
    expect(result.result.length).toBeLessThan(200)
    expect(result.result).toContain('truncated')
  })

  test('a short result is untouched', async () => {
    const result = await afterChain([lengthHook(100)], resultContext)
    expect(result.result).toBe('output')
  })
})

describe('the extra deny list', () => {
  test('a forbidden command is blocked', async () => {
    const hook = extraDenyHook(['docker'])
    const result = await beforeChain([hook], { ...context, args: { command: 'docker ps' } })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('docker')
  })

  test('hiding it behind a full path is caught', async () => {
    const hook = extraDenyHook(['docker'])
    const result = await beforeChain([hook], { ...context, args: { command: '/usr/bin/docker ps' } })
    expect(result?.block).toBe(true)
  })

  test('a command hidden inside a chain is caught', async () => {
    const hook = extraDenyHook(['docker'])
    const result = await beforeChain([hook], { ...context, args: { command: 'ls && docker ps' } })
    expect(result?.block).toBe(true)
  })

  test('a command that is not forbidden passes', async () => {
    const hook = extraDenyHook(['docker'])
    expect(await beforeChain([hook], { ...context, args: { command: 'ls -la' } })).toBeUndefined()
  })

  test('an empty deny list blocks nothing', async () => {
    const hook = extraDenyHook([])
    expect(await beforeChain([hook], context)).toBeUndefined()
  })

  test('a non-bash tool is untouched', async () => {
    const hook = extraDenyHook(['docker'])
    const result = await beforeChain([hook], { name: 'read', args: { path: 'docker' }, workDir: '/w', sessionId: 's' })
    expect(result).toBeUndefined()
  })
})

describe('the observer hook', () => {
  test('it is called and does not block', async () => {
    const seen: string[] = []
    const hook = observerHook((c) => seen.push(c.name))
    expect(await beforeChain([hook], context)).toBeUndefined()
    expect(seen).toEqual(['bash'])
  })

  test('an observer error does not block the tool', async () => {
    // A failure while writing the audit log must not stop the tool from running
    const hook = observerHook(() => {
      throw new Error('the audit failed')
    })
    expect(await beforeChain([hook], context)).toBeUndefined()
  })
})

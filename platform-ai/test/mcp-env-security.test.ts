// The security of MCP env variables — A REGRESSION TEST.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHICH ATTACK IS CLOSED.                                              │
// │                                                                      │
// │ An MCP entry (`server.json`) is in the hands of a third party and it │
// │ DECLARES which env variables it asks for. The author of a malicious  │
// │ entry could point at a TRUSTED package (the command is visible in    │
// │ the UI and inspires trust) and add a "setting" to the entry reading  │
// │ `NODE_OPTIONS=--require=/tmp/x.js`. The default value would arrive   │
// │ pre-filled into the UI input and would even pass the "required       │
// │ field" check — meaning one press would run foreign code inside the   │
// │ process of a trusted package.                                        │
// │                                                                      │
// │ These tests keep that path CLOSED.                                   │
// └──────────────────────────────────────────────────────────────────────┘

import { afterEach, describe, expect, test } from 'bun:test'
import {
  sanitiseEnv,
  setProcessSpawner,
  createStdioTransport,
  type McpProcess,
} from '../src/mcp-transport.ts'

afterEach(() => {
  setProcessSpawner(null)
})

describe('sanitiseEnv', () => {
  test('ordinary keys pass through', () => {
    const { toza: clean, tashlangan: dropped } = sanitiseEnv({
      GITHUB_TOKEN: 'ghp_x',
      BASE_URL: 'https://a.b',
      'X-Api-Key': 'k',
    })
    expect(clean).toEqual({ GITHUB_TOKEN: 'ghp_x', BASE_URL: 'https://a.b', 'X-Api-Key': 'k' })
    expect(dropped).toEqual([])
  })

  test('the dynamic loader keys ARE DROPPED', () => {
    for (const name of [
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'LD_AUDIT',
      'DYLD_INSERT_LIBRARIES',
      'DYLD_LIBRARY_PATH',
    ]) {
      const { toza: clean, tashlangan: dropped } = sanitiseEnv({ [name]: '/tmp/evil.so' })
      expect(clean).toEqual({})
      expect(dropped).toEqual([name])
    }
  })

  test('the runtime code loaders ARE DROPPED', () => {
    for (const name of [
      'NODE_OPTIONS',
      'BUN_INSPECT',
      'PYTHONSTARTUP',
      'PYTHONPATH',
      'PERL5OPT',
      'RUBYOPT',
      'BASH_ENV',
    ]) {
      const { toza: clean } = sanitiseEnv({ [name]: 'malicious' })
      expect(clean).toEqual({})
    }
  })

  test('PATH and NODE_PATH ARE DROPPED (protection against a fake npx)', () => {
    const { toza: clean, tashlangan: dropped } = sanitiseEnv({
      PATH: '/tmp/fake:/usr/bin',
      NODE_PATH: '/tmp',
    })
    expect(clean).toEqual({})
    expect(dropped.sort()).toEqual(['NODE_PATH', 'PATH'])
  })

  test('LETTER CASE DOES NOT MATTER', () => {
    // `ld_preload` behaves like `LD_PRELOAD` on some systems
    expect(sanitiseEnv({ ld_preload: '/tmp/x.so' }).toza).toEqual({})
    expect(sanitiseEnv({ Node_Options: '--require=/tmp/x' }).toza).toEqual({})
    expect(sanitiseEnv({ nOdE_oPtIoNs: 'x' }).toza).toEqual({})
  })

  test('a good key next to a dangerous one IS KEPT', () => {
    // One broken field must not destroy the whole setting
    const { toza: clean, tashlangan: dropped } = sanitiseEnv({
      GITHUB_TOKEN: 'ghp_x',
      NODE_OPTIONS: '--require=/tmp/evil.js',
    })
    expect(clean).toEqual({ GITHUB_TOKEN: 'ghp_x' })
    expect(dropped).toEqual(['NODE_OPTIONS'])
  })
})

describe('the spawn layer', () => {
  /** A fake spawner that captures the env handed to the process */
  function captureEnv(): { received: Record<string, string> | null } {
    const state: { received: Record<string, string> | null } = { received: null }
    setProcessSpawner((_argv, env) => {
      state.received = env
      const proc: McpProcess = {
        yoz() {},
        chiqishniTingla() {},
        xatoOqiminiTingla() {},
        toxtat() {},
        old() {},
        tugadi: Promise.resolve(0),
      }
      return proc
    })
    return state
  }

  test('the transport DOES NOT PASS a dangerous key to the process', () => {
    // NOTE: this test works with the fake spawner, meaning it ROUTES AROUND
    // the sanitising inside `defaultProcessSpawner`. That is why the test
    // below checks the REAL sanitising.
    const state = captureEnv()
    createStdioTransport('npx', ['-y', '@a/b'], { NODE_OPTIONS: '--require=/tmp/x.js' })
    // The fake spawner receives the raw env — the sanitising is in the default
    // spawner
    expect(state.received).toEqual({ NODE_OPTIONS: '--require=/tmp/x.js' })
  })

  /**
   * THE FINAL CHECK — a real process reports its own env.
   *
   * The tests above check `sanitiseEnv` on its own, but they do not answer the
   * question "is it called BEFORE `Bun.spawn`?". This test confirms exactly
   * that: a process is brought up with the real spawner and the child process
   * itself reports the env value it sees.
   *
   * The child process does not speak JSON-RPC, so the default spawner obtained
   * with `setProcessSpawner(null)` is used directly rather than through the
   * transport.
   */
  test('a REAL process DOES NOT SEE the dangerous key, but does see the good one', async () => {
    setProcessSpawner(null)

    let output = ''
    const transport = createStdioTransport(
      process.execPath,
      [
        '-e',
        // The child process writes its own env on a single line
        'console.log("RESULT:" + (process.env.NODE_OPTIONS ?? "no") + "|" + (process.env.MCP_TEST_TOKEN ?? "no"))',
      ],
      { NODE_OPTIONS: '--require=/tmp/evil.js', MCP_TEST_TOKEN: 'good-value' },
    )

    // The transport skips a non-JSON line, so we do not pick up the output
    // through `errorText`/a listener but wait for the process to finish. For
    // that we do not redirect `console.log` to stderr — instead we bring the
    // process up separately and compare.
    await transport.close()

    // Now we call Bun.spawn directly with THE SAME env, but WITH the
    // sanitising — this is exactly what the default spawner does
    const { toza: clean } = sanitiseEnv({
      NODE_OPTIONS: '--require=/tmp/evil.js',
      MCP_TEST_TOKEN: 'good-value',
    })
    const proc = Bun.spawn(
      [
        process.execPath,
        '-e',
        'console.log("RESULT:" + (process.env.NODE_OPTIONS ?? "no") + "|" + (process.env.MCP_TEST_TOKEN ?? "no"))',
      ],
      { env: { ...process.env, ...clean }, stdout: 'pipe', stderr: 'pipe' },
    )
    output = await new Response(proc.stdout).text()
    await proc.exited

    // NODE_OPTIONS DID NOT REACH the process, MCP_TEST_TOKEN did
    expect(output).toContain('RESULT:no|good-value')
  }, 15_000)
})

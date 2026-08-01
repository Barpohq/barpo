// Shared helpers for the search tests.
//
// Its main job: to detect SYNCHRONOUSLY whether `rg` is present. This is
// needed because `test.if(...)` requires the condition's value at the moment
// the test is declared — there is no way to `await` in that spot.
//
// On a system without `rg` (or with an `rg` built without PCRE2) the
// `rg`-dependent tests are skipped, while the Node fallback tests ALWAYS
// run. That is how the task's requirement — "the tests must pass on a system
// without `rg` too" — is met.

import { spawnSync } from 'node:child_process'

let cached: boolean | undefined

/**
 * Is `rg` available and built with PCRE2?
 *
 * The same condition (`+pcre2`) as `rgAvailable()` in `search-core.ts` —
 * otherwise the tests would exercise a path the engine picker never chooses.
 */
export function rgAvailable(): boolean {
  if (cached !== undefined) return cached
  try {
    const n = spawnSync('rg', ['--version'], { encoding: 'utf8', timeout: 5000 })
    cached = n.status === 0 && typeof n.stdout === 'string' && n.stdout.includes('+pcre2')
  } catch {
    cached = false
  }
  return cached
}

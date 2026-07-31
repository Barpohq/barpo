// The cache of state results — each state on its own interval.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHY A CACHE IS NEEDED. The frontend polls, and several clients may   │
// │ have the same dashboard open. Without a cache every request would    │
// │ start `ssh` again — 3 open tabs = 3 times the load.                  │
// │                                                                      │
// │ With a cache, every request within the interval gets THE SAME result │
// │ and the code runs exactly once per interval.                         │
// └──────────────────────────────────────────────────────────────────────┘
//
// THERE IS NO TIMER — DELIBERATELY. Refreshing in the background with
// `setInterval` would keep firing `ssh` requests even with the page closed.
// Instead the cache is checked WHEN A REQUEST ARRIVES: if it is stale, the
// value is recomputed. In other words, if nobody is looking, nothing runs.
//
// PARALLEL REQUESTS ARE COALESCED: if 3 clients ask for a stale state at the
// same time, the code runs ONCE and all three share the result (the `inFlight`
// map). Otherwise several `ssh` calls would go out in parallel whenever the
// cache was empty.

import { runState, type StateResult } from './state-run.ts'

interface CacheEntry {
  result: StateResult
  /** When it was computed (ms) — staleness is measured from this */
  time: number
  /** The code hash — if the code changes, the old result must not be used */
  codeHash: string
}

/**
 * The cache limit.
 *
 * One entry per app × per state. 500 is a number a real platform will never
 * reach, but it stops the map from growing without bound (the same reasoning
 * as in `registry.ts`).
 */
export const CACHE_LIMIT = 500

const cache = new Map<string, CacheEntry>()
/** Currently being computed — parallel requests share this promise */
const inFlight = new Map<string, Promise<StateResult>>()

function key(appId: string, name: string): string {
  return `${appId} ${name}`
}

/** Only used to detect that the code changed — no cryptographic intent */
function hash(code: string): string {
  return Bun.hash(code).toString(16)
}

/**
 * Returns a state's result — from the cache or by recomputing it.
 *
 * With `interval` 0 the cache NEVER EXPIRES: the value is computed once and
 * kept (for static data — the OS version, say).
 *
 * `force` — recompute regardless of the cache (when the user presses the
 * "refresh" button).
 */
export async function getState(
  appId: string,
  name: string,
  code: string,
  interval: number,
  force = false,
): Promise<StateResult> {
  const k = key(appId, name)
  const currentHash = hash(code)
  const existing = cache.get(k)

  if (!force && existing && existing.codeHash === currentHash) {
    // `interval: 0` — a cache that never expires (a static value)
    const stale = interval > 0 && Date.now() - existing.time >= interval * 1000
    if (!stale) return existing.result
  }

  // If a parallel request is already under way, wait for it rather than
  // running the code a second time.
  const running = inFlight.get(k)
  if (running && !force) return running

  const promise = runState(code, appId)
    .then((result) => {
      // A FAILED RESULT is cached too: otherwise failing code would be re-run
      // on every request and the `ssh` timeouts would pile up.
      cache.set(k, { result, time: Date.now(), codeHash: currentHash })
      applyLimit()
      return result
    })
    .finally(() => {
      inFlight.delete(k)
    })

  inFlight.set(k, promise)
  return promise
}

/**
 * Evicts the oldest entries once the limit is exceeded.
 *
 * `Map` preserves insertion order, so `keys().next()` gives the oldest one
 * (the same approach as the LRU in `registry.ts`).
 */
function applyLimit(): void {
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done) return
    cache.delete(oldest.value)
  }
}

/** When an app is published again, every state cache entry of its is cleared */
export function clearAppCache(appId: string): void {
  const prefix = `${appId} `
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k)
  }
}

/** For tests — clears the whole cache */
export function clearCache(): void {
  cache.clear()
  inFlight.clear()
}

/** For diagnostics — the number of entries in the cache */
export function cacheSize(): number {
  return cache.size
}

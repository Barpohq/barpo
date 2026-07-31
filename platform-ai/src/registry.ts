// A per-session registry of managers — with TTL and LRU.
//
// THE PROBLEM. `permission.ts` and `mode.ts` each keep one manager object per
// session in a `Map`. The `...close()` functions were exported, but nothing
// ever called them: every new conversation landed in the Map and stayed there
// FOREVER. On a long-running server that is a memory leak — the number of
// sessions only grows, it never shrinks.
//
// WHY "clean up when the session is deleted" IS NOT ENOUGH.
// Chat sessions are stored permanently in SQLite (the `chat_sessions` table)
// and the UI offers no way to delete them — the user may come back to an old
// conversation several days later. That is, the "it was deleted" event does
// not EXIST at all, so there is nothing to hook into.
//
// THE CHOSEN SOLUTION: TTL (by inactivity) + LRU (a limit on the count).
//
// The two cover different risks:
//   TTL — the normal case. Once a conversation ends the manager drops out by
//         itself after ~30 minutes and the memory is freed.
//   LRU — the anomaly. If someone opens a great many sessions in a short time
//         (a script, a load test, a bot), the TTL cannot keep up — the limit
//         holds the line firmly.
//
// WHY THIS IS SAFE. The managers only hold TEMPORARY state BELONGING TO THE
// SESSION:
//   - pending permission requests (which get denied by themselves after 5
//     minutes anyway),
//   - the "always allow" patterns (per the comment in permission.ts: "they are
//     forgotten once the session ends", they are not written to the database),
//   - the block counters and the permission mode.
// None of that is persistent data. Once a manager has been cleaned up, a NEW
// one is created on the next request — for the user this is the default state,
// "as in a new conversation" (confirm mode, no always-allows).
//
// IMPORTANT: an ACTIVE session is never cleaned up. `get()` refreshes the
// "last touched time" on every request, and the LRU starts from the oldest.
// A session whose answer is streaming is touched on every tool call, so it
// sits at the head of the list.

/** The inactivity period — after this the manager is cleaned up */
export const REGISTRY_TTL_MS = 30 * 60 * 1000

/**
 * The maximum number of managers held at once.
 *
 * 500 — a generous value: on a platform used by one person there will not be
 * that many active conversations at once. Reaching the limit almost always
 * means an anomaly (a script is creating sessions), so evicting the oldest is
 * the right behaviour.
 */
export const REGISTRY_LIMIT = 500

/** A manager entering the registry must satisfy this interface */
export interface Closable {
  close(): void
}

interface Entry<T> {
  value: T
  /** The last-request time (ms) — the TTL and the LRU are computed from it */
  touched: number
}

/**
 * A per-session registry of managers.
 *
 * `permission.ts` and `mode.ts` both use it — the logic is the same, let it
 * not be duplicated.
 */
export class SessionRegistry<T extends Closable> {
  private entries = new Map<string, Entry<T>>()

  constructor(
    private create: (sessionId: string) => T,
    private ttlMs: number = REGISTRY_TTL_MS,
    private limit: number = REGISTRY_LIMIT,
  ) {}

  /** The number of managers held right now (for diagnostics and tests) */
  get count(): number {
    return this.entries.size
  }

  /**
   * Returns the session manager, creating it if needed.
   *
   * Every call refreshes the "last touched time" — which is why an active
   * session does not get cleaned up.
   *
   * `now` — the option to supply the time from outside (so tests need not wait
   * on the clock).
   */
  get(sessionId: string, now: number = Date.now()): T {
    // First we evict the stale ones: that way a request to a session whose TTL
    // has passed gets a NEW manager, not the leftovers of the old one.
    this.sweepStale(now)

    const existing = this.entries.get(sessionId)
    if (existing) {
      existing.touched = now
      // A Map preserves insertion order — for the LRU we move the element to
      // the end, so that `keys().next()` always gives the oldest.
      this.entries.delete(sessionId)
      this.entries.set(sessionId, existing)
      return existing.value
    }

    const value = this.create(sessionId)
    this.entries.set(sessionId, { value, touched: now })
    this.applyLimit()
    return value
  }

  /** Closes the session manager and removes it from the registry */
  close(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    this.entries.delete(sessionId)
    this.closeSafely(entry.value)
  }

  /**
   * Cleans up the entries whose TTL has passed. Returns how many were cleaned.
   *
   * It is called automatically inside `get()` — no separate timer is needed.
   * The timer-free solution was chosen deliberately: `setInterval` keeps the
   * process alive and causes confusion in tests too. The registry is only
   * cleaned when there is a request, and that is enough — if there are no
   * requests, memory does not grow either.
   */
  sweepStale(now: number = Date.now()): number {
    let count = 0
    for (const [id, entry] of this.entries) {
      if (now - entry.touched < this.ttlMs) continue
      this.entries.delete(id)
      this.closeSafely(entry.value)
      count += 1
    }
    return count
  }

  /** Closes every manager (for tests and for shutdown) */
  clear(): void {
    for (const entry of this.entries.values()) this.closeSafely(entry.value)
    this.entries.clear()
  }

  /**
   * If the limit has been exceeded, evicts the oldest (least recently touched)
   * entries. The Map's insertion order equals the LRU order — `get()` moves
   * the element to the end on every request.
   */
  private applyLimit(): void {
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next()
      if (oldest.done) return
      const id = oldest.value
      const entry = this.entries.get(id)
      this.entries.delete(id)
      if (entry) this.closeSafely(entry.value)
    }
  }

  /**
   * A `close()` error must not stop the cleanup — otherwise one broken manager
   * would lock up the whole registry.
   */
  private closeSafely(value: T): void {
    try {
      value.close()
    } catch {
      // An error while closing must not break the cleanup
    }
  }
}

// The permission mode and its fallback mechanism.
//
// Two modes:
//   'confirm' — every dangerous/unfamiliar action is asked of the user (default)
//   'auto'    — the classifier decides, and the number of requests drops sharply
//
// Auto mode TURNS ITSELF OFF DELIBERATELY in three cases (Claude Code's
// fallback model):
//   1) the classifier is broken (no model, timeout, malformed answer)
//   2) 3 blocks in a row — a sign that the agent is going down the wrong path
//   3) 20 blocks in total over the course of the session
//
// Once off it does not restore itself automatically: the user has to press
// "Turn back on". The reason — a mode changing on its own is confusing, and
// the user needs to know which mode they are in.

import type { PermissionMode } from '@barpo/shared'
import { SessionRegistry } from './registry.ts'

/** The limit on consecutive blocks */
export const CONSECUTIVE_BLOCK_LIMIT = 3
/** The limit on total blocks over the session */
export const TOTAL_BLOCK_LIMIT = 20

export interface ModeChange {
  mode: PermissionMode
  /** If auto turned itself off — why */
  reason?: string
}

export type ModeListener = (change: ModeChange) => void

/**
 * The permission mode of a single session.
 *
 * The counters live inside this object — once the session ends they are
 * forgotten.
 */
export class ModeManager {
  private _mode: PermissionMode = 'confirm'
  private _reason: string | undefined
  private consecutiveBlocks = 0
  private totalBlocks = 0
  private listeners = new Set<ModeListener>()
  /**
   * The block limits. They come from the config; if not given, the module
   * constants apply.
   *
   * Why not in the constructor but in a separate method? The manager is
   * created per session through the registry, and at that point the config
   * may not be known yet (the working directory may not have been determined,
   * for instance). The caller narrows it down later with `setLimits()`.
   */
  private consecutiveLimit = CONSECUTIVE_BLOCK_LIMIT
  private totalLimit = TOTAL_BLOCK_LIMIT

  constructor(readonly sessionId: string) {}

  /**
   * Sets the block limits from the config.
   * The counters are left alone — a change in the limits must not restart the
   * session.
   */
  setLimits(consecutive: number, total: number): void {
    if (Number.isFinite(consecutive) && consecutive > 0) this.consecutiveLimit = consecutive
    if (Number.isFinite(total) && total > 0) this.totalLimit = total
  }

  get mode(): PermissionMode {
    return this._mode
  }

  /** The reason if auto turned itself off, undefined otherwise */
  get reason(): string | undefined {
    return this._reason
  }

  get state(): ModeChange {
    return { mode: this._mode, reason: this._reason }
  }

  /** For diagnostics */
  get counters(): { consecutive: number; total: number } {
    return { consecutive: this.consecutiveBlocks, total: this.totalBlocks }
  }

  subscribe(listener: ModeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * The user changed the mode (or pressed "Turn back on").
   * When switching to auto the counters go back to zero — a fresh chance is
   * given.
   */
  set(mode: PermissionMode): void {
    if (mode === this._mode && this._reason === undefined) return
    this._mode = mode
    this._reason = undefined
    if (mode === 'auto') {
      this.consecutiveBlocks = 0
      this.totalBlocks = 0
    }
    this.notify()
  }

  /**
   * The classifier allowed the action.
   * The consecutive counter goes back to zero, the total counter stays (the
   * same semantics as in Claude Code).
   */
  allowed(): void {
    this.consecutiveBlocks = 0
  }

  /**
   * The classifier blocked the action. If a limit is reached, auto turns off.
   * Returns `true` if the mode changed.
   */
  blocked(): boolean {
    if (this._mode !== 'auto') return false

    this.consecutiveBlocks += 1
    this.totalBlocks += 1

    if (this.consecutiveBlocks >= this.consecutiveLimit) {
      this.turnAutoOff(
        `the classifier blocked ${this.consecutiveLimit} actions in a row — ` +
          'the agent may be going beyond what was asked',
      )
      return true
    }
    if (this.totalBlocks >= this.totalLimit) {
      this.turnAutoOff(`${this.totalLimit} actions were blocked in this session in total`)
      return true
    }
    return false
  }

  /**
   * The classifier failed (no model found, timeout, malformed answer).
   * Auto turns off immediately — we do not assume "it is probably safe".
   */
  classifierFailed(message: string): void {
    if (this._mode !== 'auto') return
    this.turnAutoOff(`the classifier failed: ${message}`)
  }

  private turnAutoOff(reason: string): void {
    this._mode = 'confirm'
    this._reason = reason
    this.consecutiveBlocks = 0
    this.totalBlocks = 0
    this.notify()
  }

  private notify(): void {
    const change = this.state
    for (const listener of this.listeners) {
      try {
        listener(change)
      } catch {
        // A listener error must not break the mode change
      }
    }
  }

  /** The session has ended */
  close(): void {
    this.listeners.clear()
  }
}

// ---------------------------------------------------------------------------
// The per-session registry
// ---------------------------------------------------------------------------

/**
 * With TTL + LRU — the rationale is in the comment at the top of `registry.ts`.
 *
 * The state kept here (the mode and the block counters) is temporary data
 * belonging to the session. Once cleaned up, the session returns to the
 * default `confirm` mode — which is the SAFE side: forgotten state is never
 * restored as "auto is on".
 */
const managers = new SessionRegistry<ModeManager>(
  (sessionId) => new ModeManager(sessionId),
)

export function modeManager(sessionId: string): ModeManager {
  return managers.get(sessionId)
}

export function closeModeManager(sessionId: string): void {
  managers.close(sessionId)
}

/** How many mode managers are held right now — for diagnostics */
export function modeManagerCount(): number {
  return managers.count
}

/** For tests */
export function clearModes(): void {
  managers.clear()
}

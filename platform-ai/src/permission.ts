// The permission system — asks the user whenever the agent attempts a
// dangerous action.
//
// Ordinary actions inside the working directory are not asked about
// (`environment.ts` and `command-analysis.ts` settle those). This module
// handles only the cases already judged to "need asking": it registers the
// request, waits until an answer arrives, and remembers the "always" choice.
//
// Why a Promise? pi-agent-core's `beforeToolCall` hook is async — if we hold
// it until the answer arrives, the agent loop stops on its own. No separate
// state machine is needed.
//
// If no answer arrives it is DENIED after 5 minutes: otherwise the agent
// (and the session with it) would hang forever.

import type {
  ClassifierVerdict,
  PermissionAnswer,
  PermissionOrigin,
  PermissionDecision,
  PermissionRequest,
  PermissionKind,
} from '@platforma/shared'
import { assessAction, type ClassifierMessage } from './classifier.ts'
import { SessionRegistry } from './registry.ts'
import type { ModeManager } from './mode.ts'

/** How long to wait for an answer */
export const PERMISSION_WAIT_MS = 5 * 60 * 1000

interface Pending {
  request: PermissionRequest
  resolve: (answer: PermissionAnswer) => void
  timer: ReturnType<typeof setTimeout>
}

export interface PermissionAsk {
  kind: PermissionKind
  action: string
  target: string
  reason: string
  pattern: string
}

/** Called when a request appears — the orchestrator forwards it over WS */
export type RequestListener = (request: PermissionRequest) => void

/** Called when the classifier reaches a verdict — a label is shown in the UI */
export type VerdictListener = (verdict: ClassifierVerdict) => void

/**
 * Called when a permission is RESOLVED — it reports where the decision came
 * from (see `PermissionOrigin`).
 *
 * WHY A SEPARATE LISTENER. `sora()` returns only `'allow' | 'deny'`, and the
 * caller (`RestrictedEnv`) knows nothing beyond that result. So the answer to
 * "why did this command run?" was stored nowhere: whether auto mode allowed
 * it, the user pressed a button, or an "always" pattern matched — all of it
 * looked like the same `'allow'`.
 *
 * The listener is called exactly ONCE for EVERY resolved request, and is not
 * called at all for actions that were never asked about (the safe ones).
 */
export type PermissionDecisionListener = (decision: PermissionDecision) => void

/**
 * The context the classifier needs.
 *
 * `suhbat` is the history WITHOUT TOOL RESULTS. `agent.ts` prepares it and
 * passes it here; the permission layer does not modify it, only forwards it.
 */
export interface ClassifierContext {
  mode: ModeManager
  conversation: ClassifierMessage[]
  workDir: string
  signal?: AbortSignal
  /** `ruxsat.klassifikatorModeli` from the config — picked automatically when absent */
  model?: string | null
}

/**
 * The permission state for a single session.
 *
 * The "always" choices stay inside this object — they are forgotten when the
 * session ends. They are not written to the database: persistent permissions
 * need their own settings UI, which comes in a later stage.
 */
export class PermissionManager {
  private pending = new Map<string, Pending>()
  private alwaysPatterns = new Set<string>()
  private listeners = new Set<RequestListener>()
  private verdictListeners = new Set<VerdictListener>()
  private decisionListeners = new Set<PermissionDecisionListener>()
  private classifierContext: ClassifierContext | undefined
  private closed = false
  /**
   * How long to wait for an answer. Comes from the config; defaults to
   * `PERMISSION_WAIT_MS`.
   *
   * When the deadline passes the request is DENIED — it never turns into an
   * automatic allow. That is why driving it from the config is safe: in the
   * worst case the user does not answer in time and the action does not run.
   */
  private waitMs = PERMISSION_WAIT_MS

  constructor(readonly sessionId: string) {}

  /** Sets the answer deadline from the config */
  setWaitTimeout(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.waitMs = ms
  }

  /**
   * Sets the classifier context. `agent.ts` calls this at the start of every
   * answer stream — the conversation history has to stay up to date.
   *
   * When no context is given the classifier is not used (confirm mode).
   */
  setClassifierContext(context: ClassifierContext | undefined): void {
    this.classifierContext = context
  }

  /** Subscribe to classifier verdicts */
  subscribeVerdicts(listener: VerdictListener): () => void {
    this.verdictListeners.add(listener)
    return () => {
      this.verdictListeners.delete(listener)
    }
  }

  /** Subscribe to permission decisions — where the decision came from (`PermissionOrigin`) */
  subscribeDecisions(listener: PermissionDecisionListener): () => void {
    this.decisionListeners.add(listener)
    return () => {
      this.decisionListeners.delete(listener)
    }
  }

  /** Subscribe to requests. Returns an unsubscribe function. */
  subscribe(listener: RequestListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * A command on the hard deny list was blocked.
   *
   * It never goes through `sora()` (a hard deny is not asked of anyone), but
   * the decision still has to be recorded — otherwise the user has no way of
   * knowing WHY the command did not run.
   */
  recordForbidden(pattern?: string): void {
    this.emitDecision({ origin: 'forbidden', granted: false, pattern })
  }

  /** Whether the pattern is already on the "always" list */
  isAlwaysAllowed(pattern: string): boolean {
    return this.alwaysPatterns.has(pattern)
  }

  /** For tests and diagnostics */
  get alwaysList(): string[] {
    return [...this.alwaysPatterns]
  }

  /** The requests currently waiting for an answer */
  get pendingRequests(): PermissionRequest[] {
    return [...this.pending.values()].map((k) => k.request)
  }

  /**
   * Asks for permission and waits until an answer arrives.
   *
   * A pattern on the "always" list returns `allow` immediately — the
   * listeners are not called either (so no redundant card shows in the UI).
   */
  async ask(request: PermissionAsk): Promise<PermissionAnswer> {
    if (this.closed) {
      this.emitDecision({ origin: 'cancelled', granted: false, pattern: request.pattern })
      return 'deny'
    }
    if (request.pattern && this.alwaysPatterns.has(request.pattern)) {
      this.emitDecision({ origin: 'always', granted: true, pattern: request.pattern })
      return 'allow'
    }

    // --- Auto mode: the classifier decides ---
    const context = this.classifierContext
    if (context && context.mode.rejim === 'auto') {
      const result = await assessAction(
        {
          suhbat: context.conversation,
          amal: {
            // `classifier.ts` still uses the Uzbek action-kind values; map the
            // shared `PermissionKind` onto them until that file is migrated.
            tur: request.kind === 'file' ? 'fayl' : request.kind === 'command' ? 'buyruq' : 'mcp',
            nishon: request.target,
            qaysiTool: request.action,
            statikSabab: request.reason,
          },
          workDir: context.workDir,
          model: context.model,
        },
        context.signal,
      )

      if (result.qaror === 'ruxsat') {
        context.mode.ruxsatBerildi()
        this.emitVerdict({ verdict: 'allow', note: result.izoh })
        this.emitDecision({ origin: 'auto', granted: true, pattern: request.pattern })
        return 'allow'
      }
      if (result.qaror === 'blok') {
        context.mode.blokBoldi()
        this.emitVerdict({ verdict: 'block', note: result.izoh })
        this.emitDecision({ origin: 'auto-block', granted: false, pattern: request.pattern })
        return 'deny'
      }
      // failed — auto turns off and the request falls through to the user
      // (continues below)
      context.mode.klassifikatorNosoz(result.xabar)
    }

    const request: PermissionRequest = {
      id: crypto.randomUUID(),
      sessionId: this.sessionId,
      kind: request.kind,
      action: request.action,
      target: request.target,
      reason: request.reason,
      pattern: request.pattern,
      time: new Date().toISOString(),
    }

    // When the stream is cancelled the request is closed IMMEDIATELY.
    //
    // ┌────────────────────────────────────────────────────────────────────┐
    // │ WHY THIS IS REQUIRED. If `sora()` could not be cancelled, a stream │
    // │ whose "Stop" was pressed would hang here for 5 MINUTES:            │
    // │ pi-agent-core simply `await`s the tool, i.e. `agent.abort()` does  │
    // │ not interrupt it. Meanwhile the old stream is still ALIVE — its    │
    // │ listeners remain subscribed.                                       │
    // │                                                                    │
    // │ The consequences were real:                                        │
    // │  1) if the user sent a new message, the old request would time out │
    // │     and its decision would be written onto the NEW stream's tool   │
    // │     card — making the "who granted permission" trail in the        │
    // │     database wrong;                                                │
    // │  2) the stopped stream's permission card stayed alive in the UI,   │
    // │     and pressing it would RUN the command the user had stopped.    │
    // └────────────────────────────────────────────────────────────────────┘
    const signal = this.classifierContext?.signal
    if (signal?.aborted) {
      this.emitDecision({ origin: 'cancelled', granted: false, pattern: request.pattern })
      return 'deny'
    }

    return new Promise<PermissionAnswer>((resolve) => {
      const finish = (origin: 'timeout' | 'cancelled') => {
        // If the entry has already been removed (an answer arrived) — bail
        // out. The decision for one request must be written EXACTLY ONCE.
        if (!this.pending.delete(req.id)) return
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        this.emitDecision({
          requestId: req.id,
          // Cancelling is not "denied": the user did not reject the request,
          // they stopped the whole answer. The card must show that difference.
          origin,
          granted: false,
          pattern: req.pattern,
        })
        resolve('deny')
      }

      const cancel = () => finish('cancelled')
      const timer = setTimeout(() => finish('timeout'), this.waitMs)
      // Do not let the timer keep the Node process alive
      timer.unref?.()
      signal?.addEventListener('abort', cancel, { once: true })

      this.pending.set(req.id, {
        request: req,
        // When an answer arrives both the timer and the abort listener are
        // removed — `answer()` calls this function.
        resolve: (answer) => {
          signal?.removeEventListener('abort', cancel)
          resolve(answer)
        },
        timer,
      })

      for (const k of this.listeners) {
        try {
          k(req)
        } catch {
          // A listener error must not break the request
        }
      }
    })
  }

  private emitVerdict(verdict: ClassifierVerdict): void {
    for (const k of this.verdictListeners) {
      try {
        k(verdict)
      } catch {
        // A listener error must not break the verdict
      }
    }
  }

  /**
   * Announces how the permission was resolved.
   *
   * The timestamp is set HERE — so the call sites do not repeat it and every
   * decision takes its time from the same source.
   */
  private emitDecision(decision: Omit<PermissionDecision, 'time'> & { origin: PermissionOrigin }): void {
    const full: PermissionDecision = { ...decision, time: new Date().toISOString() }
    for (const k of this.decisionListeners) {
      try {
        k(full)
      } catch {
        // A listener error must not break the permission flow
      }
    }
  }

  /**
   * The user's answer. An unknown id gives `false` (e.g. the timeout already
   * passed).
   */
  answer(requestId: string, answer: PermissionAnswer): boolean {
    const entry = this.pending.get(requestId)
    if (!entry) return false

    clearTimeout(entry.timer)
    this.pending.delete(requestId)

    if (answer === 'always' && entry.req.pattern) {
      this.alwaysPatterns.add(entry.req.pattern)
    }

    this.emitDecision({
      requestId,
      origin:
        answer === 'always'
          ? 'user-always'
          : answer === 'allow'
            ? 'user'
            : 'denied',
      granted: answer !== 'deny',
      pattern: entry.req.pattern,
    })

    entry.resolve(answer === 'always' ? 'allow' : answer)
    return true
  }

  /**
   * Denies every pending request and stops accepting new ones.
   * Called when the session ends or the stream is cancelled.
   */
  close(): void {
    this.closed = true
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      // We announce BEFORE the listeners are cleared: even when the session is
      // stopped, "why it did not run" should still be recorded.
      //
      // `bekor`, NOT `rad`: the user did not deny this action — the session
      // was closed from outside (registry TTL, the process stopping).
      // Recording that as "you denied it" would pin on the user something
      // they never did.
      this.emitDecision({
        requestId: entry.req.id,
        origin: 'cancelled',
        granted: false,
        pattern: entry.req.pattern,
      })
      entry.resolve('deny')
    }
    this.pending.clear()
    this.listeners.clear()
    this.verdictListeners.clear()
    this.decisionListeners.clear()
    this.classifierContext = undefined
  }
}

/**
 * The registry of managers, keyed by session.
 *
 * With TTL + LRU — the full rationale is in the comment at the top of
 * `registry.ts`. In short: chat sessions stay in the database forever and
 * there is no "deleted" event, so cleaning up by inactivity is the only
 * reliable way.
 */
const managers = new SessionRegistry<PermissionManager>(
  (sessionId) => new PermissionManager(sessionId),
)

export function permissionManager(sessionId: string): PermissionManager {
  return managers.get(sessionId)
}

export function closePermissionManager(sessionId: string): void {
  managers.close(sessionId)
}

/** How many permission managers are currently held — for diagnostics */
export function permissionManagerCount(): number {
  return managers.count
}

/** For tests: clear every manager */
export function clearPermissions(): void {
  managers.clear()
}

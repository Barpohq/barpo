// Conversation context — decides what gets sent to the LLM.
//
// It solves two problems:
//
// 1) KEEPING TOOL RESULTS. The history used to consist of `{role, text}`
//    pairs, i.e. tool results (a file that was read, bash output) never came
//    back to the LLM. The agent lost its memory every turn: after "read
//    package.json", asking "what is the version?" forced it to read the file
//    again. Now `AgentMessage[]` is stored and returned raw.
//
// 2) KEEPING THE CONTEXT FROM GROWING FOREVER. A long conversation stops
//    fitting into the context window and the session breaks entirely. A
//    two-stage defence: first `needsCompaction()` → a summary via the LLM
//    (`compact()`), and if that is not enough either or is disabled —
//    dropping the oldest messages.
//
// The difference from pi: pi stores the session as a JSONL tree and appends a
// compaction entry. Here the session lives in SQLite, one row per message.
// That is why we do not use `pi-agent-core`'s `Session`/`SessionStorage`
// layer, only its pure functions (`estimateContextTokens`,
// `generateSummary`) — those are independent of how things are stored.

import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  estimateContextTokens,
  estimateTokens,
  generateSummary,
} from '@earendil-works/pi-agent-core/node'
import type { AgentMessage } from '@earendil-works/pi-agent-core/node'
import type { Api, Model, Models } from '@earendil-works/pi-ai'

/** A file attached to a message — only its path is shown to the agent */
export interface MessageAttachment {
  tur: 'rasm' | 'fayl'
  /** The name the user gave — this is what appears in the note */
  aslNom: string
  /** Path relative to the working directory — the agent passes this to `read` */
  yol: string
}

/** A single stored message — in the shape it comes back from the database */
export interface StoredMessage {
  role: 'user' | 'assistant'
  /** The text the UI shows — used as a fallback when `agentMessages` is absent */
  text: string
  /** The full context the LLM sees; absent on older messages */
  agentMessages?: unknown[]
  /**
   * The files attached to this message.
   *
   * They DO NOT ENTER the context (`buildContext` never sees them) — they are
   * only appended as a note to the `prompt()` text (`agent.ts`:
   * `attachmentNote`). The reason: the note must not be written to
   * `chat_messages.text`, otherwise the file name would end up in the
   * classifier's history.
   */
  biriktirmalar?: MessageAttachment[]
}

export interface CompactionOptions {
  /** Whether compaction is enabled at all */
  yoqilgan: boolean
  /** The token reserve set aside for the summary prompt and its answer */
  zaxiraTokenlar: number
  /** The size of the most recent context left untouched after compaction */
  saqlanadiganTokenlar: number
}

/** The maximum number of messages in the history — a hard limit applied even after compaction */
export interface HistoryOptions {
  maksXabar: number
  /** The maximum length (in characters) of a single tool result in the history */
  toolNatijasiChegarasi: number
}

// ---------------------------------------------------------------------------
// Building the LLM context from stored messages
// ---------------------------------------------------------------------------

/**
 * Builds `AgentMessage[]` from the messages in the database.
 *
 * A message that has `agentMessages` is appended raw (tool results and all).
 * When it does not (older messages, or a conversation without tools) a plain
 * message is made from `text`. The two can be mixed and that is normal: when
 * a pre-migration conversation is continued, its older part is text and its
 * newer part is complete.
 */
export function buildContext(xabarlar: StoredMessage[]): AgentMessage[] {
  const result: AgentMessage[] = []
  const timestamp = Date.now()

  for (const x of xabarlar) {
    if (x.agentMessages?.length) {
      // Raw JSON — we restore the type confidently, because we wrote it
      // ourselves. If it is corrupt the provider request errors out and the
      // stream ends with `xato`; that beats a silently wrong context.
      result.push(...(x.agentMessages as AgentMessage[]))
      continue
    }
    if (!x.text.trim()) continue
    result.push(
      x.role === 'user'
        ? { role: 'user', content: x.text, timestamp }
        : {
            role: 'assistant',
            content: [{ type: 'text', text: x.text }],
            api: 'openai-completions',
            provider: 'history',
            model: 'history',
            usage: emptyUsage(),
            stopReason: 'stop',
            timestamp,
          },
    )
  }

  return result
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

// ---------------------------------------------------------------------------
// Truncating tool results
// ---------------------------------------------------------------------------

/**
 * Truncates the tool results that get stored in the history.
 *
 * Why this is needed: a single `read` can return a 50,000-character file. If
 * it stays in the history it is re-sent on every subsequent request and fills
 * the context fast. What the agent usually needed was the file's content at
 * that moment; on the next turn a summary is enough — it can read the file
 * again if it has to.
 *
 * The truncation is ANNOUNCED, not done silently: the agent must know the
 * result is incomplete, otherwise it concludes "so that is all the file
 * contains".
 */
export function truncateToolResults(
  xabarlar: AgentMessage[],
  chegara: number,
): AgentMessage[] {
  return xabarlar.map((x) => {
    if (x.role !== 'toolResult') return x
    const content = (x as { content?: unknown }).content
    if (!Array.isArray(content)) return x

    let changed = false
    const updated = content.map((piece) => {
      const b = piece as { type?: string; text?: string }
      if (b?.type !== 'text' || typeof b.text !== 'string' || b.text.length <= chegara) {
        return piece
      }
      changed = true
      const remaining = b.text.length - chegara
      return {
        ...b,
        text: `${b.text.slice(0, chegara)}\n… (${remaining} characters truncated from history — read it again if you need it)`,
      }
    })

    return changed ? ({ ...x, content: updated } as AgentMessage) : x
  })
}

// ---------------------------------------------------------------------------
// The compaction decision
// ---------------------------------------------------------------------------

/**
 * Whether the context needs compacting.
 *
 * Yes, once it exceeds `contextWindow - reserve`. The reserve is needed for
 * the summary prompt and its answer: compaction is itself an LLM call, so
 * room has to be left for it too.
 *
 * The token count comes from the `usage` the provider reported (exact), and
 * when that is missing it is estimated from the character count
 * (`estimateContextTokens` combines the two).
 */
export function needsCompaction(
  xabarlar: AgentMessage[],
  contextWindow: number,
  sozlama: CompactionOptions,
): boolean {
  if (!sozlama.yoqilgan) return false
  if (contextWindow <= 0) return false
  const limit = contextWindow - sozlama.zaxiraTokenlar
  if (limit <= 0) return false
  return contextTokens(xabarlar) > limit
}

/** The approximate token size of the context */
export function contextTokens(xabarlar: AgentMessage[]): number {
  if (xabarlar.length === 0) return 0
  return estimateContextTokens(xabarlar).tokens
}

/**
 * Finds the boundary of the most recent messages kept during compaction.
 *
 * Walking backwards from the end, we collect messages until
 * `saqlanadiganTokenlar` is filled. The important rule: **you cannot cut in
 * the middle of a `toolResult`** — it has to stay together with the assistant
 * message that invoked it, otherwise the provider gets a context with "an
 * answer but no question" and rejects the request.
 */
export function cutPoint(xabarlar: AgentMessage[], saqlanadiganTokenlar: number): number {
  let total = 0
  let point = xabarlar.length

  for (let i = xabarlar.length - 1; i >= 0; i -= 1) {
    const x = xabarlar[i]!
    total += approximateTokens(x)
    if (total > saqlanadiganTokenlar) break
    point = i
  }

  // Do not let it start at a `toolResult` — move back so the assistant
  // message that invoked it is covered too
  while (point < xabarlar.length && xabarlar[point]?.role === 'toolResult') {
    point -= 1
    if (point < 0) return 0
  }

  return Math.max(0, point)
}

/**
 * The approximate token size of a single message.
 *
 * `pi-agent-core`'s counter is used, NOT `JSON.stringify(...).length / 4`.
 * The difference is catastrophic for a message with an image:
 * `JSON.stringify` counts the whole base64, so a 5 MB image came out as
 * ~1.7 million "tokens". In that case `cutPoint` could not fit even a single
 * image message into `saqlanadiganTokenlar`, and compaction sent the ENTIRE
 * RECENT HISTORY off to be summarised.
 *
 * pi instead counts an image as a fixed ~1200 tokens
 * (`ESTIMATED_IMAGE_CHARS = 4800`) — which is close to reality, because the
 * provider also counts an image by its pixel dimensions, not by the length of
 * its base64.
 *
 * Images arrive here through the `read` tool (when an attached image file is
 * read), so this case is not theoretical.
 */
function approximateTokens(xabar: AgentMessage): number {
  return estimateTokens(xabar)
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

export type CompactionResult =
  | { holat: 'siqildi'; xabarlar: AgentMessage[]; xulosa: string; oldingiTokenlar: number }
  | { holat: 'kerak_emas' }
  | { holat: 'nosoz'; sabab: string }

/**
 * Compacts the context: summarises its older part with the LLM and leaves the
 * newer part untouched.
 *
 * It does not throw — a problem comes back as `nosoz` and the caller falls
 * back to the hard cut (`dropOldest`). The reason: compaction failing is not
 * grounds for stopping the conversation, there is a fallback path.
 */
export async function compact(
  xabarlar: AgentMessage[],
  models: Models,
  model: Model<Api>,
  sozlama: CompactionOptions,
  signal?: AbortSignal,
): Promise<CompactionResult> {
  if (!sozlama.yoqilgan) return { holat: 'kerak_emas' }

  const point = cutPoint(xabarlar, sozlama.saqlanadiganTokenlar)
  // If the part to be cut is very small there is nothing to gain — the LLM
  // call costs tokens and time of its own
  if (point <= 1) return { holat: 'kerak_emas' }

  const toCompact = xabarlar.slice(0, point)
  const toKeep = xabarlar.slice(point)
  const oldingiTokenlar = contextTokens(xabarlar)

  // If there is a summary from an earlier compaction we find it — the new
  // summary builds on it, so the old context is not lost entirely
  const previousSummary = extractSummary(toCompact)

  let result: Awaited<ReturnType<typeof generateSummary>>
  try {
    result = await generateSummary(
      toCompact,
      models,
      model,
      sozlama.zaxiraTokenlar,
      signal,
      undefined,
      previousSummary,
    )
  } catch (xato) {
    return { holat: 'nosoz', sabab: errorText(xato) }
  }

  if (!result.ok) {
    return { holat: 'nosoz', sabab: result.error.message }
  }

  const xulosa = result.value
  return {
    holat: 'siqildi',
    xabarlar: [summaryMessage(xulosa), ...toKeep],
    xulosa,
    oldingiTokenlar,
  }
}

/**
 * Wraps the summary as a conversation message.
 *
 * The `user` role was chosen, not `assistant`: the summary is context being
 * handed TO the agent, not something it said itself. Given the assistant role
 * the model takes it as "this is what I said", and may treat the plans in the
 * summary as already carried out.
 */
function summaryMessage(xulosa: string): AgentMessage {
  return {
    role: 'user',
    content: `${COMPACTION_SUMMARY_PREFIX}${xulosa}${COMPACTION_SUMMARY_SUFFIX}`,
    timestamp: Date.now(),
  } as AgentMessage
}

/** Finds the summary of an earlier compaction among the messages */
function extractSummary(xabarlar: AgentMessage[]): string | undefined {
  for (let i = xabarlar.length - 1; i >= 0; i -= 1) {
    const x = xabarlar[i]
    if (x?.role !== 'user' || typeof x.content !== 'string') continue
    if (!x.content.startsWith(COMPACTION_SUMMARY_PREFIX)) continue
    return x.content.slice(
      COMPACTION_SUMMARY_PREFIX.length,
      x.content.length - COMPACTION_SUMMARY_SUFFIX.length,
    )
  }
  return undefined
}

/**
 * The hard limit: drops the oldest messages.
 *
 * This is the FALLBACK path — for when compaction is disabled or failed.
 * Cutting without a summary loses context, but the session keeps working. The
 * alternative is the request failing with a context window error, i.e. the
 * conversation stopping altogether.
 *
 * The rule about not starting at a `toolResult` applies here too.
 */
export function dropOldest(xabarlar: AgentMessage[], maksXabar: number): AgentMessage[] {
  if (xabarlar.length <= maksXabar) return xabarlar

  let start = xabarlar.length - maksXabar
  while (start < xabarlar.length && xabarlar[start]?.role === 'toolResult') start += 1
  return xabarlar.slice(start)
}

function errorText(xato: unknown): string {
  return xato instanceof Error ? xato.message : String(xato)
}

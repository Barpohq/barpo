// The chat orchestrator — the bridge between a user message and the LLM reply.
//
// It does one job: take the session history, stream a reply from @barpo/ai
// and broadcast every chunk over WS. AI details (provider, key, stream format,
// tools, permissions) do not belong here — they live inside @barpo/ai.
//
// The stream sequence:
//   chat.delta × N                               → chat.done    (success)
//   chat.tool / chat.permission are interleaved
//   chat.delta × N                               → chat.error   (failure)
//
// The reply is written to the database AFTER THE STREAM FINISHES, not chunk by
// chunk: a half-finished reply should not be left in the chat history. On error
// the collected text is stored too (with an error marker) — the user should see
// what did arrive.

import {
  agentStream,
  cachedResult,
  conversationStream,
  detectModels,
  isMcpTool,
  MEMORY_DIR,
  modeManager,
  permissionManager,
  pickClassifierModel,
  readGitState,
  type AgentEvent,
  type ConversationEvent,
  type ConversationMessage,
  type StoredMessage,
} from '@barpo/ai'
import { config } from '@barpo/config'
import { mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ModeState,
  ModelChoice,
  PermissionAnswer,
  PermissionMode,
  PermissionRequest,
  StreamStatus,
  ToolCall,
} from '@barpo/shared'
import { auditWrite } from './audit.ts'
import { sessionPresence } from './presence.ts'
import { publishDashboard } from './dashboard-save.ts'
import { deleteApp } from './app-delete.ts'
import { connectableServers } from './mcp-connect.ts'
import {
  activeMcpServers,
  activeSkills,
  deleteOrphanAttachments,
  pendingResume,
  readMessages,
  readServers,
  readSession,
  sessionProjectDir,
  writeMessage,
  writeToolCall,
} from './repo.ts'
import { detectLimit, limitNotice } from './schedule/limit-detect.ts'
import { createFromAgent, listForAgent, removeForAgent } from './schedule/schedule-sink.ts'
import { planResume } from './schedule/scheduler.ts'
import { syncToProject } from './skill-store.ts'
import { sessionWorkDir } from './work-dir.ts'
import { hub } from './ws/hub.ts'

/**
 * The work directory for a session — the project folder when it is attached to
 * a project.
 *
 * The folder choice is read from the database ON EVERY CALL (never cached): a
 * session's project does not change once it is created, but a cache would carry
 * the risk of going stale in memory, and this is a single indexed SELECT.
 *
 * The folder is handed to `RestrictedEnv` as its work directory, so the
 * boundary check applies to a project folder exactly as it does to a session
 * folder: inside — allowed, outside — permission is requested. A project folder
 * gets no privilege of any kind.
 */
function sessionDir(sessionId: string): string {
  return sessionWorkDir(sessionId, sessionProjectDir(sessionId))
}

/**
 * Copies the skills active in a session into its work directory.
 *
 * Active = the globally installed ones plus those installed for this session's
 * project. For a session with no project, only the global ones
 * (`projectId: null`).
 *
 * DOES NOT THROW: if the skills cannot be prepared the conversation still
 * starts, only the `<available_skills>` list will be empty. This layer is a
 * convenience — a fault in it must not bring down the whole session.
 */
function prepareSkills(sessionId: string, dir: string): void {
  try {
    const session = readSession(sessionId)
    syncToProject(dir, activeSkills(session?.projectId ?? null))
  } catch {
    // pass silently — the reason is in the comment above
  }
}

/**
 * Creates the memory directory (`.barpo/memory/`).
 *
 * AN IMPORTANT DIFFERENCE FROM SKILLS: this directory IS NOT SYNCHRONISED. The
 * source of truth for skills is the database and any extra folder is deleted;
 * memory, by contrast, is written by the agent itself and nobody deletes it.
 * All that is guaranteed here is that the directory EXISTS.
 *
 * Why create it up front: the `write` tool creates a missing directory itself,
 * but if `readMemories` cannot read an empty directory the prompt says "no
 * memories yet" and the agent tries to write the first file — which works even
 * without the directory. So this is not a strict requirement, but having the
 * directory makes the structure visible on disk and the agent sees an empty
 * folder when it checks with `ls`.
 *
 * DOES NOT THROW — the same rule as for skills.
 */
function prepareMemory(dir: string): void {
  try {
    mkdirSync(join(dir, MEMORY_DIR), { recursive: true })
  } catch {
    // pass silently — the conversation works perfectly well without memory
  }
}

/**
 * Deletes stale attachments that were never linked to a message, from both the
 * database and the disk.
 *
 * WHY HERE rather than in a cron job: the cleanup then happens naturally as the
 * platform is used, and no separate table watcher is needed. One indexed SELECT
 * at the start of each stream — cheap.
 *
 * The database record is deleted FIRST (inside `deleteOrphanAttachments`), then
 * the file. The other way round would produce a "in the database but not on
 * disk" state, and the agent would try to read a file that no longer exists.
 *
 * DOES NOT THROW — the same rule as `prepareSkills`/`prepareMemory`: this layer
 * is a convenience and a fault in it must not bring down the conversation.
 */
function cleanOrphans(sessionId: string, dir: string): void {
  try {
    for (const orphan of deleteOrphanAttachments(sessionId)) {
      try {
        unlinkSync(join(dir, orphan.path))
      } catch {
        // The file is already gone — the record was cleaned up regardless
      }
    }
  } catch {
    // pass silently — the reason is in the comment above
  }
}

/**
 * Information about a stream that is currently running.
 *
 * `status` only ever takes two values — once a stream finishes its entry is
 * removed from the Map entirely, so 'done'/'error' are never stored here.
 */
interface RunningStream {
  controller: AbortController
  status: 'running' | 'awaiting-permission'
}

/** Running streams — keyed by session, for cancelling and for display */
const running = new Map<string, RunningStream>()

/** The externally visible description of one running session */
export interface RunningSession {
  sessionId: string
  status: 'running' | 'awaiting-permission'
}

/**
 * The list of sessions with a stream in flight right now.
 *
 * When the UI opens a page it takes the initial state from here (GET
 * /api/chat/running) and then keeps it up to date with `chat.status` events:
 * the WS connection is established after the page opens, so state changes from
 * before that may have been missed.
 */
export function runningSessions(): RunningSession[] {
  return [...running.entries()].map(([sessionId, stream]) => ({
    sessionId,
    status: stream.status,
  }))
}

/**
 * Updates a session's stream status and broadcasts it over WS.
 *
 * 'done'/'error' are terminal states; they are not written to the Map (the
 * entry has already been removed in `finally`), only broadcast.
 */
function broadcastStatus(sessionId: string, status: StreamStatus): void {
  const stream = running.get(sessionId)
  if (stream && (status === 'running' || status === 'awaiting-permission')) {
    stream.status = status
  }
  hub.broadcast({ type: 'chat.status', sessionId, status })
}

export interface StreamResult {
  messageId: string
  text: string
  toolCards: ToolCall[]
  error?: string
}

export interface StreamOptions {
  /**
   * Whether tools are enabled. When `false` the plain conversation stream is
   * used (`conversation.ts`) — faster and safer, and convenient in tests.
   */
  tools?: boolean
}

/**
 * Streams a reply into a session. The caller need not await it — the result
 * travels over WS. It does not throw: any problem becomes a `chat.error`.
 *
 * @param messageId the id assigned to the reply message up front — the UI uses
 *   it to attach the arriving chunks to the right message.
 */
export async function streamReply(
  sessionId: string,
  messageId: string,
  choice: ModelChoice,
  options?: StreamOptions,
): Promise<StreamResult> {
  // If a previous stream is running for this session — stop it. The user may
  // have sent a new message without waiting for the reply to finish.
  running.get(sessionId)?.controller.abort()
  const controller = new AbortController()
  running.set(sessionId, { controller, status: 'running' })
  // The stream has started — the sidebar shows the live indicator immediately
  broadcastStatus(sessionId, 'running')

  // When the session is attached to a project, the tools work in the PROJECT
  // folder — so all conversations of one project see one set of files.
  const dir = sessionDir(sessionId)
  const { config: settings } = config({ workDir: dir })

  // Copy the installed skills into the work directory. They are re-synced at
  // the start of every stream: the user may have installed a new skill during
  // the conversation. The agent reads the list from `.barpo/skills/`
  // itself (`skill-load.ts`).
  prepareSkills(sessionId, dir)

  // The memory directory — the agent puts its own notes here. There is no
  // synchronisation, only the guarantee that the directory exists (see
  // `prepareMemory`).
  prepareMemory(dir)

  // Clear abandoned uploads — a user attaching a file and then changing their
  // mind is a normal thing to do.
  cleanOrphans(sessionId, dir)

  const history = prepareHistory(sessionId)
  const toolCardsById = new Map<string, ToolCall>()
  let collected = ''
  let error: string | undefined
  // The full context the agent built — stored with the reply and returned on
  // the next turn together with the tool results
  let agentMessages: unknown[] | undefined
  let contextTokens: number | undefined
  /**
   * Whether the entry in the registry was STILL OURS when the stream ended.
   *
   * When `false` a newer stream has stopped us (the user sent another message
   * without waiting) — in that case the final `chat.status` IS NOT BROADCAST,
   * otherwise the stream that has only just started would immediately appear as
   * "done" in the UI.
   */
  let stillOurs = true

  /**
   * The id of the tool call being executed right now.
   *
   * This is how a permission request and its decision are tied to the call they
   * belong to. It is reliable because tools run SEQUENTIALLY (`agent.ts`:
   * `toolExecution: 'sequential'`) — only one of them can be waiting for
   * permission at a time. The alternative (threading `toolCallId` through the
   * environment and permission layers) would break the interface of three
   * files.
   */
  let activeTool: string | undefined

  /**
   * Request id → the tool call that asked for it.
   *
   * `activeTool` IS NOT ENOUGH. A permission request waits for an answer, so
   * the decision arrives LONG AFTER the request, by which time `activeTool` may
   * point at a different call. Two streams can also briefly coexist in one
   * session (the user stopped one and immediately sent a new message) — in
   * which case the permission manager notifies both of them.
   *
   * So a decision carrying a `requestId` is matched through THIS table, and a
   * foreign request (belonging to another stream) IS SILENTLY DROPPED — better
   * not written at all than written to the wrong card.
   */
  const toolByRequest = new Map<string, string>()

  /**
   * Writes a tool call to the database FIRST, then broadcasts it to the UI.
   *
   * The order matters: a WS event can be lost and a stream can be cut short
   * mid-way, whereas the database record survives. Otherwise (as it used to be)
   * commands executed during an interrupted reply vanished without a trace.
   *
   * A database error DOES NOT STOP the stream: the conversation continuing
   * matters more than the record, and even in the error case the UI at least
   * displays it correctly.
   */
  const sendTool = (tool: ToolCall) => {
    toolCardsById.set(tool.id, tool)
    try {
      writeToolCall({ ...tool, sessionId, messageId })
    } catch {
      // pass silently — the reason is in the comment above
    }
    hub.broadcast({ type: 'chat.tool', sessionId, messageId, tool })
  }

  /**
   * Updates an existing card (permission decision, classifier label).
   *
   * If the card does not exist yet we pass silently: everything that asks for
   * permission arrives through a tool, so this should not happen — but if it
   * does, the stream must not break.
   */
  const updateTool = (id: string | undefined, change: Partial<ToolCall>) => {
    if (!id) return
    const existing = toolCardsById.get(id)
    if (!existing) return
    sendTool({ ...existing, ...change })
  }

  try {
    // The two stream functions return different generators. Both event unions
    // discriminate on `kind`, but TypeScript will not narrow across two
    // separate generator types — so the union is stated here explicitly and the
    // `switch` below narrows it as usual. `ConversationEvent` is a subset of
    // `AgentEvent`'s shape (delta/done/error), which is why the tool-free mode
    // simply never reaches the tool cases.
    const stream = (options?.tools === false
      ? conversationStream(choice, prepareClassifierHistory(sessionId), { signal: controller.signal })
      : agentStream(choice, history, {
          sessionId,
          workDir: dir,
          permission: permissionManager(sessionId),
          mode: modeManager(sessionId),
          signal: controller.signal,
          config: settings,
          // The classifier sees ONLY the text history — tool results never
          // reach it (prompt injection protection)
          classifierHistory: prepareClassifierHistory(sessionId),
          // The source for the `serverList` tool. Supplied as a function — the
          // list is read fresh from the database on every call, because the
          // user may add or remove a server during the conversation. Only the
          // connection fields are passed on (`id`/`createdAt` are of no use to
          // the agent).
          serverProvider: () =>
            readServers().map((s) => ({
              name: s.name,
              host: s.host,
              port: s.port,
              username: s.username,
            })),
          // The source for the `appPublish` tool. The agent knows nothing
          // about the database or the storage layout (an inversion): it writes
          // the app's FILES with the ordinary write/edit tools and passes an
          // id, and the folder is located, validated and registered on this
          // side (`dashboard-save.ts`).
          dashboardSink: (id: string) => publishDashboard(id),
          // The source for `appDelete`. Passed separately from the sink
          // because erasing an app is a different capability from creating
          // one — and the tool refuses to act without the permission manager
          // below, which is the thing that makes the user confirm.
          dashboardRemover: (id: string) => deleteApp(id, sessionId),
          // The schedule tools. Same inversion again: `@barpo/ai` knows
          // nothing about the table or the tick — it hands over a title, a
          // cron expression and a prompt, and everything else (parsing the
          // expression, computing the first firing, broadcasting to the list)
          // happens on this side (`schedule-sink.ts`).
          // `sessionId` is passed so a new schedule inherits THIS
          // conversation's model — see the box in `schedule-sink.ts`.
          scheduleSink: (input) => createFromAgent(input, sessionId),
          scheduleLister: () => listForAgent(),
          scheduleRemover: (id: string) => removeForAgent(id),
          // The installed MCP servers. The same inversion as `serverManbasi`,
          // but with two extra jobs (`mcp-connect.ts`): the secret credentials
          // are merged in from a separate file, and the placeholders
          // (`{token}`) are substituted.
          //
          // AN EMPTY LIST = MCP DOES NOT START AT ALL: no tool is declared and
          // the prompt does not mention MCP. In other words, if no server is
          // installed the agent does not know it exists.
          mcpProvider: () => {
            const session = readSession(sessionId)
            return connectableServers(
              activeMcpServers(session?.projectId ?? null),
              session?.projectId ?? null,
            )
          },
          toolObserver: (name: string, args: unknown) => {
            auditWrite('agent', `tool: ${name}`, toolTarget(name, args), toolLevel(name), 'OK')
          },
          // The git situation of the work directory — read from `.git`'s own
          // files, never by spawning git (see `git-state.ts`). It decides
          // which git rules the prompt carries: init-if-real, local commits,
          // or branch-and-PR.
          gitState: readGitState(dir),
          // The OTHER conversations sharing this project's directory, marked
          // with who is streaming right now. Computed ONCE, here, at the
          // start of the turn — the prompt says the list may be stale. The
          // current session is already in `running` (set above), which is why
          // `siblingSessions` excludes it in SQL. Empty (any session with no
          // project) means the prompt says nothing at all.
          presence: sessionPresence(
            sessionId,
            new Set(runningSessions().map((s) => s.sessionId)),
          ),
        })) as AsyncIterable<ConversationEvent | AgentEvent>

    for await (const event of stream) {
      // A stream that was awaiting permission has moved again — so an answer
      // was given (or it timed out and was denied) and the agent is carrying
      // on. There is no separate "permission answered" event, so any
      // SUBSEQUENT event serves as that signal.
      if (
        event.kind !== 'permission_required' &&
        running.get(sessionId)?.status === 'awaiting-permission'
      ) {
        broadcastStatus(sessionId, 'running')
      }

      switch (event.kind) {
        case 'delta':
          collected += event.text
          hub.broadcast({ type: 'chat.delta', sessionId, messageId, delta: event.text })
          break

        case 'tool_start':
          // The permission request arrives inside this call — remember it so we
          // know which card to attach it to
          activeTool = event.id
          sendTool({
            id: event.id,
            name: event.name,
            args: event.args,
            status: 'running',
          })
          break

        case 'tool_update': {
          const existing = toolCardsById.get(event.id)
          if (existing) sendTool({ ...existing, result: event.text })
          break
        }

        case 'tool_end': {
          const existing = toolCardsById.get(event.id)
          sendTool({
            id: event.id,
            name: existing?.name ?? 'tool',
            args: existing?.args ?? '',
            status: event.isError ? errorStatus(event.result) : 'done',
            result: event.result,
            detail: event.detail,
            // The permission and classifier decisions arrived IN THE MIDDLE of
            // the call — the completion event knows nothing about them, so we
            // carry them across
            permission: existing?.permission,
            classifier: existing?.classifier,
          })
          if (activeTool === event.id) activeTool = undefined
          break
        }

        case 'permission_required':
          // REMEMBER which call asked: the answer arrives later and by then
          // `activeTool` may point at a different one
          if (activeTool) toolByRequest.set(event.request.id, activeTool)
          hub.broadcast({ type: 'chat.permission', sessionId, messageId, request: event.request })
          // The stream pauses until an answer arrives — the sidebar marks this
          // with a yellow badge, because it is the only state waiting on user
          // intervention.
          broadcastStatus(sessionId, 'awaiting-permission')
          auditWrite(
            'agent',
            'permission requested',
            `${event.request.action}: ${event.request.target}`.slice(0, 120),
            'dangerous',
            'pending',
          )
          break

        case 'permission_decision': {
          // HOW the action was approved is written to the card (and through it
          // to the database): was it the auto classifier, did the user press a
          // button, did an "always" pattern match, was it denied, or did it time
          // out. Without this there was no answer to "why was this command run?".
          //
          // When a `requestId` is present the decision is tied to the call that
          // asked (which may already have finished). Without one (always/auto/
          // deny) the decision came out synchronously inside the call running
          // right now.
          const targetTool = event.decision.requestId
            ? toolByRequest.get(event.decision.requestId)
            : activeTool
          // A foreign request (belonging to another stream) — drop it silently
          if (event.decision.requestId && !targetTool) break
          updateTool(targetTool, { permission: event.decision })
          if (event.decision.requestId) toolByRequest.delete(event.decision.requestId)
          auditWrite(
            'barpo',
            'permission decision',
            `${event.decision.origin}: ${event.decision.pattern ?? '—'}`.slice(0, 120),
            'dangerous',
            event.decision.granted ? 'approved' : 'denied',
          )
          break
        }

        case 'classifier': {
          const verdict = event.verdict
          updateTool(activeTool, {
            classifier: { verdict, note: event.note },
          })
          hub.broadcast({
            type: 'chat.classifier',
            sessionId,
            messageId,
            verdict: { verdict, note: event.note },
          })
          auditWrite(
            'classifier',
            verdict === 'allow' ? 'allowed' : 'blocked',
            event.note.slice(0, 120),
            'dangerous',
            verdict === 'allow' ? 'approved' : 'denied',
          )
          break
        }

        case 'mode':
          hub.broadcast({
            type: 'chat.mode',
            sessionId,
            state: {
              mode: event.mode,
              reason: event.reason,
              classifierModel: classifierName(sessionId),
            },
          })
          if (event.reason) {
            auditWrite('barpo', 'auto mode turned off', event.reason.slice(0, 120), 'dangerous', 'OK')
          }
          break

        case 'compacted':
          // The context was compacted — the user should know, because the agent
          // now sees the older details only through a summary
          auditWrite(
            'barpo',
            'context compacted',
            `${event.previousTokens} → ~${event.newTokens} tokens`,
            'write',
            'OK',
          )
          break

        case 'done':
          // The text collected during the stream should match the one in
          // `done`, but the latter is more reliable (the provider may correct
          // it at the end)
          collected = event.text || collected
          // The next turn continues from this context — with the tool results.
          // `conversationStream` (the tool-free mode) returns no context — in
          // that case the next turn is built from `text`, which is enough
          // (there are no tool results).
          if ('messages' in event) {
            agentMessages = event.messages
            contextTokens = event.contextTokens
          }
          hub.broadcast({
            type: 'chat.done',
            sessionId,
            messageId,
            usage: {
              input: event.usage.input,
              output: event.usage.output,
              cost: event.usage.cost,
            },
          })
          break

        case 'error':
          error = event.message
          break
      }
      if (error) break
    }
  } catch (e) {
    // The stream functions catch their own errors; this is an extra layer of
    // protection
    error = e instanceof Error ? e.message : String(e)
  } finally {
    // Only remove the entry if IT IS STILL OURS. If the user sent a new message
    // without waiting for the reply, a new stream stopped us and started — and
    // deleting that new one's entry would make the session look "not running".
    stillOurs = running.get(sessionId)?.controller === controller
    if (stillOurs) running.delete(sessionId)
  }

  const toolCards = [...toolCardsById.values()]

  // The user stopping it themselves IS NOT AN ERROR. An abort used to travel
  // the `error` path too, which appended "⚠︎ The response did not arrive in
  // full: request cancelled" to the reply text — and since the tool card
  // already said "stopped", one event showed up as two warnings.
  const stopped = controller.signal.aborted

  // Storing the reply: it is written even when empty (so the reason is visible
  // in the error case)
  const toStore = error && !stopped ? textWithError(collected, error) : collected
  // The session may have been deleted while the stream was running (DELETE
  // /chat/sessions/:id calls `abort()` first, but the stream still reaches this
  // point). Without the check `writeMessage` would raise a foreign key error —
  // and that would not be caught here, because `finally` has already run.
  const sessionExists = readSession(sessionId) !== null
  // The condition for NOT LOSING the turn: text, tools or agent context — it is
  // written if any one of the three is present. Previously only the first two
  // were checked, and when the provider returned an empty reply (or an error was
  // swallowed silently) the whole reply never reached the database at all: the
  // user's message was left alone in the history and nobody could tell what had
  // happened on the next turn.
  const shouldWrite =
    toStore.length > 0 || toolCards.length > 0 || (agentMessages?.length ?? 0) > 0
  if (sessionExists && shouldWrite) {
    writeMessage({
      id: messageId,
      sessionId,
      role: 'assistant',
      text: toStore,
      toolCards,
      // On error the context is not stored: a half-built history (for example a
      // tool call with no answer) would break the next request too. In that case
      // the next turn is rebuilt from `text` — detail is lost, but the session
      // keeps working.
      agentMessages: error ? undefined : agentMessages,
      contextTokens: error ? undefined : contextTokens,
    })
  }

  if (error && !stopped) {
    // ┌──────────────────────────────────────────────────────────────────┐
    // │ THE QUOTA CASE IS NOT REPORTED AS A FAILURE.                     │
    // │                                                                  │
    // │ When the provider's limit is what stopped the reply, the platform│
    // │ books the continuation itself and tells the user WHEN — so the   │
    // │ honest message is "paused until 14:35", not "failed". Sending    │
    // │ `chat.error` as well would ask the user to act on something that │
    // │ is already handled.                                              │
    // │                                                                  │
    // │ Everything else takes the ordinary error path untouched. The     │
    // │ scheduling attempt itself is wrapped: if it fails, the user must │
    // │ still see the original provider error rather than silence.       │
    // └──────────────────────────────────────────────────────────────────┘
    const scheduled = scheduleContinuation(sessionId, messageId, error)
    if (!scheduled) {
      hub.broadcast({ type: 'chat.error', sessionId, messageId, error })
      auditWrite('chat', 'LLM response failed', `${choice.provider}/${choice.model}`, 'read', 'denied')
    }
  } else if (stopped) {
    // For the UI this is an ordinary completion: the stream closes and no red
    // warning appears.
    hub.broadcast({
      type: 'chat.done',
      sessionId,
      messageId,
      usage: { input: 0, output: 0, cost: 0 },
    })
    auditWrite('chat', 'LLM response stopped', `${choice.provider}/${choice.model}`, 'read', 'OK')
  } else {
    auditWrite('chat', 'LLM response', `${choice.provider}/${choice.model}`, 'read', 'OK')
  }

  // The final status — an abort passes through here too: a cancelled stream
  // also reaches this point, so the sidebar indicator closes in every case. If a
  // new stream has replaced us we do not broadcast (see above).
  if (stillOurs) broadcastStatus(sessionId, error && !stopped ? 'error' : 'done')

  return { messageId, text: collected, toolCards, error }
}

/**
 * Books a continuation when the reply died on the provider's quota.
 *
 * Returns `true` when the conversation is now scheduled to carry on — in which
 * case the caller must NOT send `chat.error`, because from the user's point of
 * view nothing needs doing.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ IT NEVER THROWS, AND THAT IS THE POINT. This runs on the failure     │
 * │ path: if scheduling itself breaks (the database is locked, the       │
 * │ session was deleted mid-stream) the user must still see the ORIGINAL │
 * │ provider error. Swallowing that in favour of a scheduling error      │
 * │ would replace a problem the user can act on with one they cannot.    │
 * └──────────────────────────────────────────────────────────────────────┘
 */
function scheduleContinuation(sessionId: string, messageId: string, error: string): boolean {
  try {
    const limit = detectLimit(error)
    if (!limit) return false

    // A session that no longer exists has nothing to continue. This is checked
    // here rather than relying on the foreign key, so the audit entry and the
    // WS event are not written for a conversation that has gone.
    if (!readSession(sessionId)) return false

    const already = pendingResume(sessionId)
    const schedule = planResume({ sessionId, resumeAt: limit.resumeAt, reason: error }, already)
    // `null` means one was already pending FOR A FUTURE TIME — the conversation
    // IS scheduled, so the error must still be suppressed. Reporting a failure
    // here would contradict the notice the user was shown a moment ago. (A
    // pending row that is already due gets moved instead, and comes back as
    // `schedule` — see `planResume`.)
    const pending = schedule ?? already
    if (!pending) return false
    const { id: scheduleId, runAt } = pending

    hub.broadcast({
      type: 'chat.scheduled',
      sessionId,
      messageId,
      scheduleId,
      runAt,
      reason: limitNotice(limit),
    })
    return true
  } catch {
    // See the box above — fall back to the ordinary error path.
    return false
  }
}

/**
 * Which model the classifier is running with (shown in the UI).
 *
 * Relies on the cache — `detectModels()` must have run before this is called.
 * Synchronous, because `modeState` is called in many places.
 */
function classifierName(sessionId?: string): string | undefined {
  const settings = sessionId
    ? config({ workDir: sessionDir(sessionId) }).config
    : config().config
  const choice = pickClassifierModel(
    cachedResult()?.models ?? [],
    settings.permission.classifierModel,
    // The session's own provider, so the name shown in the UI is the model
    // that will ACTUALLY be used. Reading it from the database on every call
    // is one indexed SELECT, and a cached copy could disagree with the pick
    // the permission layer makes — which is precisely the confusion this
    // display exists to prevent.
    sessionId ? readSession(sessionId)?.provider : undefined,
  )
  return choice ? `${choice.provider}/${choice.model}` : undefined
}

/** The session's current permission mode */
export function modeState(sessionId: string): ModeState {
  const manager = modeManager(sessionId)
  return { ...manager.state, classifierModel: classifierName(sessionId) }
}

/**
 * Changes the mode (the user switched it, or turned auto back on). Broadcasts
 * the new state over WS.
 *
 * Async: when auto is requested the providers may not have been detected yet
 * (the server has only just come up and nobody has asked for `/api/models`).
 * Rejecting with "no model found" in that situation would be wrong — so we
 * detect first.
 */
export async function setMode(
  sessionId: string,
  mode: PermissionMode,
): Promise<ModeState> {
  const manager = modeManager(sessionId)

  if (mode === 'auto') {
    // If the cache is empty we wait for detection — otherwise the first attempt
    // to enable auto would always fail
    if (!cachedResult()) {
      try {
        await detectModels()
      } catch {
        // If detection fails the check below reports the reason
      }
    }
    if (!classifierName(sessionId)) {
      const state: ModeState = {
        mode: 'confirm',
        reason: 'no suitable model found for the classifier — check that a provider is configured',
      }
      hub.broadcast({ type: 'chat.mode', sessionId, state })
      return state
    }
  }

  manager.set(mode)
  const state = modeState(sessionId)
  hub.broadcast({ type: 'chat.mode', sessionId, state })
  auditWrite('user', 'permission mode', mode, 'write', 'OK')
  return state
}

/**
 * The permission requests currently awaiting an answer in a session.
 *
 * WHY IT IS NEEDED. `chat.permission` is a WS event sent exactly once. If it
 * does not arrive (the client has not sent `sub` yet, a reconnection window, the
 * page was opened mid-stream) the request NEVER appears in the UI and the agent
 * goes on waiting for an answer — which the user experiences as "the chat has
 * frozen".
 *
 * Having a source that can be POLLED in addition to the event makes that whole
 * class of race harmless: the UI restores the state from here when the page
 * opens and on every reconnection. The same logic as `awaiting-permission` in
 * `chat.status` (`GET /api/chat/running`).
 */
export function pendingPermissions(sessionId: string): PermissionRequest[] {
  return permissionManager(sessionId).pendingRequests
}

/** Answering a permission request — arrives over WS or REST */
export function answerPermission(
  sessionId: string,
  requestId: string,
  answer: PermissionAnswer,
): boolean {
  const delivered = permissionManager(sessionId).answer(requestId, answer)
  if (delivered) {
    auditWrite(
      'user',
      'permission reply',
      `${requestId.slice(0, 8)} → ${answer}`,
      'dangerous',
      answer === 'deny' ? 'denied' : 'approved',
    )
  }
  return delivered
}

/**
 * Cancels the stream in a session (the user stopped it).
 *
 * The final `chat.status` IS NOT BROADCAST here: after `abort()` the stream
 * finishes on its own and the shared completion path at the end of `streamReply`
 * sends 'done' or 'error'. Sending from two places would give the UI two events.
 */
export function stopStream(sessionId: string): boolean {
  const stream = running.get(sessionId)
  if (!stream) return false
  stream.controller.abort()
  return true
}

/** Whether a reply is streaming in this session */
export function isStreaming(sessionId: string): boolean {
  return running.has(sessionId)
}

/**
 * For tests: abort every running stream and empty the registry.
 *
 * WHY THIS IS NEEDED. `running` is module level, so it is SHARED by every test
 * file in the process. `POST /api/chat/send` starts the stream with `void`
 * (`routes/chat.ts`) — it does not await it, which is correct in production but
 * means the test that sent the request finishes while the stream is still
 * registered. That leftover entry then shows up in another file's
 * `runningSessions()` assertions, so the suite failed at random depending on
 * the order Bun happened to run the files in.
 *
 * `stopStream()` is not enough on its own: `abort()` only requests a stop and
 * the entry is removed later, in the stream's own `finally`. The registry is
 * therefore cleared here as well, so the state is clean SYNCHRONOUSLY.
 */
export function clearRunningStreams(): void {
  for (const stream of running.values()) stream.controller.abort()
  running.clear()
}

/**
 * Puts the messages from the database into the shape the LLM expects.
 *
 * A message that has `agentMessages` (those written after migration 004) is
 * passed through raw — it holds the tool RESULTS as well. Without it a plain
 * message is built from `text`.
 *
 * Why this matters: previously only `{role, text}` was passed on, so the agent
 * could not see its own earlier `read`/`bash` results on the next turn and was
 * forced to read the file again every time.
 */
function prepareHistory(sessionId: string): StoredMessage[] {
  return (
    readMessages(sessionId)
      // A message with an attachment passes even without text: the user may send
      // only a file and write nothing — the agent still has to see it.
      .filter(
        (m) =>
          m.text.trim().length > 0 ||
          (m.agentMessages?.length ?? 0) > 0 ||
          (m.attachments?.length ?? 0) > 0,
      )
      .map((m) => ({
        role: m.role,
        text: m.text,
        agentMessages: m.agentMessages,
        // Only the fields the agent needs — `id`, `mime` and `size` give it
        // nothing and would fill the prompt with noise
        attachments: m.attachments?.map((a) => ({
          kind: a.kind,
          originalName: a.originalName,
          path: a.path,
        })),
      }))
  )
}

/**
 * The history for the classifier — TEXT ONLY.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ SECURITY BOUNDARY. `agentMessages` is DELIBERATELY dropped here.   │
 * │ Tool results never reach the classifier: if a file the agent read  │
 * │ says "now run rm -rf ~", that must not influence the decision.     │
 * │                                                                    │
 * │ `classifierHistory()` inside `agentStream` applies the same filter │
 * │ again — two layers of protection, because if this breaks the       │
 * │ prompt injection defence is lost entirely.                         │
 * └────────────────────────────────────────────────────────────────────┘
 */
function prepareClassifierHistory(sessionId: string): ConversationMessage[] {
  return readMessages(sessionId)
    .filter((m) => m.text.trim().length > 0)
    .map((m) => ({ role: m.role, text: m.text }))
}

function textWithError(collected: string, error: string): string {
  const marker = `⚠︎ The response did not arrive in full: ${error}`
  return collected.trim().length > 0 ? `${collected}\n\n${marker}` : marker
}

/** A denied permission is distinguished from an error result — the UI colours it differently */
function errorStatus(result: string): ToolCall['status'] {
  return result.includes('Permission denied') ? 'denied' : 'error'
}

/** For the audit trail: what the tool touched */
function toolTarget(name: string, args: unknown): string {
  if (!args || typeof args !== 'object') return name
  const a = args as Record<string, unknown>
  if (name === 'bash' && typeof a.command === 'string') return a.command.slice(0, 120)
  if (typeof a.path === 'string') return a.path
  return name
}

/**
 * `read` is a read, the rest are writes or dangerous.
 *
 * MCP tools are 'dangerous' — on a par with `bash`. The reason: they affect an
 * external system (creating an issue, sending a message) and that effect is not
 * visible on the local file system, which also makes it hard to undo. The
 * platform does not know exactly what they do (the server is third-party code),
 * so the most cautious level is applied.
 */
function toolLevel(name: string): 'read' | 'write' | 'dangerous' {
  if (name === 'read') return 'read'
  if (name === 'bash') return 'dangerous'
  if (isMcpTool(name)) return 'dangerous'
  return 'write'
}

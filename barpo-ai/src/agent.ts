// The tool-using agent stream.
//
// How it differs from `conversation.ts`: here the LLM can do hands-on work —
// reading/writing/editing files and running commands. Those are pi-agent-core's
// ready-made tools (`read`, `write`, `edit`, `bash`) — truncation, streaming,
// abort and timeout are already solved there.
//
// The safety chain:
//   tool → RestrictedEnv → (inside the working directory?) → runs
//                             → (outside/dangerous?) → PermissionManager
//                                                    → the user's answer
//
// `beforeToolCall` is for observation only: blocking happens in the environment
// layer, because that layer sees both the path and the command's content. Here
// we only invoke the callback for auditing.
//
// Tools run SEQUENTIALLY (`toolExecution: 'sequential'`). In testing, parallel
// mode had `write` and `read` going at the same time, and `read` started before
// the file was written and got an ENOENT.

import { Agent, createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-agent-core'
import type { AgentEvent as PiAgentEvent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core'
import type { Api, ImageContent, Model, Models } from '@earendil-works/pi-ai'
import type { Config } from '@barpo/config'
import { defaultConfig } from '@barpo/config'
import type { ModelChoice, PermissionDecision, PermissionMode, PermissionRequest } from '@barpo/shared'
import { modelsCollection } from './detect.ts'
import {
  afterChain,
  redactSecretsHook,
  beforeChain,
  extraDenyHook,
  lengthHook,
  type ToolHook,
} from './hooks.ts'
import type { ClassifierMessage } from './classifier.ts'
import {
  dropOldest,
  buildContext,
  contextTokens,
  compact,
  needsCompaction,
  truncateToolResults,
  type StoredMessage,
  type MessageAttachment,
} from './context.ts'
import { contextToPrompt, readProjectContext } from './project-context.ts'
import { readSkills, skillsToPrompt } from './skill-load.ts'
import { readMemoryIndex, readMemories, memoriesToPrompt } from './memory.ts'
import { RestrictedEnv } from './environment.ts'
import type { ModeManager } from './mode.ts'
import { searchToolsRaw } from './search-tools.ts'
import { SERVER_PROMPT_SECTION, serverToolsRaw, type ServerProvider } from './server-tools.ts'
import {
  DASHBOARD_PROMPT_SECTION,
  dashboardToolsRaw,
  type DashboardRemover,
  type DashboardSink,
} from './dashboard-tools.ts'
import {
  SCHEDULE_PROMPT_SECTION,
  scheduleToolsRaw,
  type ScheduleLister,
  type ScheduleRemover,
  type ScheduleSink,
} from './schedule-tools.ts'
import { PROCESS_PROMPT_SECTION, processToolsRaw } from './process-tools.ts'
import { processManager, type ProcessManager } from './process-manager.ts'
import { McpManager, type McpConnectableServer } from './mcp-manager.ts'
import { MCP_PROMPT_SECTION, isMcpTool, mcpToolsRaw } from './mcp-tools.ts'
import type { PermissionManager } from './permission.ts'
import type { Usage, ConversationMessage } from './conversation.ts'

export type AgentEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'tool_start'; id: string; name: string; args: string }
  | { kind: 'tool_update'; id: string; text: string }
  | {
      kind: 'tool_end'
      id: string
      result: string
      isError: boolean
      detail?: { diff?: string; truncated?: boolean }
    }
  | { kind: 'permission_required'; request: PermissionRequest }
  /**
   * The permission question is settled — including where the decision came
   * from. The caller attaches this to the tool call running AT THAT EXACT
   * MOMENT (tools run sequentially, so there is exactly one).
   */
  | { kind: 'permission_decision'; decision: PermissionDecision }
  | { kind: 'classifier'; verdict: 'allow' | 'block'; note: string }
  | { kind: 'mode'; mode: PermissionMode; reason?: string }
  /** The context was compacted — the UI tells the user */
  | { kind: 'compacted'; previousTokens: number; newTokens: number }
  | {
      kind: 'done'
      text: string
      usage: Usage
      /**
       * The full context the agent built — WITH TOOL RESULTS.
       * The caller stores this and passes it back on the next turn; without
       * it the agent forgets its own tool results every turn.
       */
      messages: AgentMessage[]
      /** The context size the provider reported — for the next compaction decision */
      contextTokens: number
    }
  | { kind: 'error'; message: string }

/**
 * The list of MCP servers to connect for a session.
 *
 * Read fresh AT THE START OF EVERY STREAM, never cached: the user may install
 * or remove a server mid-conversation (the same reason as `ServerProvider`).
 */
export type McpProvider = () => McpConnectableServer[] | Promise<McpConnectableServer[]>

export interface AgentOptions {
  sessionId: string
  /** The directory the tools work in */
  workDir: string
  permission: PermissionManager
  /** Permission mode — on `auto` the classifier runs */
  mode?: ModeManager
  signal?: AbortSignal
  /** Platform settings. Defaults are used if not given. */
  config?: Config
  /**
   * The TEXT-ONLY history handed to the classifier.
   *
   * If not given it is built from `messages` and tool results are filtered
   * out. It is better for the caller to supply it: the caller knows the clean
   * text in the database, and that gives two layers of protection instead of
   * one.
   */
  classifierHistory?: ConversationMessage[]
  /**
   * The source that supplies the list of servers connected to the platform.
   *
   * If not given, the `serverList` tool is NOT DECLARED AT ALL and the prompt
   * does not mention it either (see `server-tools.ts`). An inversion: the
   * server database lives in `barpo-server`, and this package does not
   * depend on it.
   */
  serverProvider?: ServerProvider
  /**
   * The function that registers an app folder (the dynamic dashboard).
   *
   * If not given, the `appPublish` tool is NOT DECLARED AT ALL and the prompt
   * does not mention it either (see `dashboard-tools.ts`). The same inversion
   * as `serverProvider`, for the same reason: the publish record and the app
   * folders live in `barpo-server`, and this package does not depend on it.
   */
  dashboardSink?: DashboardSink
  /**
   * The function that deletes an app and its folder.
   *
   * Given SEPARATELY from `dashboardSink` on purpose: publishing and deleting
   * are not the same kind of permission to hand out. A caller can offer the
   * agent the ability to create apps without also offering it the ability to
   * erase them.
   *
   * `appDelete` is declared only when this AND the permission manager are
   * present — the tool always asks the user first (see `dashboard-tools.ts`).
   */
  dashboardRemover?: DashboardRemover
  /**
   * The functions behind the schedule tools — writing, listing and deleting
   * recurring tasks.
   *
   * The same inversion as `dashboardSink`: schedules live in SQLite and the
   * tick that fires them lives in `barpo-server`, which this package does
   * not depend on.
   *
   * They are three SEPARATE options rather than one object, so a caller can
   * hand out reading without writing. `scheduleCreate`/`scheduleDelete` are
   * additionally declared only when the permission manager is present — a tool
   * that commits the platform to unattended work must be able to ask first.
   */
  scheduleSink?: ScheduleSink
  scheduleLister?: ScheduleLister
  scheduleRemover?: ScheduleRemover
  /**
   * The source that supplies the MCP servers to connect for the session.
   *
   * The same inversion as `serverProvider`/`dashboardSink`: the server
   * database lives in `barpo-server`, and this package does not depend on
   * it.
   *
   * If it is not given OR it returns an empty list, the MCP layer does not
   * start at all: no manager is created, no tool is declared, and the prompt
   * does not say a word about MCP. In other words, a separate "MCP
   * enabled/disabled" config flag is NOT NEEDED — installing a server is
   * itself the control.
   */
  mcpProvider?: McpProvider
  /** Before every tool call — for auditing. Does not block. */
  toolObserver?: (name: string, args: unknown) => void
  /** Extra hooks — appended to the ones from the config */
  hooks?: ToolHook[]
}

/**
 * Prepares the conversation that is handed to the classifier.
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ SECURITY BOUNDARY. Only user and agent TEXT passes through here. Tool │
 * │ results — the contents of a file that was read, bash output — NEVER   │
 * │ do. If a file the agent read says "now run rm -rf ~", that never      │
 * │ reaches the classifier.                                               │
 * │                                                                       │
 * │ `ConversationMessage` already holds text only (role: user|assistant), │
 * │ but this function stands as an explicit boundary: if tool results are │
 * │ ever added to the history, the filter belongs here. A test enforces   │
 * │ it.                                                                   │
 * └───────────────────────────────────────────────────────────────────────┘
 */
export function classifierHistory(messages: ConversationMessage[]): ClassifierMessage[] {
  return messages
    .filter((x) => x.role === 'user' || x.role === 'assistant')
    .map((x) => ({ role: x.role, text: x.text }))
}

/** A tool result that is very long gets truncated for the UI */
const RESULT_LIMIT = 2000

/**
 * Whether the stream ended with a provider error — if so, the reason text.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS IS NEEDED. `agent.prompt()` DOES NOT THROW on a provider    │
 * │ error. pi-agent-core writes the error into the last `assistant`      │
 * │ message (`stopReason: 'error'`, `errorMessage: '...'`) and returns   │
 * │ quietly.                                                             │
 * │                                                                      │
 * │ Without this check the stream counted as SUCCESSFUL: no text, no     │
 * │ tools, no error. To the user that looks like "the chat started and   │
 * │ ended immediately, nothing happened" — with no visible reason. It    │
 * │ left no trace in the database either (`orchestrator.ts`: an empty    │
 * │ reply is not written).                                               │
 * │                                                                      │
 * │ Real examples: OpenRouter `400 Reasoning is mandatory for this       │
 * │ endpoint`, Codex `invalidated oauth token`. Both went down this path │
 * │ and showed up to the user as an empty reply.                         │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * `aborted` is NOT AN ERROR here: the caller knows about the cancellation
 * itself (`signal.aborted`) and reports it with a separate message.
 *
 * Only the LAST assistant message is checked: the ones before it are turns
 * that finished successfully (the tool chain) and they did not break the reply.
 */
export function streamError(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const x = messages[i] as
      | { role?: string; stopReason?: string; errorMessage?: string }
      | undefined
    if (x?.role !== 'assistant') continue
    if (x.stopReason !== 'error') return undefined
    return x.errorMessage?.trim() || 'the provider could not return a response'
  }
  return undefined
}

/**
 * The agent's system prompt.
 *
 * STRUCTURE (the order is deliberate): who you are → language → how you speak
 * → how you work → tools → extra layers. The behavioural rules come BEFORE the
 * tool mechanics, because they apply to every reply; the tool rules only apply
 * when a tool is used.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ WHY THERE IS A "DO NOT DO THIS" LIST.                                │
 * │                                                                      │
 * │ The prompt gives the model the tool list, the working directory path │
 * │ and the permission rules. It needs that information to WORK, but the │
 * │ model tends to READ IT BACK TO THE USER: "Hello! Here is what I can  │
 * │ do: read files, write them… My working directory: /home/…". That is  │
 * │ exactly what happened in real testing.                               │
 * │                                                                      │
 * │ In other words every line of the prompt does two jobs — an           │
 * │ instruction to the model and (unwantedly) material for a reply. The  │
 * │ second one has to be forbidden explicitly, otherwise the model       │
 * │ recites the prompt whenever it introduces itself.                    │
 * │                                                                      │
 * │ That is also why the identity is written out explicitly: with no     │
 * │ answer to "who are you", the model falls back on its training        │
 * │ identity and introduces itself under another product's name.         │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * THE LANGUAGE IS NOT STATIC. The prompt used to say flatly "communicate in
 * Uzbek", and the model answered in Uzbek even to a message written in another
 * language. Now the language is detected from the user's own ON EVERY MESSAGE;
 * Uzbek is only the fallback used when the language is unclear.
 *
 * `projectContext` — the text of `AGENTS.md`/`CLAUDE.md` in the working
 * directory (`project-context.ts`). It is appended at the END of the prompt,
 * AFTER the platform's own rules: there is no rule that later text looks
 * stronger to the model, but the order states the intent clearly — the
 * platform rules are the foundation, the project's instructions go on top.
 *
 * `skills` — the listing of `.barpo/skills/` in the working directory
 * (`skill-load.ts`). Only name+description+path goes in; the model fetches the
 * full text itself with `read`.
 *
 * `memory` — the listing of `.barpo/memory/` in the working directory
 * (`memory.ts`). The same progressive disclosure as the skills, but it is
 * included even when empty: without the writing rule the agent would not know
 * the mechanism exists.
 *
 * None of these three texts GOES TO THE CLASSIFIER — it works off a separate
 * prompt (`classifier.ts`) and never calls this function at all.
 *
 * `hasServers` — whether the `serverList` tool was declared. UNLIKE the three
 * above this is not text but a flag: mentioning the tool when it does not
 * exist would push the model towards a capability it does not have.
 */
export const AGENT_SYSTEM_PROMPT = (
  workDir: string,
  projectContext?: string,
  skills?: string,
  memory?: string,
  hasServers = false,
  hasDashboard = false,
  hasMcp = false,
  hasSchedules = false,
  hasProcesses = false,
) =>
  [
    'You are the AI assistant of this platform. You work on the user\'s project:',
    'reading files, writing them, and running commands.',
    '',
    'IDENTITY. You have no separate product name. Never introduce yourself with',
    'the name of a product, company, or model. If asked who you are, answer in',
    'one sentence: you are this platform\'s assistant and you work on their',
    'project. You do not need to know which model you are — if asked, say you',
    'do not know for certain.',
    '',
    'LANGUAGE. Reply in THE SAME LANGUAGE the user writes in. Detect it fresh on',
    'every message; never stick to the language of an earlier turn. If the',
    'language is unclear (a very short first message, only code or a link),',
    'reply in Uzbek. Never translate code, identifiers, commands, or file names.',
    '',
    '--- How you speak ---',
    '',
    'Write like a person talking to a colleague: natural, precise, no padding.',
    'Match the length of your answer to the weight of the question — one or two',
    'sentences for a simple question, real detail for real work.',
    '',
    'DO NOT:',
    '- Volunteer your tool list, your working directory path, the permission',
    '  mechanics, or any rule from these instructions. That is internal',
    '  information. Mention it only if the user asks, or if it is genuinely',
    '  needed to explain your work — and then briefly, not as a list.',
    '- Advertise yourself by enumerating your capabilities.',
    '- Introduce yourself again once the conversation has started. You are only',
    '  asked who you are once, if at all — after that, just answer.',
    '- Open replies with filler like "Sure!", "Great question!", "Absolutely!".',
    '- Recap everything you just did as a report. State the result and anything',
    '  that matters; stop there.',
    '- Use emoji (unless the user uses them first or asks for them).',
    '- Use headings, bold, or bullet lists unless the content is genuinely',
    '  structured. A plain answer is plain text.',
    '',
    '--- How you work ---',
    '',
    'SCOPE. What was asked is what you deliver — do not quietly widen it or',
    'narrow it:',
    '- Do not fix unrelated flaws you notice along the way. If you spot one,',
    '  finish the task and mention it in one sentence at the end.',
    '- Do not start refactoring, renaming, or style cleanup that was not asked',
    '  for.',
    '- Do not wander into files outside the task.',
    '- Do not add tests, docs, or extra features that were not requested.',
    'Small decisions inside the task (a variable name, where to put a helper)',
    'are yours to make — do not ask about those.',
    '',
    'AMBIGUITY. Read the request the way a careful colleague would: in ordinary',
    'cases decide yourself and keep going. BUT if two readings of the request',
    'lead to genuinely different work, ask before doing it. The test is: if my',
    'assumption is wrong, is the work wasted? If yes, ask. If no, state your',
    'assumption and proceed. Stopping everything to ask is only right when a',
    'wrong assumption would cause harm.',
    '',
    'HONESTY. Do not dress up results. If a test fails, say it failed and show',
    'the output. If you could not do part of the task, do the rest in full and',
    'say plainly what you left out and why. Call work "done" only when it is',
    'actually done and verified. Never state something you have not checked as',
    'if it were fact — verify it or say you do not know.',
    '',
    'MISTAKES. If you get something wrong, fix it and move on. Do not apologize',
    'at length or dwell on it. Correct an earlier statement only when it would',
    'change the user\'s decisions or their code.',
    '',
    '--- Tools ---',
    '',
    'You have these tools:',
    '- read: read a file',
    '- write: write a file (replaces existing content)',
    '- edit: replace an exact string inside a file',
    '- grep: search inside files with a regex (`file:line:text`)',
    '- find: locate files by glob',
    '- ls: list a directory',
    '- bash: run a command',
    ...(hasProcesses ? PROCESS_PROMPT_SECTION.list : []),
    ...(hasServers ? SERVER_PROMPT_SECTION.list : []),
    ...(hasDashboard ? DASHBOARD_PROMPT_SECTION.list : []),
    ...(hasSchedules ? SCHEDULE_PROMPT_SECTION.list : []),
    ...(hasMcp ? MCP_PROMPT_SECTION.list : []),
    '',
    ...(hasProcesses ? [...PROCESS_PROMPT_SECTION.rules, ''] : []),
    ...(hasServers ? [...SERVER_PROMPT_SECTION.rules, ''] : []),
    ...(hasDashboard ? [...DASHBOARD_PROMPT_SECTION.rules, ''] : []),
    ...(hasSchedules ? [...SCHEDULE_PROMPT_SECTION.rules, ''] : []),
    ...(hasMcp ? [...MCP_PROMPT_SECTION.rules, ''] : []),
    'To find files use `grep`/`find`/`ls`, NOT `bash` — they are faster and ask',
    'for no permission. Reach for `bash` only when nothing else will do. Those',
    'three tools work only inside the working directory and by default skip',
    '`.git`, `node_modules`, `dist` and similar (pass `all: true` to include',
    'them).',
    '',
    '`bash` is the most powerful and most dangerous tool. Use it for real work:',
    'builds, tests, git, installing packages. To read or write a file use',
    '`read`/`write`, NOT `cat`/`echo`. Know what a command does before running',
    'it, and never run an irreversible one (deleting files, `git reset --hard`,',
    'force push) unless the user explicitly asked for it.',
    '',
    `Your working directory: ${workDir}`,
    'Relative paths resolve against it. Normally, work inside this directory.',
    '',
    'IMPORTANT: files outside the working directory and dangerous commands (rm,',
    'sudo, curl, etc.) require the user\'s permission. If permission is denied',
    'you get an error — that is normal. Explain it to the user and suggest',
    'another way. NEVER try to work around the permission system.',
    '',
    'Read a file before you edit it. Use one tool at a time. After changing a',
    'file you do not need to read it back to verify — if `edit` returned',
    'successfully, the change was written.',
    ...(skills ? [skills] : []),
    ...(memory ? [memory] : []),
    ...(projectContext ? [projectContext] : []),
  ].join('\n')

/**
 * The reply stream that works with tools.
 * Does not throw — a problem comes back as `{ kind: 'error' }`.
 */
export async function* agentStream(
  choice: ModelChoice,
  messages: StoredMessage[],
  options: AgentOptions,
): AsyncGenerator<AgentEvent> {
  const config = options.config ?? defaultConfig()
  // The queue between the producer (the agent) and the consumer (this
  // generator). `wake` is kept in an object field so that TS's control-flow
  // analysis of a local variable does not mislead us.
  const state: { queue: AgentEvent[]; wake: (() => void) | undefined; done: boolean } = {
    queue: [],
    wake: undefined,
    done: false,
  }

  const emit = (e: AgentEvent) => {
    state.queue.push(e)
    state.wake?.()
  }

  // We pass the config values down to the managers. They are held in a
  // per-session registry and the config was not yet known when they were
  // created.
  options.permission.setWaitTimeout(config.permission.waitSeconds * 1000)
  options.mode?.setLimits(
    config.permission.consecutiveBlockLimit,
    config.permission.totalBlockLimit,
  )

  // Permission requests are pushed onto the stream — the orchestrator relays
  // them to the WS
  const unsubscribeRequests = options.permission.subscribe((request) =>
    emit({ kind: 'permission_required', request }),
  )
  const unsubscribeVerdicts = options.permission.subscribeVerdicts((v) =>
    emit({ kind: 'classifier', verdict: v.verdict, note: v.note }),
  )
  const unsubscribeDecisions = options.permission.subscribeDecisions((decision) =>
    emit({ kind: 'permission_decision', decision }),
  )
  const unsubscribeMode = options.mode?.subscribe((change) =>
    emit({ kind: 'mode', mode: change.mode, reason: change.reason }),
  )

  // The context handed to the classifier — the history WITHOUT TOOL RESULTS.
  // If the caller supplied a ready text history we take that, otherwise we
  // build it from the `text` field of the stored messages alone. Neither path
  // TAKES `agentMessages` (where the tool results live) INTO ACCOUNT.
  // The context is wired up only when `mode` is given; otherwise it is
  // confirm mode.
  if (options.mode) {
    options.permission.setClassifierContext({
      mode: options.mode,
      conversation: classifierHistory(options.classifierHistory ?? textHistory(messages)),
      workDir: options.workDir,
      signal: options.signal,
      model: config.permission.classifierModel,
      // The conversation's own provider — the classifier prefers a model from
      // it, because it is known to be reachable and paid for. See the box on
      // `pickClassifierModel`.
      chatProvider: choice.provider,
    })
  } else {
    options.permission.setClassifierContext(undefined)
  }

  // The MCP manager is created inside `run`, but `cleanup()` has to be able to
  // reach it: the processes must be closed even when the stream is cancelled.
  // That is why it is declared out here.
  let mcpManager: McpManager | undefined

  const cleanup = () => {
    unsubscribeRequests()
    unsubscribeVerdicts()
    unsubscribeDecisions()
    unsubscribeMode?.()
    options.permission.setClassifierContext(undefined)
    // LEAVE NO ZOMBIE PROCESSES. `cleanup()` is synchronous (`finally` blocks
    // call it) while closing MCP is async — so we DO NOT AWAIT the result, we
    // only kick it off. The error is swallowed: cleanup has to run to the end
    // in every case, and a failed MCP close must not bring the session down.
    mcpManager?.close().catch(() => undefined)
    mcpManager = undefined
  }

  const run = (async () => {
    try {
      const models = await modelsCollection()
      const model = models.getModel(choice.provider, choice.model)
      if (!model) {
        emit({
          kind: 'error',
          message: `Model not found: ${choice.provider}/${choice.model}. Check that the provider is configured.`,
        })
        return
      }

      const environment = new RestrictedEnv({
        workDir: options.workDir,
        permission: options.permission,
        commandTimeoutMs: config.agent.tools.bashTimeoutSeconds * 1000,
      })
      const toolContext = { env: environment }

      // --- MCP servers: connecting to the ones installed for the session ---
      //
      // THE VERY SAME `options.permission` INSTANCE is passed in (a new one is
      // not created): that way the "always allow" patterns, the block counters
      // and the classifier context share THE SAME state as the file/command
      // requests. To the user the permission system is one single thing.
      //
      // DOES NOT THROW: a server that could not be connected stays in
      // `connectionErrors` and the session carries on WITHOUT it (see
      // `mcp-manager.ts`).
      if (options.mcpProvider) {
        const servers = await options.mcpProvider()
        if (servers.length > 0) {
          mcpManager = new McpManager(options.sessionId, options.permission)
          // The timeouts are applied FROM THE CONFIG. The source
          // (`barpo-server`) does not know them — it only says "which
          // server to connect to", while "how long to wait" is a platform
          // setting. A value the source supplies itself takes precedence (for
          // tests and special cases).
          await mcpManager.connect(
            servers.map((s) => ({
              ...s,
              config: {
                handshakeTimeoutMs: config.mcp.connectTimeoutSeconds * 1000,
                callTimeoutMs: config.mcp.callTimeoutSeconds * 1000,
                ...s.config,
              },
            })),
            options.signal,
          )
        }
      }

      // --- Preparing the context: with tool results, compacted ---
      const lastUser = lastUserIndex(messages)
      if (lastUser < 0) {
        emit({ kind: 'error', message: 'No user message found to send' })
        return
      }
      const prompt = attachmentNote(
        messages[lastUser]!.text,
        messages[lastUser]!.attachments,
      )

      // The last user message is handed to `prompt()` — it must not be
      // repeated in the history. The messages AFTER it (a cancelled reply)
      // stay in the history.
      const historyMessages = [...messages.slice(0, lastUser), ...messages.slice(lastUser + 1)]

      let context = buildContext(historyMessages)
      context = truncateToolResults(context, config.agent.history.toolResultLimit)

      // Compaction: summarising with the LLM first, and hard trimming if that
      // does not work. Without either, a long conversation stops fitting in
      // the context window and the session breaks entirely.
      if (needsCompaction(context, model.contextWindow, config.agent.compaction)) {
        const previous = contextTokens(context)
        const result = await compact(
          context,
          models,
          compactionModel(models, model, config),
          config.agent.compaction,
          options.signal,
        )
        if (result.status === 'compacted') {
          context = result.messages
          emit({
            kind: 'compacted',
            previousTokens: result.previousTokens,
            newTokens: contextTokens(context),
          })
        } else if (result.status === 'failed') {
          // Summarising did not work — we fall back to hard trimming. Context
          // is lost, but the session keeps working (the alternative being the
          // request failing with a context window error).
          context = dropOldest(context, Math.floor(config.agent.history.maxMessages / 2))
          emit({ kind: 'compacted', previousTokens: previous, newTokens: contextTokens(context) })
        }
      }

      // The hard limit is applied in any case — even when compaction is off
      context = dropOldest(context, config.agent.history.maxMessages)

      // --- The hook chain ---
      const hooks: ToolHook[] = [
        extraDenyHook(config.permission.extraDenyList),
        redactSecretsHook(),
        lengthHook(config.agent.history.toolResultLimit),
        ...(options.hooks ?? []),
      ]
      const hookContext = { workDir: options.workDir, sessionId: options.sessionId }

      // The AGENTS.md / CLAUDE.md in the working directory — extra
      // instructions for the agent. Does not go to the classifier (see
      // project-context.ts).
      const projectContext = readProjectContext(options.workDir)

      // The list of installed skills (`.barpo/skills/`). The server
      // prepares the directory at the start of the session — here we only
      // read it.
      const skills = skillsToPrompt(readSkills(options.workDir))

      // The project memory (`.barpo/memory/`) — the agent's own notes.
      // Unlike the skills, nobody syncs them: the files just live there. Does
      // not go to the classifier (see `memory.ts`).
      //
      // The index (`MEMORY.md`) goes in IN FULL, the memory files only as
      // name+description. The two complement each other: the index is the
      // agent's own roadmap, the listing is the full catalogue built by the
      // machine.
      const memory = memoriesToPrompt(
        readMemories(options.workDir),
        options.workDir,
        readMemoryIndex(options.workDir),
      )

      // The tool list is built once and the prompt flags are DERIVED FROM IT:
      // `serverList` may well be turned off in the config, and in that case
      // the prompt must not mention it. If we computed the two separately they
      // would drift apart and produce "instructions about a tool that is not
      // there".
      const tools = prepareTools(
        toolContext,
        config.agent.tools.enabled,
        options.serverProvider,
        options.dashboardSink,
        mcpManager,
        options.dashboardRemover,
        options.permission,
        options.scheduleSink,
        options.scheduleLister,
        options.scheduleRemover,
        // The manager comes from the per-session registry, NOT from the
        // stream: a dev server must survive the turn that started it, so
        // `cleanup()` below deliberately never touches it (see the lifecycle
        // note in `process-manager.ts`).
        processManager(options.sessionId),
      )
      const hasServers = tools.some((t) => t.name === 'serverList')
      const hasDashboard = tools.some((t) => t.name === 'appPublish')
      // Any one of the three is enough for the prompt section: a caller that
      // offers only `scheduleList` still needs the agent to know schedules
      // exist, otherwise it will never look.
      const hasSchedules = tools.some((t) => t.name.startsWith('schedule'))
      // `processStart` is the anchor: the other three only make sense once
      // starting is possible, and they are declared together.
      const hasProcesses = tools.some((t) => t.name === 'processStart')
      // The MCP tools are dynamic — we do not know their names in advance, so
      // we check by prefix. If there is not a single one, the prompt DOES NOT
      // mention MCP.
      const hasMcp = tools.some((t) => isMcpTool(t.name))

      const agent = new Agent({
        initialState: {
          systemPrompt: AGENT_SYSTEM_PROMPT(
            options.workDir,
            projectContext ? contextToPrompt(projectContext) : undefined,
            skills ?? undefined,
            memory,
            hasServers,
            hasDashboard,
            hasMcp,
            hasSchedules,
            hasProcesses,
          ),
          model,
          tools,
          messages: context,
        },
        streamFn: models.streamSimple.bind(models),
        sessionId: options.sessionId,
        // In testing, parallel mode led to a race condition (write/read)
        toolExecution: 'sequential',
        beforeToolCall: async ({ toolCall, args }) => {
          options.toolObserver?.(toolCall.name, args)
          // Hooks can impose ADDITIONAL restrictions. The core safety (the
          // hard denies, the working directory boundary, the classifier) runs
          // in the environment layer and earlier than this — a hook cannot
          // override it.
          const verdict = await beforeChain(hooks, {
            ...hookContext,
            name: toolCall.name,
            args,
          })
          if (verdict?.block) return { block: true, reason: verdict.reason }
          return undefined
        },
        afterToolCall: async ({ toolCall, args, result, isError }) => {
          const raw = resultText(result)
          const updated = await afterChain(hooks, {
            ...hookContext,
            name: toolCall.name,
            args,
            result: raw,
            isError,
          })
          if (updated.result === raw && updated.isError === isError) return undefined
          // The TEXT blocks are replaced, THE REST ARE KEPT.
          //
          // `content` used to be replaced wholesale with `[{type:'text'}]`,
          // and that DESTROYED THE IMAGE: when the `read` tool reads an image
          // file it returns `[{type:'text'}, {type:'image'}]`, while the hooks
          // (`lengthHook`, `redactSecretsHook`) run over almost every result.
          // The upshot was that the model never saw the image — silently, with
          // no error message. An attached image comes down exactly this path.
          //
          // Hooks only work with TEXT (`hooks.ts`: `result: string`), so
          // putting what they changed back into the text block is correct —
          // the image never came before them.
          return {
            content: [
              { type: 'text', text: updated.result },
              ...nonTextBlocks(result),
            ],
            isError: updated.isError,
          }
        },
      })

      agent.subscribe((event: PiAgentEvent) => {
        switch (event.type) {
          case 'message_update':
            if (event.assistantMessageEvent.type === 'text_delta') {
              emit({ kind: 'delta', text: event.assistantMessageEvent.delta })
            }
            break

          case 'tool_execution_start':
            emit({
              kind: 'tool_start',
              id: event.toolCallId,
              name: event.toolName,
              args: argsText(event.toolName, event.args),
            })
            break

          case 'tool_execution_update': {
            const text = resultText(event.partialResult)
            if (text) emit({ kind: 'tool_update', id: event.toolCallId, text })
            break
          }

          case 'tool_execution_end':
            emit({
              kind: 'tool_end',
              id: event.toolCallId,
              result: truncate(resultText(event.result)),
              isError: event.isError,
              detail: extractDetails(event.result),
            })
            break

          default:
            break
        }
      })

      // The prompt and the history were separated above.
      //
      // NOTE: checking "is the last element of the array a user message" is
      // NOT ENOUGH. The history may end with an `assistant` — the following
      // RACE CONDITION really does happen:
      //   1) the user sent a message, the stream is running;
      //   2) they hit "Stop" and immediately sent a new message;
      //   3) `streamReply` aborts the old stream and writes the NEW user
      //      message to the database;
      //   4) the aborted old stream then saves its own reply in `finally`
      //      ("⚠︎ Javob to'liq kelmadi: So'rov bekor qilindi") — that is,
      //      AFTER the new user message.
      // The history ends up as `... user, assistant` and the earlier code
      // SILENTLY lost the user's message with a 'No user message found to
      // send' error. That is why we look for the last USER message and leave
      // the ones after it in the history.

      // `prompt()` takes no signal — cancellation goes through `abort()`
      const cancel = () => agent.abort()
      options.signal?.addEventListener('abort', cancel, { once: true })
      try {
        await agent.prompt(prompt)
      } finally {
        options.signal?.removeEventListener('abort', cancel)
      }

      if (options.signal?.aborted) {
        emit({ kind: 'error', message: 'The request was cancelled' })
        return
      }

      // A provider error does not escape `prompt()` — it ends up written into
      // the last assistant message (see the note on `streamError`). Without
      // the check, an empty reply would pass for "success".
      const providerError = streamError(agent.state.messages)
      if (providerError) {
        emit({ kind: 'error', message: providerError })
        return
      }

      const text = collectedText(agent)
      emit({
        kind: 'done',
        text,
        usage: calculateUsage(agent),
        // The full context — with tool results. The caller stores this and
        // passes it back on the next turn, so the agent does not lose its
        // memory.
        messages: agent.state.messages,
        contextTokens: contextTokens(agent.state.messages),
      })
    } catch (error) {
      emit({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      cleanup()
      state.done = true
      state.wake?.()
    }
  })()

  // Turning the queue into a stream
  try {
    while (true) {
      while (state.queue.length > 0) {
        yield state.queue.shift()!
      }
      if (state.done) break
      await new Promise<void>((r) => {
        state.wake = () => {
          state.wake = undefined
          r()
        }
      })
    }
  } finally {
    cleanup()
    await run.catch(() => undefined)
  }
}

/** Attaches the restricted environment context to the tools */
function prepareTools(
  context: { env: RestrictedEnv },
  enabled: readonly string[],
  serverProvider?: ServerProvider,
  dashboardSink?: DashboardSink,
  mcpManager?: McpManager,
  dashboardRemover?: DashboardRemover,
  permission?: PermissionManager,
  scheduleSink?: ScheduleSink,
  scheduleLister?: ScheduleLister,
  scheduleRemover?: ScheduleRemover,
  processes?: ProcessManager,
): AgentTool<never>[] {
  // pi's ready-made tools + our own search and server tools. They all take the
  // context as their last argument, so the wrapper below applies to them
  // uniformly (`serverList` does not use the context, but it follows the same
  // shape).
  const all = [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createBashTool(),
    ...searchToolsRaw(),
    ...serverToolsRaw(serverProvider),
    ...dashboardToolsRaw(dashboardSink, dashboardRemover, permission),
    ...scheduleToolsRaw(scheduleSink, scheduleLister, scheduleRemover, permission),
    ...processToolsRaw(processes, permission),
  ]

  // A tool disabled in the config is NOT DECLARED AT ALL — the agent does not
  // know it exists. That is better than "I will refuse if you call it": the
  // model does not waste time repeatedly trying a capability that is not
  // there.
  const allowed = new Set(enabled)
  const core = all.filter((tool) => allowed.has(tool.name))

  // The MCP tools DO NOT GO THROUGH THE FILTER ABOVE — they are not in the
  // static list and their names are determined per session (see
  // `mcp-tools.ts`). Installation is the control here: if no server is
  // installed, no manager is created at all and this list is empty.
  const withMcp = [...core, ...mcpToolsRaw(mcpManager)]

  return withMcp.map((tool) => ({
    ...tool,
    execute: (toolCallId: string, params: never, signal?: AbortSignal, onUpdate?: never) =>
      // pi-agent-core's AgentHarnessTool takes the context as its last
      // argument; AgentTool does not. We attach it here.
      (tool.execute as unknown as (
        id: string,
        p: unknown,
        s: AbortSignal | undefined,
        u: unknown,
        c: unknown,
      ) => Promise<unknown>)(toolCallId, params, signal, onUpdate, context),
  })) as unknown as AgentTool<never>[]
}

/**
 * Appends the note about attached files to the prompt text.
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ WHY THE NOTE IS NOT WRITTEN TO `chat_messages.text`. The classifier   │
 * │ takes exactly that `text` (`orchestrator.ts`:                         │
 * │ `klassifikatorTarixiniTayyorla`). If a file name landed there it      │
 * │ would be an INJECTION VECTOR affecting the permission decision: the   │
 * │ user (or a file sent by a third party) could get a message through to │
 * │ the classifier via its name.                                          │
 * │                                                                       │
 * │ The name is already sanitised (`workdir.ts`: `uploadName`), but this  │
 * │ layer follows the two-layer defence rule: if one defence is breached, │
 * │ the other still holds.                                                │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * The note lands in `agent.state.messages`, which means it is written to the
 * database as `agentMessages` and the agent remembers the file on the next
 * turn. The classifier never sees `agentMessages` — the boundary stays where
 * it is.
 *
 * AN IMAGE IS A FILE TOO: it is not passed along as base64; the agent reads it
 * itself with `read` and sees it then. This is the path pi's interactive mode
 * takes and it gives two benefits: one code path for files, and the image
 * enters the context only when the agent wants it to.
 */
export function attachmentNote(
  text: string,
  attachments?: MessageAttachment[],
): string {
  if (!attachments?.length) return text

  const hasImage = attachments.some((a) => a.kind === 'image')
  const lines = attachments.map((a) => `- ${a.path}`)

  const heading =
    attachments.length === 1
      ? `The user attached one ${attachments[0]!.kind === 'image' ? 'image' : 'file'} to this message:`
      : 'The user attached these files to this message:'

  // The instruction is IN ENGLISH — so is the system prompt
  // (`AGENT_SYSTEM_PROMPT`). The reply language is detected from the user's
  // language, while instructions are given to the model in English.
  const hint = hasImage
    ? 'Use the `read` tool on a path above when you need its contents. Reading an image path shows you the image itself.'
    : 'Use the `read` tool on a path above when you need its contents.'

  return `${text}\n\n<attachments>\n${heading}\n${lines.join('\n')}\n\n${hint}\n</attachments>`
}

/**
 * The index of the last `user` message, or -1 if there is none.
 *
 * That is exactly the message handed to `prompt()`. In the ordinary case it is
 * the last element of the array, but not always — see the note on the race
 * condition above.
 */
export function lastUserIndex(messages: { role: 'user' | 'assistant' }[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return i
  }
  return -1
}

/**
 * Extracts a TEXT-ONLY history from the stored messages.
 *
 * Used for the classifier: `agentMessages` (where the tool results live) is
 * dropped deliberately. If the caller supplied its own text history this
 * function is not needed — and then there are two layers of defence.
 */
function textHistory(messages: StoredMessage[]): ConversationMessage[] {
  return messages
    .filter((x) => x.text.trim().length > 0)
    .map((x) => ({ role: x.role, text: x.text }))
}

/**
 * Picks the model used for compaction.
 *
 * By default THE MAIN CHAT MODEL is used. The reason: the quality of the
 * summary directly affects the agent's subsequent work — a bad summary leads
 * quietly to wrong behaviour and the user does not notice it right away.
 * Saving money with a cheap model is not worth that risk.
 *
 * If `agent.compaction.model` is set in the config, that one is used; if it is
 * not found we fall back to the main model (we do not throw — better to
 * compact with the main model than not to compact at all).
 */
function compactionModel(models: Models, main: Model<Api>, config: Config): Model<Api> {
  const selected = config.agent.compaction.model
  if (!selected) return main
  const [provider, ...rest] = selected.split('/')
  const model = rest.join('/')
  if (!provider || !model) return main
  return models.getModel(provider, model) ?? main
}

/** Squeezes the tool arguments onto a single line for the UI */
function argsText(name: string, args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const a = args as Record<string, unknown>
  if (name === 'bash' || name === 'processStart') {
    return typeof a.command === 'string' ? a.command : ''
  }
  if (name === 'processOutput' || name === 'processStop') {
    return typeof a.id === 'string' ? a.id : ''
  }
  if (typeof a.path === 'string') {
    if (name === 'edit' && Array.isArray(a.edits)) return `${a.path} (${a.edits.length} changes)`
    return a.path
  }
  return JSON.stringify(args).slice(0, 200)
}

/**
 * The NON-TEXT blocks in a tool result (so far only `image`).
 *
 * The hook chain works with text, but the result may hold other blocks too —
 * and those have to stay in place after the hooks as well (see the note on
 * `afterToolCall`).
 */
export function nonTextBlocks(result: unknown): ImageContent[] {
  if (!result || typeof result !== 'object') return []
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return []
  // We pick the `image` block EXPLICITLY, not by negation as "not text": if pi
  // adds a new block kind in the future, it must not slip through to the
  // provider unchecked.
  return content.filter(
    (b): b is ImageContent => (b as { type?: string } | null)?.type === 'image',
  )
}

function resultText(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result ?? '')
  const r = result as { content?: { type?: string; text?: string }[] }
  if (!Array.isArray(r.content)) return ''
  return r.content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
}

function extractDetails(result: unknown): { diff?: string; truncated?: boolean } | undefined {
  if (!result || typeof result !== 'object') return undefined
  const d = (result as { details?: unknown }).details
  if (!d || typeof d !== 'object') return undefined
  const details = d as { diff?: unknown; truncation?: { truncated?: unknown } }
  const resultDetails: { diff?: string; truncated?: boolean } = {}
  if (typeof details.diff === 'string') resultDetails.diff = details.diff
  if (details.truncation?.truncated === true) resultDetails.truncated = true
  return Object.keys(resultDetails).length > 0 ? resultDetails : undefined
}

function truncate(text: string): string {
  if (text.length <= RESULT_LIMIT) return text
  return `${text.slice(0, RESULT_LIMIT)}\n… (${text.length - RESULT_LIMIT} characters truncated)`
}

/** Collects the last assistant text once the agent has finished */
function collectedText(agent: Agent): string {
  const messages = agent.state.messages
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const x = messages[i]
    if (x?.role !== 'assistant') continue
    const text = (x.content as { type?: string; text?: string }[])
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('')
    if (text.trim()) return text
  }
  return ''
}

/** Sums the usage across all assistant messages */
function calculateUsage(agent: Agent): Usage {
  let input = 0
  let output = 0
  let cost = 0
  for (const x of agent.state.messages) {
    if (x.role !== 'assistant') continue
    const usage = (x as { usage?: { input?: number; output?: number; cost?: { total?: number } } }).usage
    input += usage?.input ?? 0
    output += usage?.output ?? 0
    cost += usage?.cost?.total ?? 0
  }
  return { input, output, cost }
}

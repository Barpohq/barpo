// Config schema — the single source of truth.
//
// This file defines three things IN ONE PLACE:
//   1) the TypeScript types (for code),
//   2) the default values (what runs when there is no file),
//   3) the field descriptions and limits (to build the web UI form).
//
// Why all three together? If they drift apart they inevitably stop matching:
// the type changes, the default stays old, and the UI shows a third thing.
// Here, adding a field = writing in one place.
//
// The JSON Schema (`schema.json`) is generated from `FIELDS` — editors
// (VS Code) then give the user autocompletion.
// Generate with: `bun run platform-config/src/schema-write.ts`.

/** Kind of a field — validation and the UI widget are chosen from it */
export type FieldKind = 'number' | 'text' | 'boolean' | 'select' | 'stringList'

/**
 * Definition of a single settings field.
 *
 * `path` — a dot-separated path (`agent.history.maxMessages`). The web UI
 * reads and writes the value by that path, so the form structure mirrors
 * the config structure.
 */
export interface FieldSpec {
  path: string
  kind: FieldKind
  /** Value used when there is no file, or the field is not specified */
  default: unknown
  /** Explanation shown to the user (in the UI and in the JSON Schema) */
  hint: string
  /** Limits for `number` — for validation and for the UI slider/input */
  range?: { min?: number; max?: number }
  /** Possible values for `select` */
  options?: readonly string[]
  /**
   * Whether the field value may be `null`.
   * `null` usually means "automatic / unlimited" (for example, when the
   * compaction model is `null` the main chat model is used).
   */
  nullable?: boolean
}

/**
 * All settings. The order here is the order shown in the UI.
 *
 * Adding a new setting: one row in this list + a matching field on the
 * `Config` type. Nothing else has to change — reading, validation, the
 * default value and the JSON Schema all follow automatically.
 */
export const FIELDS = [
  // --- Agent: context and history ---
  {
    path: 'agent.history.maxMessages',
    kind: 'number',
    default: 200,
    hint: 'Maximum number of messages sent to the LLM. Older ones are dropped (compacted first if compaction is enabled).',
    range: { min: 10, max: 5000 },
  },
  {
    path: 'agent.history.toolResultLimit',
    kind: 'number',
    default: 4000,
    hint: 'Maximum length (characters) of a single tool result stored in history, so long `read`/`bash` output does not swamp the context.',
    range: { min: 200, max: 100_000 },
  },

  // --- Agent: context compaction ---
  {
    path: 'agent.compaction.enabled',
    kind: 'boolean',
    default: true,
    hint: 'Automatically compact history when the context fills up. If disabled, a long conversation stops fitting in the context window.',
  },
  {
    path: 'agent.compaction.reserveTokens',
    kind: 'number',
    default: 16_384,
    hint: 'Part of the context window reserved for the summary prompt and the response. Compaction starts once the context exceeds (window - reserve).',
    range: { min: 1000, max: 200_000 },
  },
  {
    path: 'agent.compaction.keptTokens',
    kind: 'number',
    default: 20_000,
    hint: 'How much of the most recent context is kept verbatim after compaction. A larger value keeps recent history more precise but makes compaction less effective.',
    range: { min: 1000, max: 200_000 },
  },
  {
    path: 'agent.compaction.model',
    kind: 'text',
    default: null,
    nullable: true,
    hint: 'Model used for compaction, as `provider/model`. When `null` the main chat model is used (summary quality matters, hence the default).',
  },

  // --- Agent: tools ---
  {
    path: 'agent.tools.enabled',
    kind: 'stringList',
    default: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'serverList', 'appPublish'],
    hint: 'Tools given to the agent. A tool removed from the list is invisible — the agent does not know it exists.',
  },
  {
    path: 'agent.tools.bashTimeoutSeconds',
    kind: 'number',
    default: 120,
    hint: 'Maximum run time for a single `bash` command. Waiting forever would freeze the web session.',
    range: { min: 1, max: 3600 },
  },
  {
    path: 'agent.tools.resultLimit',
    kind: 'number',
    default: 2000,
    hint: 'Maximum length (characters) of a tool result sent to the UI. The limit for what is stored in history is configured separately.',
    range: { min: 200, max: 50_000 },
  },

  // --- Permissions and security ---
  {
    path: 'permission.mode',
    kind: 'select',
    default: 'confirm',
    options: ['confirm', 'auto'],
    hint: 'Initial permission mode for a new session. `confirm` asks about every dangerous action; `auto` lets the classifier decide.',
  },
  {
    path: 'permission.waitSeconds',
    kind: 'number',
    default: 300,
    hint: 'How long to wait for an answer to a permission request. On timeout the request is DENIED, so the agent does not hang forever.',
    range: { min: 10, max: 3600 },
  },
  {
    path: 'permission.classifierModel',
    kind: 'text',
    default: null,
    nullable: true,
    hint: 'Model for the auto-mode classifier, as `provider/model`. When `null` it is chosen automatically (fast, proven models first).',
  },
  {
    path: 'permission.consecutiveBlockLimit',
    kind: 'number',
    default: 3,
    hint: 'Auto mode turns off after the classifier blocks this many actions in a row — the agent may be going beyond what was asked.',
    range: { min: 1, max: 100 },
  },
  {
    path: 'permission.totalBlockLimit',
    kind: 'number',
    default: 20,
    hint: 'Auto mode turns off after this many blocks in total during a session.',
    range: { min: 1, max: 1000 },
  },
  {
    path: 'permission.extraDenyList',
    kind: 'stringList',
    default: [],
    hint: 'Additional forbidden command names. They are ADDED to the built-in hard block list, never replace it — the security boundary cannot be lowered.',
  },

  // --- Session ---
  {
    path: 'session.workDir',
    kind: 'text',
    default: null,
    nullable: true,
    hint: 'Root directory the agent tools work in. When `null`, `~/.platforma/ishlar/` is used.',
  },
  {
    path: 'session.idleMinutes',
    kind: 'number',
    default: 60,
    hint: 'In-memory resources of a session idle for this long (permission state, mode) are cleaned up. The conversation history stays in the database.',
    range: { min: 1, max: 10_080 },
  },

  // --- MCP servers ---
  //
  // There is DELIBERATELY no "MCP enabled/disabled" flag: control lives in
  // installation. If no server is installed the MCP layer never starts at
  // all — no tool is declared and the prompt does not mention it (see the
  // comment in `platform-ai/src/mcp-tools.ts`). With a flag the user could
  // install a server and then be left wondering "why is it not working".
  {
    path: 'mcp.connectTimeoutSeconds',
    kind: 'number',
    default: 10,
    hint: 'Maximum wait for the MCP server handshake. If the server does not respond the session continues — only that server is unavailable.',
    range: { min: 1, max: 60 },
  },
  {
    path: 'mcp.callTimeoutSeconds',
    kind: 'number',
    default: 30,
    hint: 'Maximum wait for a single MCP tool call.',
    range: { min: 1, max: 300 },
  },

  // --- Files attached to a chat ---
  //
  // There is no SEPARATE limit for images: an image sits on disk like any
  // other file and is not passed to the LLM as base64 — the agent reads it
  // itself with `read`. So a large image does not press on the context
  // directly; `agent.history.toolResultLimit` then reins it in after the read.
  {
    path: 'chat.attachment.maxFileMb',
    kind: 'number',
    default: 20,
    hint: 'Maximum size (MB) of a single file attached to a chat.',
    range: { min: 1, max: 200 },
  },
  {
    path: 'chat.attachment.maxCount',
    kind: 'number',
    default: 10,
    hint: 'Maximum number of files attached to a single message.',
    range: { min: 1, max: 50 },
  },
] as const satisfies readonly FieldSpec[]

// ---------------------------------------------------------------------------
// The Config type
// ---------------------------------------------------------------------------

/**
 * The platform's full settings.
 *
 * Kept in sync with `FIELDS` by hand — `validate.test.ts` checks that the two
 * match, so you cannot change one and forget the other.
 */
export interface Config {
  agent: {
    history: {
      maxMessages: number
      toolResultLimit: number
    }
    compaction: {
      enabled: boolean
      reserveTokens: number
      keptTokens: number
      /** `provider/model`, or null (the main chat model) */
      model: string | null
    }
    tools: {
      enabled: string[]
      bashTimeoutSeconds: number
      resultLimit: number
    }
  }
  permission: {
    mode: 'confirm' | 'auto'
    waitSeconds: number
    /** `provider/model`, or null (chosen automatically) */
    classifierModel: string | null
    consecutiveBlockLimit: number
    totalBlockLimit: number
    extraDenyList: string[]
  }
  session: {
    /** Directory path, or null (`~/.platforma/ishlar/`) */
    workDir: string | null
    idleMinutes: number
  }
  mcp: {
    connectTimeoutSeconds: number
    callTimeoutSeconds: number
  }
  chat: {
    attachment: {
      maxFileMb: number
      maxCount: number
    }
  }
}

/** A partial config — used in files and when merging */
export type PartialConfig = {
  [K in keyof Config]?: {
    [P in keyof Config[K]]?: Config[K][P]
  }
}

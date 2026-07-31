// The `grep`, `find` and `ls` tools — they let the agent search for files.
//
// WHY A SEPARATE TOOL, ISN'T `bash` ENOUGH?
// It is enough, but expensive. Searching through `bash` goes through
// `command-analysis.ts` and asks for permission in many cases — for example
// when the pattern contains `/`, or when the command is not on the
// allowlist. But searching for files is BY NATURE a read operation: it
// changes nothing. Waking the user for every `grep` is "permission
// fatigue", meaning the user learns to press "yes" without thinking and
// waves through a GENUINELY dangerous request too.
//
// That is why these three tools ask for no permission — BUT only INSIDE the
// working directory. If a path outside it is requested, an error comes back
// (`BoundaryError`), because these tools never look outside. If the user
// really does want to search outside, `bash` is there — the permission
// mechanism works fully over there.
//
// The security chain:
//   grep/find/ls → checkBoundary (textual path + realpath)
//                → inside?  → it runs
//                → outside? → BoundaryError (NO permission is requested)
//
// The paths that come out are ALWAYS relative to the working directory — an
// absolute path is never disclosed.

import { Type, type Static } from 'typebox'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import {
  FIND_LIMIT,
  GREP_LIMIT,
  LS_LIMIT,
  ROW_LIMIT,
  type GrepMatch,
  type DirEntry,
  type SearchResult,
} from './search-core.ts'
import { findSearch, grepSearch, lsList } from './search-engine.ts'

// ---------------------------------------------------------------------------
// Tool shape
// ---------------------------------------------------------------------------

/**
 * The `AgentHarnessTool` shape from `pi-agent-core`.
 *
 * Repeated here instead of importing the ready-made type from the package,
 * because `AgentHarnessTool` lives inside `dist/harness/types.ts` and is not
 * on the package's public `exports` surface. Having the same shape is
 * sufficient — we know how `prepareTools()` in `agent.ts` calls it: the
 * context is passed as the LAST argument.
 */
export interface SearchTool<TParams = unknown, TDetail = SearchDetail | undefined> {
  name: string
  label: string
  description: string
  parameters: unknown
  execute(
    toolCallId: string,
    params: TParams,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: { env: { cwd: string } },
  ): Promise<AgentToolResult<TDetail>>
}

/** Detail for the UI and the logs — which backend ran, and was it truncated */
export interface SearchDetail {
  backend: 'rg' | 'node'
  /** Number of items found (after truncation) */
  count: number
  truncated: boolean
}

/** Wraps text into the tool result shape */
function result(text: string, detail: SearchDetail): AgentToolResult<SearchDetail> {
  return { content: [{ type: 'text', text: text }], details: detail }
}

/**
 * The warning appended when the result is truncated.
 *
 * This is stated EXPLICITLY on purpose: the agent must not assume the result
 * is complete and draw the wrong conclusion that "this is not in the file".
 * The model is also told what to do (narrow the pattern), otherwise it
 * simply retries.
 */
function truncationWarning(shown: number, what: string): string {
  return `\n\n[Results were capped at ${shown} ${what} — there are more. Narrow the pattern or pass a more specific \`path\` folder.]`
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

const grepSchema = Type.Object({
  pattern: Type.String({
    description:
      'Regular expression to search for. JavaScript regex syntax (lookahead/lookbehind supported).',
  }),
  path: Type.Optional(
    Type.String({
      description:
        'Directory or file to search in, relative to the working directory. Defaults to the working directory.',
    }),
  ),
  glob: Type.Optional(
    Type.String({
      description:
        "Only search files whose name matches this glob, e.g. '*.ts' or 'src/**/*.tsx'.",
    }),
  ),
  caseInsensitive: Type.Optional(
    Type.Boolean({ description: 'Ignore case when matching. Default: false.' }),
  ),
  all: Type.Optional(
    Type.Boolean({
      description:
        'Also search normally-skipped directories (.git, node_modules, dist, ...). Default: false.',
    }),
  ),
})

export type GrepToolInput = Static<typeof grepSchema>

/** Turns a grep result into `file:line:text` lines */
export function grepResultToText(result: SearchResult<GrepMatch>): string {
  if (result.items.length === 0) return 'No matches found.'
  const lines = result.items.map((m) => `${m.path}:${m.line}:${m.text}`)
  let text = lines.join('\n')
  if (result.truncated) text += truncationWarning(result.items.length, 'matches')
  return text
}

export function createGrepTool(): SearchTool<GrepToolInput> {
  return {
    name: 'grep',
    label: 'grep',
    description: [
      'Search file contents with a regular expression. Returns matching lines as `path:line:text`.',
      `Long lines are cut to ${ROW_LIMIT} characters and results are capped at ${GREP_LIMIT} matches.`,
      'Only searches inside the working directory; paths outside it are rejected.',
      '.git, node_modules, dist and similar directories are skipped unless `all` is set.',
      'Prefer this over running grep/rg through bash — it is faster and needs no permission prompt.',
    ].join(' '),
    parameters: grepSchema,
    async execute(_id, params, signal, _onUpdate, context) {
      const found = await grepSearch({
        workDir: context.env.cwd,
        pattern: params.pattern,
        path: params.path,
        glob: params.glob,
        caseInsensitive: params.caseInsensitive,
        all: params.all,
        signal,
      })
      return result(grepResultToText(found), {
        backend: found.backend,
        count: found.items.length,
        truncated: found.truncated,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

const findSchema = Type.Object({
  pattern: Type.String({
    description:
      "Glob pattern for file names, e.g. '*.ts', 'src/**/*.test.ts'. A pattern without '/' matches the file name at any depth.",
  }),
  path: Type.Optional(
    Type.String({
      description: 'Directory to search in, relative to the working directory.',
    }),
  ),
  all: Type.Optional(
    Type.Boolean({
      description:
        'Also search normally-skipped directories (.git, node_modules, dist, ...). Default: false.',
    }),
  ),
})

export type FindToolInput = Static<typeof findSchema>

export function findResultToText(result: SearchResult<string>): string {
  if (result.items.length === 0) return 'No files found.'
  let text = result.items.join('\n')
  if (result.truncated) text += truncationWarning(result.items.length, 'files')
  return text
}

export function createFindTool(): SearchTool<FindToolInput> {
  return {
    name: 'find',
    label: 'find',
    description: [
      'Find files by glob pattern. Returns paths relative to the working directory, one per line.',
      `Capped at ${FIND_LIMIT} files.`,
      'Only searches inside the working directory; paths outside it are rejected.',
      '.git, node_modules, dist and similar directories are skipped unless `all` is set.',
      'Prefer this over running find/fd through bash — it is faster and needs no permission prompt.',
    ].join(' '),
    parameters: findSchema,
    async execute(_id, params, signal, _onUpdate, context) {
      const found = await findSearch({
        workDir: context.env.cwd,
        pattern: params.pattern,
        path: params.path,
        all: params.all,
        signal,
      })
      return result(findResultToText(found), {
        backend: found.backend,
        count: found.items.length,
        truncated: found.truncated,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

const lsSchema = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        'Directory to list, relative to the working directory. Defaults to the working directory.',
    }),
  ),
  all: Type.Optional(
    Type.Boolean({
      description:
        'Also show normally-skipped directories (.git, node_modules, dist, ...). Default: false.',
    }),
  ),
})

export type LsToolInput = Static<typeof lsSchema>

/** Converts a byte count into a readable form */
export function sizeToText(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

export function lsResultToText(result: SearchResult<DirEntry>): string {
  if (result.items.length === 0) return 'The directory is empty.'
  const lines = result.items.map((e) => {
    // A directory ends with `/` and a symlink with `@` — the `ls -F`
    // convention. This shows the agent the kind at a glance, without an
    // extra column.
    if (e.kind === 'dir') return `${e.name}/`
    if (e.kind === 'symlink') return `${e.name}@`
    return e.size === undefined ? e.name : `${e.name}  (${sizeToText(e.size)})`
  })
  let text = lines.join('\n')
  if (result.truncated) text += truncationWarning(result.items.length, 'entries')
  return text
}

export function createLsTool(): SearchTool<LsToolInput> {
  return {
    name: 'ls',
    label: 'ls',
    description: [
      'List the contents of a directory. Directories end with `/`, symlinks with `@`, files show their size.',
      `Capped at ${LS_LIMIT} entries.`,
      'Only lists inside the working directory; paths outside it are rejected.',
      '.git, node_modules, dist and similar directories are hidden unless `all` is set.',
      'Prefer this over running ls through bash — it needs no permission prompt.',
    ].join(' '),
    parameters: lsSchema,
    async execute(_id, params, signal, _onUpdate, context) {
      const found = await lsList({
        workDir: context.env.cwd,
        path: params.path,
        all: params.all,
        signal,
      })
      return result(lsResultToText(found), {
        backend: found.backend,
        count: found.items.length,
        truncated: found.truncated,
      })
    },
  }
}

/**
 * All three search tools — WITHOUT the context bound.
 *
 * This is the lower-level shape: each tool expects `execute()` to be called
 * with a fifth argument (the context), just like pi's own tools. If
 * `agent.ts` puts them through the same wrapper as the pi tools, this is
 * what gets used.
 */
export function searchToolsRaw(): SearchTool<never>[] {
  return [createGrepTool(), createFindTool(), createLsTool()] as unknown as SearchTool<never>[]
}

/**
 * All three search tools — WITH the context bound.
 *
 * `prepareTools()` in `agent.ts` calls this one and hands the result
 * straight to `Agent`: the context is already inside, so `execute()` matches
 * pi's `AgentTool` shape (4 arguments).
 *
 * The tools take the working directory from `context.env.cwd`.
 * `RestrictedEnv` provides that field too, which is why the type is
 * deliberately not narrow — in a test it can be called with a plain
 * `{ env: { cwd } }` as well.
 *
 * IMPORTANT: these tools DO NOT USE `RestrictedEnv`'s file operations — they
 * walk the directory themselves (`rg` does the same). That is why the
 * boundary is applied independently via `checkBoundary()` in
 * `search-core.ts`, with logic identical to `RestrictedEnv.checkPath`:
 * textual path + `realpath`. Only `cwd` is taken from the environment.
 */
export function searchTools(context: { env: { cwd: string } }): AgentTool<never>[] {
  return searchToolsRaw().map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    execute: (toolCallId: string, params: never, signal?: AbortSignal, onUpdate?: never) =>
      tool.execute(toolCallId, params, signal, onUpdate, context),
  })) as unknown as AgentTool<never>[]
}

/**
 * The section appended to `AGENT_SYSTEM_PROMPT`.
 *
 * The prompt text sits IN THE SAME PLACE as the tools: when the tool's
 * behaviour changes (for example if the `all` flag is removed), the
 * description is updated in this same file. If it stayed in `agent.ts`, the
 * two would slowly drift apart — and the model would read about a feature
 * that does not exist and try to call it.
 *
 * It has two parts: the tool list lines, and the rules for how to use them.
 */
export const SEARCH_PROMPT_SECTION = {
  /** The lines appended to the tool list */
  list: [
    '- grep: search inside files with a regex (`file:line:text`)',
    '- find: locate files by glob',
    '- ls: list a directory',
  ],
  /** The instruction on how to use them */
  rules: [
    'To find files use `grep`/`find`/`ls`, NOT `bash` — they are faster and ask',
    'for no permission. Reach for `bash` only when nothing else will do. Those',
    'three tools work only inside the working directory and by default skip',
    '`.git`, `node_modules`, `dist` and similar (pass `all: true` to include',
    'them).',
  ],
} as const

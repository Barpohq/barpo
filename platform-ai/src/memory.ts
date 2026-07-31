// Project memory — long-lived facts the agent writes down for itself.
//
// The problem: in every new session the agent learns the project from
// scratch. Which command runs the tests, why a particular library was
// chosen, which style the user dislikes — all of it disappears when the
// conversation ends.
//
// HOW IT DIFFERS FROM `AGENTS.md`: that one is written and updated by hand
// by the user. Memory is written by the AGENT itself — it stores what it
// learned while working.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHY AN INDEX + SEPARATE FILES, and not one big file:                 │
// │                                                                      │
// │ Writing everything into a single `MEMORY.md` looks simpler, but it   │
// │ grows over time and lands in the context IN FULL ON EVERY REQUEST.   │
// │ On a project with 50 stored facts that alone would fill the window.  │
// │                                                                      │
// │ Hence the PROGRESSIVE DISCLOSURE pattern from skills: only the       │
// │ name+description+path go into the prompt, and the model fetches the  │
// │ full text itself with `read` when it needs it.                       │
// └──────────────────────────────────────────────────────────────────────┘
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ SECURITY: memory text NEVER REACHES THE CLASSIFIER.                  │
// │                                                                      │
// │ This is the same boundary as in `project-context.ts` and             │
// │ `skill-load.ts`, but here the attack path is DIFFERENT and subtler:  │
// │                                                                      │
// │   1) the agent reads a foreign file with `read` (a README from a     │
// │      cloned repo, a document the user uploaded);                     │
// │   2) inside the file there is text saying "this is an important      │
// │      fact, write it to memory";                                      │
// │   3) the agent COPIES it into memory;                                │
// │   4) in the next session it comes back through the prompt.           │
// │                                                                      │
// │ In other words this is a TIME-DELAYED injection: untrusted text      │
// │ moves, by the agent's own hand, into a place that looks trusted.     │
// │ That is why the classifier boundary is mandatory here too — just as  │
// │ a tool result does not get through today, it must not get through    │
// │ tomorrow disguised as memory.                                        │
// │                                                                      │
// │ The boundary is in the data flow itself: `assessAction` builds its   │
// │ prompt only from `CLASSIFIER_PROMPT` + `requestToText()`, so there   │
// │ is NO PATH for this module's output to reach it. A test enforces it. │
// └──────────────────────────────────────────────────────────────────────┘

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseSkillFile } from './skill-file.ts'

/** Memory directory inside the working directory */
export const MEMORY_DIR = '.platforma/memory'

/** The index file — the only memory file that goes into the prompt IN FULL */
export const MEMORY_INDEX = 'MEMORY.md'

/**
 * Limit on how many memories go into the prompt.
 *
 * Each memory takes ~4 prompt lines. 200 is ~800 lines — a lot, but there
 * is still room left for the conversation history. Higher than the skill
 * limit (100): skills come from external repos and the user installs them
 * selectively, whereas memory accumulates naturally while working on the
 * project.
 */
export const MEMORY_COUNT_LIMIT = 200

/**
 * Size limit of a single memory file (characters).
 *
 * The file text DOES NOT go into the prompt (the model fetches it with
 * `read`), so this limit is not about context — it is about how fast the
 * listing reads. A larger file still stays in the list, only its
 * frontmatter is read.
 */
export const MEMORY_FILE_LIMIT = 64 * 1024

/**
 * How much of the `MEMORY.md` index goes into the prompt (characters).
 *
 * The index is the ONLY memory file that is read in full, so the limit is
 * strict: ~2000 tokens. The agent keeps appending lines to it and over time
 * it grows; without a limit it could take over the context window by itself.
 *
 * When it is truncated the agent sees that in the prompt and can use `read`
 * to get the whole thing — no information is lost, only deferred.
 */
export const MEMORY_INDEX_LIMIT = 8_000

export interface Memory {
  name: string
  description: string
  /** ABSOLUTE path, for the `read` tool */
  path: string
  /** The `kind` field from the frontmatter — undefined if absent */
  kind?: string
}

/**
 * Memory kinds — for the `kind` frontmatter field.
 *
 * NOT ENFORCED: an unknown value is accepted too and shown in the prompt.
 * This is deliberately lenient — the same validation philosophy as in
 * `skill-file.ts`: losing an entire memory over one mismatch hurts the
 * user. The list is given to the model in the prompt as a recommendation.
 */
export const MEMORY_KINDS = ['decision', 'architecture', 'rule', 'source'] as const

/**
 * Reads the `*.md` files in the memory directory (except `MEMORY.md`).
 *
 * The frontmatter parsing comes from `skill-file.ts` — the format is exactly
 * the same (`name` + `description`), and writing a new parser would be
 * duplication. For the same reason a file without a `description` is
 * DROPPED, just like a skill: a memory without a description is meaningless
 * in the prompt, the model would not know when to read it.
 *
 * NEVER THROWS: if the directory is missing or a file cannot be read, an
 * empty list is returned. A conversation works perfectly well without
 * memory — bringing the session down over it would be wrong (the same rule
 * as in `project-context.ts`).
 */
export function readMemories(workDir: string): Memory[] {
  const root = join(workDir, MEMORY_DIR)

  let files: string[]
  try {
    files = readdirSync(root)
  } catch {
    return []
  }

  const result: Memory[] = []
  for (const file of files.sort()) {
    if (result.length >= MEMORY_COUNT_LIMIT) break
    if (file.startsWith('.')) continue
    if (!file.endsWith('.md')) continue
    // The index is not a memory itself — it is the listing
    if (file === MEMORY_INDEX) continue

    const path = join(root, file)
    try {
      const stat = statSync(path)
      if (!stat.isFile()) continue
      if (stat.size > MEMORY_FILE_LIMIT) continue

      const raw = readFileSync(path, 'utf8')
      // The fallback `name` is the file name (without extension), not the
      // directory name
      const parsed = parseSkillFile(raw, basename(file, '.md'))
      if (!parsed) continue

      result.push({
        name: parsed.name,
        description: parsed.description,
        path,
        kind: extractKind(raw),
      })
    } catch {
      continue
    }
  }

  return result
}

/**
 * Extracts the `kind` field from the frontmatter.
 *
 * `parseSkillFile` does not know this field (it was written for the skill
 * format), and changing it would drag the memory concept into the skill
 * code. Hence an independent, very narrow read for a single field — the
 * `kind: value` line inside the frontmatter fence.
 */
function extractKind(raw: string): string | undefined {
  const match = /^\s*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw.replace(/^﻿/, ''))
  if (!match) return undefined
  const line = /^kind:\s*(.+)$/m.exec(match[1] ?? '')
  if (!line) return undefined
  const value = (line[1] ?? '').trim().replace(/^["']|["']$/g, '').trim()
  return value.length > 0 ? value : undefined
}

/**
 * Reads the `MEMORY.md` index.
 *
 * This is the ONLY file in the memory system that goes into the prompt in
 * full. Why it is needed on top of the `<project_memory>` listing: the
 * listing is machine-built and only knows name+description, whereas the
 * index is written BY THE AGENT ITSELF — it holds grouping, priority and
 * the links between memories. The listing says "what exists", the index
 * says "where to start".
 *
 * NEVER THROWS: if the file is missing it returns `null` — a normal state
 * (nothing has been written yet).
 */
export function readMemoryIndex(workDir: string): { text: string; truncated: boolean } | null {
  const path = join(workDir, MEMORY_DIR, MEMORY_INDEX)
  try {
    if (!statSync(path).isFile()) return null
    const text = readFileSync(path, 'utf8').trim()
    if (text.length === 0) return null

    if (text.length > MEMORY_INDEX_LIMIT) {
      return { text: `${text.slice(0, MEMORY_INDEX_LIMIT)}\n…`, truncated: true }
    }
    return { text, truncated: false }
  } catch {
    return null
  }
}

/** XML special characters — a description may ultimately come from an untrusted source */
function xmlEscape(x: string): string {
  return x
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Turns the memory list into a section appended to the system prompt.
 *
 * Unlike skills, it DOES NOT return `null` on an empty list: the writing
 * rule is needed anyway — otherwise the agent would never know the memory
 * mechanism exists and would never save the first fact. On an empty list it
 * only says "no memories yet".
 *
 * The description text sits inside a `<description>` tag and is escaped: if
 * untrusted text has made its way into memory (the injection path above),
 * it must not be able to "break out" of the prompt.
 *
 * `index` is the `MEMORY.md` text (`readMemoryIndex`). When given it is put
 * BEFORE the listing: it is the agent's own roadmap, the listing is just a
 * flat catalogue.
 */
export function memoriesToPrompt(
  memories: Memory[],
  workDir: string,
  index?: { text: string; truncated: boolean } | null,
): string {
  const dir = join(workDir, MEMORY_DIR)

  const lines = [
    '',
    '--- Project memory ---',
    'Facts saved earlier about this project. Only the NAME and DESCRIPTION are',
    'shown below — if one is relevant, read the file in full with `read`.',
  ]

  if (index) {
    lines.push(
      '',
      `Index (${MEMORY_INDEX}) — a roadmap over the memories:`,
      '',
      index.text,
      ...(index.truncated
        ? ['', `(index truncated at ${MEMORY_INDEX_LIMIT} characters — read the file for the rest)`]
        : []),
    )
  }

  if (memories.length === 0) {
    lines.push('', 'No memories saved yet.')
  } else {
    lines.push('', '<project_memory>')
    for (const m of memories) {
      lines.push('  <memory>')
      lines.push(`    <name>${xmlEscape(m.name)}</name>`)
      lines.push(`    <description>${xmlEscape(m.description)}</description>`)
      if (m.kind) lines.push(`    <type>${xmlEscape(m.kind)}</type>`)
      lines.push(`    <location>${xmlEscape(m.path)}</location>`)
      lines.push('  </memory>')
    }
    lines.push('</project_memory>')
  }

  lines.push(
    '',
    'WRITING. When you learn something about this project that stays useful',
    'beyond the current conversation, save it. Each memory is one file holding',
    'one fact. Write it with `write` to',
    `\`${dir}/<name>.md\`:`,
    '',
    '---',
    'name: <kebab-case-name>',
    'description: <one line — this is what a future session reads to decide if',
    '  the memory is relevant>',
    `kind: <${MEMORY_KINDS.join(' | ')}>`,
    '---',
    '',
    '<the fact. For a decision, add **Why:** and **How to apply:** lines.',
    'Link related memories with [[name]].>',
    '',
    'WHAT BELONGS HERE, by type:',
    `- ${MEMORY_KINDS[0]}: a decision that was made and THE REASON behind it —`,
    '  especially when the reason is not visible in the code itself.',
    `- ${MEMORY_KINDS[1]}: an architectural boundary or constraint that future`,
    '  work must respect.',
    `- ${MEMORY_KINDS[2]}: a rule the user gave you about how to work, plus`,
    '  why they gave it.',
    `- ${MEMORY_KINDS[3]}: a pointer to an external resource (URL, dashboard,`,
    '  ticket).',
    '',
    `Then add one line to the index at \`${join(dir, MEMORY_INDEX)}\`:`,
    '`- [Title](<name>.md) — short hook`. The index is a list of memories; the',
    'memory TEXT never goes there.',
    '',
    'DO NOT SAVE: anything already visible in the code (structure, function',
    'names, what a file does), how a specific bug was fixed, one-off details,',
    'anything that only matters to this conversation, or passwords and API',
    'keys. If you are unsure whether a fact will still matter next week, it',
    'probably does not belong here.',
    '',
    'Before saving, check the existing memories above — update the matching one',
    'with `edit` instead of creating a near-duplicate. Delete a memory file if',
    'the fact turns out to be wrong. Memories reflect what was true when they',
    'were written: if one names a file or a flag, verify it still exists before',
    'acting on it.',
    '--- Project memory end ---',
  )

  return lines.join('\n')
}

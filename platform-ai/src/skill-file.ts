// Parsing `SKILL.md` — frontmatter + validation.
//
// The format (the Agent Skills spec, which pi uses too):
//
//   ---
//   name: pdf-fill
//   description: Fills in a PDF form
//   allowed-tools: [read, bash]
//   ---
//
//   # Instructions
//   ...
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHY OUR OWN PARSER: we only need 4 fields out of the frontmatter     │
// │ (name, description, license, allowed-tools) and all of them are      │
// │ either a string or a list of strings. Full YAML (anchors, multi-line │
// │ blocks, nested objects) is not used here.                            │
// │                                                                      │
// │ The `yaml` package is present in node_modules, but it is a TRANSITIVE│
// │ dependency of pi — we have not written it into package.json, which   │
// │ means it may quietly disappear if the pi version changes. For 60     │
// │ lines of code, writing it ourselves is better than adding a direct   │
// │ dependency: the behaviour is explicit and does not change.           │
// └──────────────────────────────────────────────────────────────────────┘
//
// VALIDATION IS DELIBERATELY LENIENT (as it is in pi). Only a missing
// `description` rejects the skill; every other violation comes back as a
// WARNING and the skill loads anyway. The reason: `anthropics/skills` and
// third-party repos may not match the spec exactly (name length, capital
// letters), and losing an entire repo over one small mismatch harms the user.

/** Spec limit — the name */
export const NAME_LIMIT = 64
/** Spec limit — the description. It lands in the prompt, hence the strictness. */
export const DESCRIPTION_LIMIT = 1024

export interface SkillFile {
  name: string
  description: string
  license?: string
  allowedTools?: string[]
  /** The text after the frontmatter — not stored for now, the model reads it itself */
  text: string
  /** Spec violations. The skill was loaded anyway. */
  warnings: string[]
}

/**
 * A MINIMAL YAML parse of the frontmatter.
 *
 * Supported: `key: value`, the `[a, b]` inline list, the `- item` block list,
 * the `|` / `>` block scalars (with `-`/`+` chomping), `"` and `'` quotes,
 * and `#` comments.
 * Not supported: nested objects, anchors. When those turn up the value stays a
 * raw string — it does not fall over.
 *
 * The block scalar is ESPECIALLY IMPORTANT: `claude-api` in
 * `anthropics/skills` uses exactly this shape (`description: |-`). Without it
 * the description would be the two characters `|-` — the skill would load, but
 * the model would not know when to use it.
 */
function parseFrontmatter(raw: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  const lines = raw.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    // Comments and empty lines. A nested field (one starting with whitespace)
    // is dropped too — every field we expect is at the top level.
    if (!line.trim() || line.trimStart().startsWith('#') || /^\s/.test(line)) continue

    const colon = line.indexOf(':')
    if (colon === -1) continue

    const key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()
    if (!key) continue

    // Block scalars: `|`, `|-`, `|+`, `>`, `>-`, `>+`
    //
    // `|` — the lines are kept, `>` — they are joined into one line (folded).
    // What we need is the description, which lands in the prompt as a single
    // paragraph, so both are joined at the empty-line boundary.
    const block = /^([|>])([-+]?)(\d*)$/.exec(value)
    if (block) {
      const folded = block[1] === '>'
      const blockLines: string[] = []

      // The block body — the indented lines up to the next TOP-LEVEL key.
      // An empty line belongs to the block too.
      while (i + 1 < lines.length) {
        const next = lines[i + 1] ?? ''
        if (next.trim() && !/^\s/.test(next)) break
        blockLines.push(next)
        i++
      }

      // We find the smallest indent and strip it. If the block is empty
      // `Math.min()` → Infinity, so we fall back to 0.
      const indents = blockLines
        .filter((l) => l.trim())
        .map((l) => l.length - l.trimStart().length)
      const indent = indents.length > 0 ? Math.min(...indents) : 0
      const cleaned = blockLines.map((l) => (l.trim() ? l.slice(indent) : ''))

      result[key] = folded
        ? // Folded: adjacent lines are joined with a space, and an empty line
          // becomes a paragraph boundary
          cleaned
            .join('\n')
            .split(/\n\s*\n/)
            .map((paragraph) => paragraph.split('\n').join(' ').trim())
            .filter(Boolean)
            .join('\n')
            .trim()
        : cleaned.join('\n').trim()
      continue
    }

    // The value is empty → the following lines may hold a block list
    if (!value) {
      const list: string[] = []
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1] ?? '')) {
        list.push(stripQuotes((lines[++i] ?? '').replace(/^\s*-\s+/, '').trim()))
      }
      if (list.length > 0) result[key] = list
      continue
    }

    // Inline list: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      result[key] = value
        .slice(1, -1)
        .split(',')
        .map((x) => stripQuotes(x.trim()))
        .filter((x) => x.length > 0)
      continue
    }

    // In an unquoted value `#` starts a comment — but only when preceded by
    // whitespace (otherwise a value such as `C#` would be corrupted)
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const comment = value.search(/\s#/)
      if (comment !== -1) value = value.slice(0, comment).trim()
    }

    result[key] = stripQuotes(value)
  }

  return result
}

function stripQuotes(x: string): string {
  if (x.length >= 2 && ((x.startsWith('"') && x.endsWith('"')) || (x.startsWith("'") && x.endsWith("'")))) {
    return x.slice(1, -1)
  }
  return x
}

function asString(v: string | string[] | undefined): string | undefined {
  if (typeof v === 'string') return v
  return undefined
}

/**
 * Parses the text of a `SKILL.md`.
 *
 * `folderName` — the fallback when the `name` field is missing (the spec says
 * so).
 *
 * `null` in EXACTLY one case: `description` is missing or empty. Without it
 * the skill is meaningless in the prompt — the model does not know when to
 * use it.
 */
export function parseSkillFile(rawText: string, folderName: string): SkillFile | null {
  const warnings: string[] = []

  // The frontmatter fence. Tolerant of a BOM and of leading empty lines.
  const text = rawText.replace(/^﻿/, '')
  const match = /^\s*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) return null

  const fields = parseFrontmatter(match[1] ?? '')
  const body = text.slice(match[0].length).trim()

  const description = asString(fields.description)?.trim()
  if (!description) return null

  let name = asString(fields.name)?.trim() || folderName

  // --- Validating the name (spec: [a-z0-9-]+, ≤64, no leading/trailing or
  // repeated `-`) ---
  if (name.length > NAME_LIMIT) {
    warnings.push(`name longer than ${NAME_LIMIT} characters — truncated`)
    name = name.slice(0, NAME_LIMIT)
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    warnings.push('name does not match the spec: only lowercase letters, digits and `-` are allowed')
  }
  if (name.startsWith('-') || name.endsWith('-') || name.includes('--')) {
    warnings.push('name has a leading, trailing or repeated `-` — does not match the spec')
  }

  // If the name differs from the folder name — the spec forbids it, but pi is
  // deliberately lenient about it (it gets in the way when a folder is shared
  // between several tools). We limit ourselves to a warning as well.
  if (asString(fields.name) && asString(fields.name)?.trim() !== folderName) {
    warnings.push(`name does not match the folder name (${folderName})`)
  }

  let fullDescription = description
  if (fullDescription.length > DESCRIPTION_LIMIT) {
    warnings.push(`description longer than ${DESCRIPTION_LIMIT} characters — truncated`)
    fullDescription = `${fullDescription.slice(0, DESCRIPTION_LIMIT)}…`
  }

  const rawAllowed = fields['allowed-tools']
  const allowedTools = Array.isArray(rawAllowed)
    ? rawAllowed
    : typeof rawAllowed === 'string' && rawAllowed.trim()
      ? rawAllowed.split(',').map((x) => x.trim()).filter(Boolean)
      : undefined

  return {
    name,
    description: fullDescription,
    license: asString(fields.license)?.trim() || undefined,
    allowedTools,
    text: body,
    warnings,
  }
}

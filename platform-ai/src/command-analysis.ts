// Analyses a bash command and decides whether permission is required.
//
// AN IMPORTANT LIMITATION: this is static analysis — a DEFENCE LAYER, NOT a
// sandbox. A sufficiently creative command can get around it, for example:
//   echo cm0gLXJm | base64 -d | sh
// For that reason:
//   1) unknown commands ask for permission too (a whitelist model),
//   2) "hiding tools" such as `sh`, `eval` and `base64` count as dangerous,
//   3) real isolation is added in the next stage with Docker (which is why the
//      ExecutionEnv interface was left swappable).
//
// THE NEXT STAGE: sending unknown commands to the AI classifier — "does this
// command match the user's intent?". The extension point is
// `CommandAnalysisOptions.unknownChecker`. For now, if it is not supplied, an
// unknown command asks for permission.

export type CommandCategory = 'forbidden' | 'safe' | 'dangerous' | 'unknown'

export interface CommandAssessment {
  category: CommandCategory
  /** The reason shown to the user when permission is requested */
  reason?: string
  /** The pattern remembered if "always allow" is chosen */
  pattern: string
}

/**
 * A HARD BAN — never executed automatically under any circumstances.
 *
 * This list overrides the classifier, the "always allow" pattern and auto mode
 * alike. The reason: every other defence is probabilistic (an LLM can be
 * fooled, a pattern can be bypassed), whereas this one is absolute.
 *
 * The list is deliberately SHORT: only irreversible actions that break the
 * whole system. Every extra entry raises the chance of blocking the user's
 * real work, so "possibly dangerous" things do not belong here — they live in
 * `DANGEROUS_COMMANDS` and are resolved by asking for permission.
 */
interface ForbiddenRule {
  pattern: RegExp
  reason: string
  /**
   * Whether the pattern applies to the whole command (without splitting it
   * into segments). Needed for syntax such as a fork bomb — it contains `;`
   * and `|` itself, so the splitter would tear it apart.
   */
  wholeCommand?: boolean
}

const FORBIDDEN: ForbiddenRule[] = [
  // Recursive deletion of the root or the home directory.
  // `[rR]` must be present in the flags; the target is exactly `/`, `~` or
  // `$HOME`.
  {
    pattern: /\brm\s+(?:-\S+\s+)*-\S*[rR]\S*\s+(?:\/|~\/?|\$HOME\/?)\s*$/,
    reason: 'deletes everything in the root or home directory',
  },
  // Formatting a disk — as the command NAME (not `grep mkfs ...`)
  { pattern: /(?:^|\s)(?:\/\S+\/)?mkfs(?:\.\w+)?\s/, reason: 'formats a file system' },
  // Raw writes to a disk
  { pattern: /\bdd\b[^|;&]*\bof=\/dev\/(?:sd|nvme|hd|disk)/, reason: 'writes raw data to a disk' },
  { pattern: />\s*\/dev\/(?:sd|nvme|hd|disk)\w/, reason: 'writes raw data to a disk' },
  { pattern: /\bdd\s+if=\/dev\/(?:zero|random|urandom)[^|;&]*\bof=\//, reason: 'wipes a disk' },
  // Fork bomb — on the whole command, because it contains `;` and `|` itself
  {
    pattern: /:\s*\(\s*\)\s*\{\s*:?\s*\|\s*:?\s*&?\s*\}\s*;?\s*:/,
    reason: 'fork bomb — freezes the machine',
    wholeCommand: true,
  },
]

/**
 * Programs that are forbidden when they appear as the command NAME.
 *
 * Checked by name rather than by pattern — in `grep reboot /var/log` or
 * `echo "shutdown"` these words are arguments, not commands.
 */
const FORBIDDEN_NAMES = new Map<string, string>([
  ['shutdown', 'shuts the machine down'],
  ['poweroff', 'shuts the machine down'],
  ['halt', 'halts the machine'],
  ['reboot', 'reboots the machine'],
  ['mkfs', 'formats a file system'],
])

/**
 * Whether the command falls under the hard ban list.
 *
 * Two stages: the whole command (for syntax such as a fork bomb), then each
 * segment separately (so that `ls && rm -rf /` is caught).
 */
export function isForbidden(command: string): { forbidden: boolean; reason?: string } {
  for (const { pattern, reason, wholeCommand } of FORBIDDEN) {
    if (wholeCommand && pattern.test(command)) return { forbidden: true, reason }
  }

  for (const segment of splitCommand(command)) {
    // Text inside quotes is not a command: `echo "reboot"` has to pass
    const stripped = stripQuotes(segment)

    // By command name: `reboot` — yes, `grep reboot file` — no.
    // `sudo reboot` has to be caught as well, so we unwrap the privilege
    // wrapper. Variants with an extension such as `mkfs.ext4` are covered too.
    const nameReason = isForbiddenName(stripped)
    if (nameReason) return { forbidden: true, reason: nameReason }

    for (const { pattern, reason, wholeCommand } of FORBIDDEN) {
      if (wholeCommand) continue
      if (pattern.test(stripped)) return { forbidden: true, reason }
    }
  }
  return { forbidden: false }
}

/**
 * Extracts the subcommand from `git <sub>`.
 * Global flags (`-C path`, `--no-pager`) are skipped.
 */
function gitSubcommand(segment: string): string | undefined {
  const words = segment.split(/\s+/).filter(Boolean)
  const gitIndex = words.findIndex((w) => (w.split('/').pop() ?? w) === 'git')
  if (gitIndex < 0) return undefined

  for (let i = gitIndex + 1; i < words.length; i += 1) {
    const word = words[i]!
    if (word.startsWith('-')) {
      // `-C <path>` and `-c <setting>` take a value
      if (word === '-C' || word === '-c') i += 1
      continue
    }
    return word
  }
  return undefined
}

/**
 * Whether the command name in the segment is on the forbidden list.
 * The `sudo`/`doas` wrapper is unwrapped: `sudo reboot` is caught too.
 */
function isForbiddenName(segment: string): string | undefined {
  let current = segment
  // Privilege wrappers — they can be chained (`sudo doas reboot`)
  for (let i = 0; i < 3; i += 1) {
    const name = commandName(current)
    if (!name) return undefined

    const base = name.split('.')[0] ?? name
    const reason = FORBIDDEN_NAMES.get(name) ?? FORBIDDEN_NAMES.get(base)
    if (reason) return reason

    if (name !== 'sudo' && name !== 'doas' && name !== 'su') return undefined
    // Strip the wrapper and continue from the next word
    const words = current.split(/\s+/).filter(Boolean)
    const index = words.findIndex((w) => (w.split('/').pop() ?? w) === name)
    if (index < 0) return undefined
    current = words.slice(index + 1).join(' ')
    if (!current) return undefined
  }
  return undefined
}

/**
 * Replaces the text inside quotes with blanks.
 * `echo "reboot"` → `echo        ` — so the text is not taken for a command.
 * The length is preserved so that `^`/`\s` matching is not disturbed.
 */
function stripQuotes(segment: string): string {
  return segment.replace(/(["'])(?:\\.|(?!\1)[^\\])*\1/g, (m) => ' '.repeat(m.length))
}

/**
 * Commands that may be used freely inside the working directory.
 * Only those that read, or that make safe changes inside the project.
 */
const SAFE_COMMANDS = new Set([
  // Reading the file system
  'ls', 'pwd', 'cat', 'head', 'tail', 'less', 'more', 'file', 'stat', 'wc',
  'find', 'grep', 'rg', 'ag', 'fd', 'tree', 'du', 'df', 'realpath', 'basename', 'dirname',
  'diff', 'cmp', 'sort', 'uniq', 'cut', 'tr', 'awk', 'sed', 'jq', 'yq',
  'echo', 'printf', 'date', 'which', 'type', 'whoami', 'id', 'env', 'uname',
  // Project tooling.
  // `git` is not here — it is context-dependent: `git status` is harmless,
  // while `git push` reaches outward and a user constraint ("don't push")
  // applies to exactly that. The safe git subcommands are in a separate list
  // below.
  'node', 'bun', 'npm', 'npx', 'pnpm', 'yarn', 'deno',
  'python', 'python3', 'pip', 'pip3', 'uv', 'poetry',
  'go', 'cargo', 'rustc', 'java', 'mvn', 'gradle',
  'tsc', 'eslint', 'oxlint', 'prettier', 'biome', 'vitest', 'jest',
  'make', 'cmake',
  // Creating directories/files (NOT deleting).
  // `cp` and `mv` are NOT here — see the note on OVERWRITERS below.
  'mkdir', 'touch',
])

/**
 * Commands that may overwrite something.
 *
 * Why a separate category? `cp` and `mv` used to be in the `SAFE_COMMANDS`
 * list, but they silently destroy an EXISTING file:
 *   cp a.txt b.txt   → the old contents of b.txt are gone irrecoverably
 *   mv a.txt b.txt   → b.txt is gone, replaced by the contents of a.txt
 * Treating `rm` as dangerous while treating `mv` as safe makes no sense: both
 * can destroy the user's work.
 *
 * But moving them wholesale into `DANGEROUS_COMMANDS` would be wrong too:
 * actions such as `cp template.ts new.ts` or `mv old-name.ts new-name.ts` are
 * an ordinary part of the daily workflow, and asking for permission every time
 * wears the user down ("permission fatigue" — after a few clicks people start
 * approving without reading, at which point the defence loses its meaning).
 *
 * Hence the middle ground: dangerous IF THE TARGET EXISTS, safe otherwise. The
 * existence check is supplied through `CommandAnalysisOptions.exists` (the
 * static analysis does not touch the file system itself — this module has to
 * remain a pure function, and the tests rely on that).
 *
 * If no checker is supplied, the CAUTIOUS path is taken: a `cp`/`mv` with a
 * target counts as dangerous. The reason is that assuming "safe unless we know
 * otherwise" contradicts this module's entire model (a whitelist model).
 */
const OVERWRITERS = new Map<string, string>([
  ['cp', 'overwrites an existing file'],
  ['mv', 'overwrites an existing file'],
])

/**
 * Commands that always ask for permission. Three groups:
 *   - destructive (rm, dd, mkfs, shred)
 *   - system/privilege (sudo, su, chown, systemctl, kill)
 *   - network and hiding (curl, wget, sh, eval, base64, nc)
 */
const DANGEROUS_COMMANDS = new Map<string, string>([
  ['rm', 'deletes files'],
  ['rmdir', 'deletes directories'],
  ['shred', 'deletes a file irrecoverably'],
  ['dd', 'writes at the disk level'],
  ['mkfs', 'formats a file system'],
  ['fdisk', 'changes disk partitions'],
  ['mount', 'mounts a file system'],
  ['umount', 'unmounts a file system'],
  ['sudo', 'runs with administrator privileges'],
  ['su', 'switches to another user'],
  ['doas', 'runs with administrator privileges'],
  ['chown', 'changes file ownership'],
  ['chmod', 'changes file permissions'],
  ['chgrp', 'changes the file group'],
  ['systemctl', 'manages system services'],
  ['service', 'manages system services'],
  ['launchctl', 'manages system services'],
  ['kill', 'stops a process'],
  ['killall', 'stops processes'],
  ['pkill', 'stops processes'],
  ['shutdown', 'shuts the machine down'],
  ['reboot', 'reboots the machine'],
  ['halt', 'halts the machine'],
  ['curl', 'reaches out to the network'],
  ['wget', 'downloads from the network'],
  ['nc', 'opens a network connection'],
  ['ncat', 'opens a network connection'],
  ['ssh', 'connects to a remote server'],
  ['scp', 'transfers files with a remote server'],
  ['rsync', 'copies or syncs files'],
  ['ftp', 'reaches out to the network'],
  ['telnet', 'reaches out to the network'],
  ['sh', 'runs arbitrary scripts'],
  ['bash', 'runs arbitrary scripts'],
  ['zsh', 'runs arbitrary scripts'],
  ['eval', 'runs arbitrary code'],
  ['exec', 'replaces the process'],
  ['source', 'loads an arbitrary script'],
  ['base64', 'can be used to hide a command'],
  ['xxd', 'can be used to hide a command'],
  ['docker', 'manages containers'],
  ['podman', 'manages containers'],
  ['kubectl', 'manages a cluster'],
  ['crontab', 'adds a scheduled job'],
  ['at', 'adds a scheduled job'],
])

/**
 * Read-only or local git operations that do not leave the working directory.
 *
 * The remaining git subcommands (`push`, `remote`, `clean`, `reset --hard`,
 * `checkout --`) are DELIBERATELY absent from the list: they either reach
 * outward or cannot be undone. They ask for permission, or in auto mode they
 * go to the classifier — the user's "don't push" constraint takes effect at
 * exactly this point.
 */
const SAFE_GIT = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'blame', 'shortlog',
  'ls-files', 'rev-parse', 'describe', 'tag', 'config',
  'add', 'commit', 'stash', 'switch', 'restore', 'fetch',
])

/** `VAR=value` prefixes and `env` wrappers in front of the command are skipped */
const VARIABLE_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/

export interface CommandAnalysisOptions {
  /** The working directory — paths outside it ask for permission */
  workDir: string
  /**
   * Whether the path already exists. Used to check the target of `cp`/`mv` —
   * writing over an existing file is dangerous, creating a new one is safe.
   *
   * Synchronous: the analysis function has to stay pure and synchronous (so
   * that `assessCommand` is easy to test). The caller (`RestrictedEnv`)
   * supplies `existsSync`.
   *
   * If it is not supplied, a `cp`/`mv` with a target counts as dangerous out
   * of caution.
   */
  exists?: (path: string) => boolean
}

/**
 * Splits the command into segments on `;`, `&&`, `||`, `|` and newlines.
 * Substitutions inside brackets (`$(...)`, backticks) come back as separate
 * segments — they have to be checked too.
 */
export function splitCommand(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let i = 0
  let inDoubleQuote = false
  let inSingleQuote = false

  const flush = () => {
    const t = current.trim()
    if (t) segments.push(t)
    current = ''
  }

  while (i < command.length) {
    const c = command[i]!
    const next = command[i + 1]

    // Nothing is expanded inside single quotes
    if (inSingleQuote) {
      if (c === "'") inSingleQuote = false
      current += c
      i += 1
      continue
    }
    if (c === "'") {
      inSingleQuote = true
      current += c
      i += 1
      continue
    }
    if (c === '"') {
      inDoubleQuote = !inDoubleQuote
      current += c
      i += 1
      continue
    }
    // An escaped character
    if (c === '\\' && next !== undefined) {
      current += c + next
      i += 2
      continue
    }

    // $(...) and `...` — an inner command, a separate segment
    if (!inDoubleQuote || c === '$' || c === '`') {
      if (c === '$' && next === '(') {
        const closing = findClosingBracket(command, i + 1)
        if (closing > 0) {
          segments.push(...splitCommand(command.slice(i + 2, closing)))
          i = closing + 1
          continue
        }
      }
      if (c === '`') {
        const closing = command.indexOf('`', i + 1)
        if (closing > 0) {
          segments.push(...splitCommand(command.slice(i + 1, closing)))
          i = closing + 1
          continue
        }
      }
    }

    if (inDoubleQuote) {
      current += c
      i += 1
      continue
    }

    // Separators
    if (c === ';' || c === '\n' || c === '&' || c === '|') {
      flush()
      // `&&` and `||` are two characters
      i += (c === '&' && next === '&') || (c === '|' && next === '|') ? 2 : 1
      continue
    }

    current += c
    i += 1
  }
  flush()
  return segments
}

function findClosingBracket(text: string, openingIndex: number): number {
  let depth = 0
  for (let i = openingIndex; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1
    else if (text[i] === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** Extracts the command name from a segment (skipping VAR=x prefixes) */
export function commandName(segment: string): string {
  const words = segment.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < words.length && VARIABLE_PREFIX.test(words[i]!)) i += 1
  // Unwrap the `env FOO=bar cmd` and `command cmd` wrappers
  while (i < words.length && (words[i] === 'env' || words[i] === 'command' || words[i] === 'nohup')) {
    i += 1
    while (i < words.length && VARIABLE_PREFIX.test(words[i]!)) i += 1
  }
  const name = words[i] ?? ''
  // If given as a full path, take the last part: /bin/rm → rm
  const last = name.split('/').pop() ?? name
  return last.replace(/^['"]|['"]$/g, '')
}

/**
 * Whether the arguments in a segment contain a path outside the working
 * directory. Cautious: when in doubt it answers "yes".
 */
function outsidePath(segment: string, workDir: string): string | null {
  const words = segment.split(/\s+/).filter(Boolean)
  for (const rawWord of words) {
    const word = rawWord.replace(/^['"]|['"]$/g, '')
    if (!word) continue

    // The home directory
    if (word === '~' || word.startsWith('~/')) return word
    // An absolute path — is it inside the working directory?
    if (word.startsWith('/')) {
      if (word === workDir || word.startsWith(`${workDir}/`)) continue
      return word
    }
    // Climbing up out of a relative path
    if (word === '..' || word.startsWith('../') || word.includes('/../')) return word
  }
  return null
}

/**
 * Assesses the command. If there are several segments, THE MOST DANGEROUS one
 * is returned — `ls && rm -rf x` counts as dangerous.
 */
export function assessCommand(command: string, options: CommandAnalysisOptions): CommandAssessment {
  // 0) The hard ban — before and above every other check
  const forbidden = isForbidden(command)
  if (forbidden.forbidden) {
    return { category: 'forbidden', reason: forbidden.reason, pattern: '' }
  }

  const segments = splitCommand(command)
  if (segments.length === 0) {
    return { category: 'safe', pattern: '' }
  }

  let unknown: CommandAssessment | null = null

  for (const segment of segments) {
    const name = commandName(segment)
    if (!name) continue

    const pattern = buildPattern(name, segment)

    // 1) The dangerous list — returns immediately
    const dangerousReason = DANGEROUS_COMMANDS.get(name)
    if (dangerousReason) {
      return { category: 'dangerous', reason: `\`${name}\` — ${dangerousReason}`, pattern }
    }

    // 2) Leaving the working directory with `cd`
    if (name === 'cd') {
      const target = segment.split(/\s+/).filter(Boolean)[1] ?? ''
      if (target && (target.startsWith('/') || target.startsWith('~') || target.startsWith('..'))) {
        const outside = outsidePath(segment, options.workDir)
        if (outside) {
          return {
            category: 'dangerous',
            reason: `leaves the working directory: ${outside}`,
            pattern,
          }
        }
      }
      continue
    }

    // 3) An outside path in the arguments
    const outside = outsidePath(segment, options.workDir)
    if (outside) {
      return {
        category: 'dangerous',
        reason: `path outside the working directory: ${outside}`,
        pattern,
      }
    }

    // 3b) `cp`/`mv` — if the target exists it is overwritten, i.e. dangerous.
    //
    // DELIBERATELY placed AFTER the outside-path check: `cp a.txt /etc/passwd`
    // has to be caught as "leaving the working directory" first, regardless of
    // whether the target exists.
    const overwriteReason = OVERWRITERS.get(name)
    if (overwriteReason) {
      const overwriteTarget = overwrittenTarget(segment, name, options)
      if (overwriteTarget) {
        return {
          category: 'dangerous',
          reason: `\`${name}\` — ${overwriteReason}: ${overwriteTarget}`,
          pattern,
        }
      }
      // The target is new — this is an ordinary copy/rename, safe
      continue
    }

    // 3c) git — decided by the subcommand
    if (name === 'git') {
      const sub = gitSubcommand(segment)
      if (sub && SAFE_GIT.has(sub)) continue
      return {
        category: 'dangerous',
        reason: sub
          ? `\`git ${sub}\` — reaches outward or cannot be undone`
          : 'the git subcommand could not be determined',
        pattern,
      }
    }

    // 4) Not on the whitelist — unknown (we remember the first one)
    if (!SAFE_COMMANDS.has(name) && !unknown) {
      unknown = {
        category: 'unknown',
        reason: `\`${name}\` is not in the list of known commands`,
        pattern,
      }
    }
  }

  if (unknown) return unknown
  return { category: 'safe', pattern: buildPattern(commandName(segments[0]!), segments[0]!) }
}

/**
 * Finds the target that would be overwritten in a `cp`/`mv` segment.
 *
 * The target is the LAST path argument (`cp a b`, or `c/` in `cp a b c/`).
 * Flags (`-r`, `--force`) are skipped.
 *
 * Return value:
 *   string    — the target exists (or could not be checked) → ask for permission
 *   null      — the target is new, safe
 *
 * Cautious cases (all of them lean towards "dangerous"):
 *   - `exists` was not supplied → could not check, the target is returned;
 *   - the argument contains a substitution/glob (`*`, `$`, `` ` ``) → we do not
 *     know which files it touches, the target is returned;
 *   - the target is a directory → it may contain a file of the same name, so
 *     the target is returned (copying into a directory is the case that
 *     overwrites most often).
 */
function overwrittenTarget(
  segment: string,
  name: string,
  options: CommandAnalysisOptions,
): string | null {
  const words = segment.split(/\s+/).filter(Boolean)
  const nameIndex = words.findIndex((w) => (w.split('/').pop() ?? w) === name)
  if (nameIndex < 0) return null

  const args = words
    .slice(nameIndex + 1)
    .filter((w) => !w.startsWith('-'))
    .map((w) => w.replace(/^['"]|['"]$/g, ''))

  // There has to be a source and a target: `cp a` is a broken command, leave it
  if (args.length < 2) return null

  const target = args[args.length - 1]!

  // Things that get expanded — the static analysis does not know the value
  if (/[*?$`{}[\]]/.test(target)) return target

  if (!options.exists) return target

  // A relative path is resolved against the working directory (the command runs
  // there)
  const full = target.startsWith('/') ? target : `${options.workDir}/${target}`
  return options.exists(full) ? target : null
}

/**
 * The pattern for "always allow": the command name plus the first argument.
 * Deliberately narrow — `git push`, not `git`. Otherwise a single approval
 * would open the door to far too much.
 */
function buildPattern(name: string, segment: string): string {
  const words = segment.split(/\s+/).filter(Boolean)
  const nameIndex = words.findIndex((w) => (w.split('/').pop() ?? w).replace(/^['"]|['"]$/g, '') === name)
  const next = nameIndex >= 0 ? words[nameIndex + 1] : undefined
  // A flag or a path is not added to the pattern — those change every time
  if (next && !next.startsWith('-') && !next.includes('/') && /^[\w.:@-]+$/.test(next)) {
    return `${name} ${next}`
  }
  return name
}

/** Exposes the lists for tests and diagnostics */
export const commandLists = {
  safe: SAFE_COMMANDS,
  dangerous: DANGEROUS_COMMANDS,
}

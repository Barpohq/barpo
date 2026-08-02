// Git state — what the working directory's git situation is.
//
// The agent has no git tool and is not meant to get one: `bash` runs git
// perfectly well. What the agent CANNOT do through bash is know the situation
// BEFORE its first command — and the situation decides the workflow:
//
//   - not a repository        → init only if something real is being built
//   - a repository, no remote → commit locally at meaningful points
//   - a repository + remote   → the history belongs to other people too:
//                               branch, commit there, PR — never straight
//                               onto the trunk
//
// So this module reads the state once per stream and turns it into a prompt
// section: one factual line plus the rules for exactly that situation.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHY FILES ARE READ INSTEAD OF SPAWNING `git`.                        │
// │                                                                      │
// │ 1. The prompt is assembled synchronously (`agent.ts`), like its      │
// │    neighbours `readProjectContext`/`readSkills`. A subprocess means  │
// │    either an await in that block or `spawnSync` stalling the whole   │
// │    server for every stream; two `readFileSync` calls cost            │
// │    microseconds.                                                     │
// │ 2. Spawning git here would be a SECOND path to executing a binary,   │
// │    outside `RestrictedEnv` and `command-analysis` — and a cloned     │
// │    repo's `.git/config` can point git at hooks and helpers of its    │
// │    choosing. Reading the files has no such surface.                  │
// │                                                                      │
// │ The price: no dirty-state, no nice name for a detached HEAD. That is │
// │ fine — the agent has `bash` and `git status` is free the moment it   │
// │ cares. This line only has to make it CHOOSE the right workflow.      │
// └──────────────────────────────────────────────────────────────────────┘
//
// SECURITY: the remote URL comes out of `.git/config`, i.e. from whoever the
// repo was cloned from — it is UNTRUSTED text landing in the agent's system
// prompt. It is sanitised here (control characters out, length capped) so it
// cannot forge a section header, and like every untrusted prompt input it
// NEVER REACHES THE CLASSIFIER (same boundary as `project-context.ts`; a
// test enforces it).

import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export interface GitState {
  /** Whether the working directory is a git repository at all */
  repo: boolean
  /** The current branch; undefined on a detached HEAD */
  branch?: string
  /** Whether the repo has ANY remote configured */
  hasRemote: boolean
  /** The remote URL — `origin`'s if present, otherwise the first one found */
  remote?: string
}

/**
 * `.git/config` read limit. The file is normally under a kilobyte; a hostile
 * repo could ship a gigantic one, and `readFileSync` would load it whole.
 * 64 KB still fits any real config many times over.
 */
export const GIT_CONFIG_LIMIT = 64_000

/** The remote URL is one line in the prompt — cap it so it stays one line. */
const URL_LIMIT = 200

const NOT_A_REPO: GitState = { repo: false, hasRemote: false }

/**
 * Reads the git state of a directory. NEVER THROWS — a broken or unreadable
 * `.git` reads as "not a repository", for the same reason `readProjectContext`
 * never throws: a conversation must not go down over it.
 *
 * Parent directories are DELIBERATELY not searched: the working directory is
 * the boundary everywhere else (`RestrictedEnv`, the search tools), and
 * reporting a parent repo the agent cannot reach would produce advice about
 * a repository it cannot act on.
 */
export function readGitState(workDir: string): GitState {
  try {
    const dotGit = join(workDir, '.git')
    const stat = statSync(dotGit)

    // `.git` is usually a directory; as a FILE it is a gitfile — worktrees
    // and submodules write `gitdir: <path>` and keep the real state there.
    let gitDir: string
    if (stat.isDirectory()) {
      gitDir = dotGit
    } else if (stat.isFile()) {
      const m = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)\s*$/m)
      if (!m) return NOT_A_REPO
      const target = m[1].trim()
      gitDir = isAbsolute(target) ? target : resolve(workDir, target)
    } else {
      return NOT_A_REPO
    }

    let branch: string | undefined
    try {
      const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
      // The branch name may itself contain `/` (e.g. `claude/fix-x`), so
      // everything after `refs/heads/` is the name. Anything else in HEAD is
      // a raw commit id — a detached HEAD, and `branch` stays undefined.
      const REF = 'ref: refs/heads/'
      if (head.startsWith(REF)) branch = head.slice(REF.length)
    } catch {
      // No readable HEAD — still a repository, just say nothing about the
      // branch.
    }

    const { hasRemote, remote } = readRemote(gitDir)
    return { repo: true, branch, hasRemote, remote }
  } catch {
    return NOT_A_REPO
  }
}

/**
 * Finds the remote in `<gitDir>/config` with a minimal INI scan.
 *
 * ANY `[remote "…"]` section counts as "has a remote", not just `origin` —
 * a repo whose only remote is `upstream` would otherwise read as local, and
 * the agent would get the LESS cautious rules for a repository other people
 * pull from. `origin`'s URL is preferred for the prompt line; failing that,
 * the first URL found.
 *
 * In a worktree the config lives in the main repository's git dir; the
 * `commondir` file points there.
 */
function readRemote(gitDir: string): { hasRemote: boolean; remote?: string } {
  let raw: string
  try {
    raw = readFileSync(join(gitDir, 'config'), 'utf8')
  } catch {
    try {
      const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim()
      const commonDir = isAbsolute(common) ? common : resolve(gitDir, common)
      raw = readFileSync(join(commonDir, 'config'), 'utf8')
    } catch {
      return { hasRemote: false }
    }
  }

  const lines = raw.slice(0, GIT_CONFIG_LIMIT).split('\n')
  let hasRemote = false
  let inRemote = false
  let inOrigin = false
  let originUrl: string | undefined
  let firstUrl: string | undefined

  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith('[')) {
      const section = t.match(/^\[remote\s+"(.*)"\]$/)
      inRemote = section !== null
      inOrigin = section?.[1] === 'origin'
      if (inRemote) hasRemote = true
      continue
    }
    if (!inRemote) continue
    const url = t.match(/^url\s*=\s*(.+)$/)
    if (!url) continue
    if (inOrigin && originUrl === undefined) originUrl = url[1]
    if (firstUrl === undefined) firstUrl = url[1]
  }

  const chosen = originUrl ?? firstUrl
  return { hasRemote, remote: chosen ? sanitizeUrl(chosen) : undefined }
}

/**
 * The URL goes into the system prompt as-is, and it came from a stranger.
 * Control characters and newlines are stripped so a crafted config cannot
 * inject a fake `--- ` section header or split the line; the length cap
 * keeps it one line.
 */
function sanitizeUrl(url: string): string {
  return url
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, URL_LIMIT)
}

/**
 * The prompt section: one factual line about the state, then the rules for
 * exactly that state. Always returns text — "not a repository" is itself the
 * situation the init rule addresses.
 *
 * The rules never say "you must use git": the obligation is conditional in
 * every variant. That is the product decision made textual — git is offered,
 * not forced.
 */
export function gitToPrompt(state: GitState): string {
  if (!state.repo) {
    return [
      '--- Git ---',
      'This directory is not a git repository.',
      '',
      'GIT. Version control is not required and you do not need to mention it.',
      'But if you are building something real here — a project with more than',
      'one file, work that will continue past this conversation — `git init`',
      'early and commit as you go. Do not initialise a repository for a one-off',
      'script or a throwaway experiment; a repo full of noise commits helps',
      'nobody.',
    ].join('\n')
  }

  const branchLine = state.branch
    ? `Current branch: ${state.branch}.`
    : 'No branch is checked out (detached HEAD).'

  if (!state.hasRemote) {
    return [
      '--- Git ---',
      `This directory is a git repository. ${branchLine} It has no remote —`,
      'the history is local to this machine.',
      '',
      'GIT. Commit at meaningful points: a feature that works, a bug that is',
      'fixed, a refactor that is finished. Not every turn, and not every file',
      'you touch — a commit should be a change someone could review on its own.',
      'Write the message as one imperative sentence saying what changed and why',
      '("add the retry path", not "changes"). Never `git add -A` blindly: know',
      'what you are committing. You may commit on this branch — there is no',
      'remote and nobody else pulls from it.',
    ].join('\n')
  }

  const remoteLine = state.remote
    ? `Remote: ${state.remote} —`
    : 'It has a remote —'

  return [
    '--- Git ---',
    `This directory is a git repository. ${branchLine} ${remoteLine}`,
    'this repository came from somewhere and other people work in it.',
    '',
    'GIT. This repository has a remote, so your changes will eventually reach',
    'other people. Work on a branch: create one with `git switch -c <name>`',
    'before you start, commit there, and when the work is done offer to open a',
    'pull request (`gh pr create`). NEVER commit straight onto `main` or',
    '`master` here — that is a shared trunk, and a commit landing on it',
    'unannounced is the one mistake that is expensive to undo.',
    '',
    'Commit at meaningful points: a feature that works, a bug that is fixed.',
    'Not every turn — a commit should be a change someone could review on its',
    'own. Write the message as one imperative sentence saying what changed and',
    'why.',
    '',
    'Pushing is the user\'s decision, not yours. Do not `git push` and do not',
    'open a pull request unless the user asked for it or the task plainly',
    'requires it, and never force-push at all unless they asked in those words.',
    'If pushing is what the task needs, say so and let them answer — the',
    'permission prompt you get is that question, not an obstacle to work',
    'around.',
  ].join('\n')
}

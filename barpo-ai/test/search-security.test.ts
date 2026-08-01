// The security boundary of the search tools.
//
// `grep`/`find`/`ls` DO NOT ASK for permission — so this boundary is their
// only protection. If it did not work, a prompt injection asking "what is
// inside ~/.ssh?" would get an answer straight away.
//
// Three things are tested:
//   1) a path outside the working directory is rejected,
//   2) escaping through a symlink is caught by `realpath`,
//   3) absolute paths NEVER appear in the result.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkBoundary, relativePath } from '../src/search-core.ts'
import {
  BoundaryError,
  findNode,
  findRg,
  grepNode,
  grepRg,
  lsList,
  PatternError,
} from '../src/search-engine.ts'
import { rgAvailable } from './search-helper.ts'

let base: string
let work: string
let outside: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'search-security-'))
  work = join(base, 'work')
  outside = join(base, 'outside')
  mkdirSync(work, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(work, 'inner.txt'), 'the secret word is here\n')
  writeFileSync(join(outside, 'secret.txt'), 'the secret word is here\n')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('checkBoundary', () => {
  test('a path inside the working directory passes', async () => {
    const n = await checkBoundary(work, 'inner.txt')
    expect(n.ok).toBe(true)
  })

  test('the working directory itself passes', async () => {
    const n = await checkBoundary(work, undefined)
    expect(n.ok).toBe(true)
  })

  test('going up with `..` is rejected', async () => {
    const n = await checkBoundary(work, '../outside')
    expect(n.ok).toBe(false)
    expect(n.reason).toContain('outside the working directory')
  })

  test('an absolute outside path is rejected', async () => {
    const n = await checkBoundary(work, '/etc')
    expect(n.ok).toBe(false)
  })

  test('a deep `../../..` is rejected too', async () => {
    const n = await checkBoundary(work, '../../../../../../etc/passwd')
    expect(n.ok).toBe(false)
  })

  test('escaping through a symlink is caught', async () => {
    symlinkSync(outside, join(work, 'link'))
    const n = await checkBoundary(work, 'link')
    expect(n.ok).toBe(false)
    expect(n.reason).toContain('symlink')
  })

  test('an inner path that does not exist passes (the textual check is enough)', async () => {
    const n = await checkBoundary(work, 'not/yet/file.txt')
    expect(n.ok).toBe(true)
  })

  test('the inside passes even when the working directory itself is a symlink', async () => {
    // On macOS /tmp → /private/tmp; that situation is simulated here
    const link = join(base, 'work-link')
    symlinkSync(work, link)
    const n = await checkBoundary(link, 'inner.txt')
    expect(n.ok).toBe(true)
  })
})

describe('the boundary at tool level', () => {
  test('grepNode rejects an outside path', async () => {
    const attempt = grepNode({ workDir: work, pattern: 'secret', path: '../outside' })
    expect(attempt).rejects.toThrow(BoundaryError)
  })

  test('findNode rejects an outside path', async () => {
    const attempt = findNode({ workDir: work, pattern: '*.txt', path: '/etc' })
    expect(attempt).rejects.toThrow(BoundaryError)
  })

  test('lsList rejects an outside path', async () => {
    const attempt = lsList({ workDir: work, path: '../outside' })
    expect(attempt).rejects.toThrow(BoundaryError)
  })

  test('grepNode rejects escaping through a symlink', async () => {
    symlinkSync(outside, join(work, 'link'))
    const attempt = grepNode({ workDir: work, pattern: 'secret', path: 'link' })
    expect(attempt).rejects.toThrow(BoundaryError)
  })

  test('the error message does not disclose an absolute path', async () => {
    try {
      await grepNode({ workDir: work, pattern: 'x', path: '/etc/ssh' })
      throw new Error('an error was expected')
    } catch (error) {
      expect(error).toBeInstanceOf(BoundaryError)
      // The message contains the path the user gave, but not the real
      // absolute location of the working directory
      expect((error as Error).message).not.toContain(work)
    }
  })
})

describe('symlinks are not followed', () => {
  test('grepNode does not search the outside file behind a symlink', async () => {
    // There is a symlink inside the working directory pointing outward; the
    // walk must not open it, otherwise `secret.txt` would land in the result
    symlinkSync(outside, join(work, 'link'))
    const n = await grepNode({ workDir: work, pattern: 'secret' })
    // It finds the inner file only
    expect(n.items.map((m) => m.path)).toEqual(['inner.txt'])
  })

  test.if(rgAvailable())('grepRg does not step inside a symlink either', async () => {
    symlinkSync(outside, join(work, 'link'))
    const n = await grepRg({ workDir: work, pattern: 'secret' })
    expect(n.items.map((m) => m.path)).toEqual(['inner.txt'])
  })

  test('findNode does not list the file behind a symlink', async () => {
    symlinkSync(outside, join(work, 'link'))
    const n = await findNode({ workDir: work, pattern: '*.txt' })
    expect(n.items).toEqual(['inner.txt'])
  })

  test.if(rgAvailable())('findRg does not step inside a symlink either', async () => {
    symlinkSync(outside, join(work, 'link'))
    const n = await findRg({ workDir: work, pattern: '*.txt' })
    expect(n.items).toEqual(['inner.txt'])
  })
})

describe('no absolute path appears in the result', () => {
  test('the grep result gives a relative path', async () => {
    mkdirSync(join(work, 'a', 'b'), { recursive: true })
    writeFileSync(join(work, 'a', 'b', 'c.txt'), 'secret\n')
    const n = await grepNode({ workDir: work, pattern: 'secret' })
    for (const m of n.items) {
      expect(m.path.startsWith('/')).toBe(false)
      expect(m.path).not.toContain(work)
    }
  })

  test('the ls result gives names only', async () => {
    const n = await lsList({ workDir: work })
    for (const e of n.items) {
      expect(e.name).not.toContain('/')
    }
  })

  test('relativePath turns the working directory itself into `.`', () => {
    expect(relativePath(work, work)).toBe('.')
  })
})

describe('pattern safety', () => {
  // The pattern must not be passed to the shell RAW. If `spawn` were called
  // with `shell: true`, the pattern below would run the `touch` command.
  test('shell metacharacters stay a pattern, they do not become a command', async () => {
    writeFileSync(join(work, 'target.txt'), 'plain text\n')
    const evil = 'x"; touch /tmp/search-broken; echo "'
    // There must be no error — this is simply a pattern that matches nothing
    const n = await grepNode({ workDir: work, pattern: evil })
    expect(n.items).toHaveLength(0)
  })

  test.if(rgAvailable())('shell metacharacters are harmless on the rg path too', async () => {
    const evil = 'x`touch /tmp/search-broken-rg`y'
    const n = await grepRg({ workDir: work, pattern: evil })
    expect(n.items).toHaveLength(0)
    // The file must not have been created
    expect(await Bun.file('/tmp/search-broken-rg').exists()).toBe(false)
  })

  test('a pattern starting with `-` is not read as a flag', async () => {
    writeFileSync(join(work, 'dash.txt'), 'there is a -line here\n')
    const n = await grepNode({ workDir: work, pattern: '-line' })
    expect(n.items).toHaveLength(1)
  })

  test.if(rgAvailable())('a pattern starting with `-` works in rg too', async () => {
    writeFileSync(join(work, 'dash.txt'), 'there is a -line here\n')
    const n = await grepRg({ workDir: work, pattern: '-line' })
    expect(n.items).toHaveLength(1)
  })

  test('an invalid regex gives a clear error', async () => {
    const attempt = grepNode({ workDir: work, pattern: '[unclosed' })
    expect(attempt).rejects.toThrow(PatternError)
  })

  test('an empty pattern is rejected', async () => {
    const attempt = grepNode({ workDir: work, pattern: '' })
    expect(attempt).rejects.toThrow(PatternError)
  })

  test.if(rgAvailable())('the rg path gives the same error for an invalid regex', async () => {
    // This matters for parity: a pattern error must be a `PatternError` in
    // both backends, not `rg`'s own message
    const attempt = grepRg({ workDir: work, pattern: '[unclosed' })
    expect(attempt).rejects.toThrow(PatternError)
  })
})

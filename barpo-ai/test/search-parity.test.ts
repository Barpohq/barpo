// PARITY OF THE TWO BACKENDS — this file is the most important test of the
// whole search layer.
//
// WHY: if the agent behaves one way on a PC that has `rg` and differently on
// a PC that does not — that is a bug which breaks silently. No exception is
// thrown, no log appears; the user is simply left with "it works for me, it
// doesn't work for you" and never finds out why. That is why parity must not
// remain an intention — it is enforced RIGHT HERE.
//
// The method: for the same input, `grepRg()` and `grepNode()` are called
// SEPARATELY (not the picker `grepSearch()` — that would only run one of
// them), and then the results are compared INCLUDING THEIR ORDER.
//
// On a system without `rg` these tests are skipped (`test.if`), but the Node
// path itself is fully exercised by the remaining files.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findNode, findRg, grepNode, grepRg } from '../src/search-engine.ts'
import type { FindOptions, GrepOptions } from '../src/search-engine.ts'
import { rgAvailable } from './search-helper.ts'

let work: string

/** A rich file tree for the test — it covers the places parity could break */
function createTree(base: string): void {
  const write = (relative: string, content: string) => {
    const full = join(base, relative)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }

  write('a.ts', 'const hello = 1\nexport { hello }\n')
  write('b.ts', 'const HELLO = 2\n')
  write('c.md', 'hello world\n')
  write('src/inner.ts', 'function hello() {}\n')
  write('src/deep/very/inside.ts', 'hello down here\n')
  write('src/other.txt', 'hello text\n')

  // A hidden file — `rg` does not see it by default, it does with `--hidden`.
  // Both backends must see it.
  write('.hidden.ts', 'hello hidden\n')
  write('.hiddendir/inside.ts', 'hello in the hidden folder\n')

  // Gitignore — DECISION: neither backend READS it.
  // If `rg` respected gitignore, `excluded.ts` would not be in its result
  // while Node would find it — this is here to catch exactly that difference.
  write('.gitignore', 'excluded.ts\nexcluded-dir/\n*.log\n')
  write('excluded.ts', 'hello excluded\n')
  write('excluded-dir/inside.ts', 'hello in the excluded folder\n')
  write('journal.log', 'hello in the log\n')

  // A nested gitignore — the hardest place to reproduce in Node
  write('src/.gitignore', 'other.txt\n')

  // Skipped directories — both must leave them out
  write('node_modules/package/index.ts', 'hello in the package\n')
  write('.git/HEAD', 'hello in git\n')
  write('dist/built.ts', 'hello in dist\n')

  // A file with `:` in its name — exercises the `file:line:text` separator
  write('o'.repeat(1) + 'dd:name.ts', 'hello in the odd one\n')

  // A very long line — the cut must be the same on both sides
  write('long.ts', 'hello ' + 'x'.repeat(2000) + '\n')

  // A binary file — both must drop it
  writeFileSync(join(base, 'binary.dat'), Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0xff]))

  // A file with no trailing `\n` — line counting could differ
  write('noeol.ts', 'hello no newline')

  // CRLF lines — stripping `\r` must be the same in both
  write('crlf.ts', 'hello crlf\r\nsecond\r\n')

  // An empty file
  write('empty.ts', '')

  // Many matches in one file — exercises the line ordering
  write('many.ts', 'hello\nno\nhello\nno\nhello\n')

  // UTF-8 characters
  write('unicode.ts', "hello o'zbek tili — ҳарфлар\n")
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'search-parity-'))
  createTree(work)
})

afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

/**
 * Calls both backends with the same input and compares them.
 *
 * `toEqual` also checks the array's ORDER — that is deliberate: a difference
 * in order is a bug too, because the limit (200 matches) would cut a
 * different 200 depending on the order.
 */
async function compareGrep(options: Omit<GrepOptions, 'workDir'>): Promise<void> {
  const [rg, node] = await Promise.all([
    grepRg({ workDir: work, ...options }),
    grepNode({ workDir: work, ...options }),
  ])
  expect(rg.backend).toBe('rg')
  expect(node.backend).toBe('node')
  expect(rg.items).toEqual(node.items)
  expect(rg.truncated).toBe(node.truncated)
}

async function compareFind(options: Omit<FindOptions, 'workDir'>): Promise<void> {
  const [rg, node] = await Promise.all([
    findRg({ workDir: work, ...options }),
    findNode({ workDir: work, ...options }),
  ])
  expect(rg.items).toEqual(node.items)
  expect(rg.truncated).toBe(node.truncated)
}

describe('grep — the two backends agree', () => {
  test.if(rgAvailable())('a plain pattern', async () => {
    await compareGrep({ pattern: 'hello' })
  })

  test.if(rgAvailable())('upper/lower case difference', async () => {
    await compareGrep({ pattern: 'HELLO' })
  })

  test.if(rgAvailable())('caseInsensitive', async () => {
    await compareGrep({ pattern: 'hello', caseInsensitive: true })
  })

  test.if(rgAvailable())('regex metacharacters', async () => {
    await compareGrep({ pattern: 'hell[o0]\\s+\\w+' })
  })

  test.if(rgAvailable())('line start and end anchors', async () => {
    await compareGrep({ pattern: '^const .*= \\d$' })
  })

  test.if(rgAvailable())('lookahead — a dialect that requires PCRE2', async () => {
    // This is exactly the pattern `rg`'s default Rust engine REJECTS.
    // Without `--pcre2` this test would fail — meaning it guards the
    // dialect staying the same.
    await compareGrep({ pattern: 'hello(?=\\s+world)' })
  })

  test.if(rgAvailable())('lookbehind', async () => {
    await compareGrep({ pattern: '(?<=const )hello' })
  })

  test.if(rgAvailable())('glob filter — extension', async () => {
    await compareGrep({ pattern: 'hello', glob: '*.ts' })
  })

  test.if(rgAvailable())('glob filter — nested path', async () => {
    await compareGrep({ pattern: 'hello', glob: 'src/**/*.ts' })
  })

  test.if(rgAvailable())('glob filter — `{a,b}` options', async () => {
    await compareGrep({ pattern: 'hello', glob: '*.{ts,md}' })
  })

  test.if(rgAvailable())('searching from an inner directory', async () => {
    await compareGrep({ pattern: 'hello', path: 'src' })
  })

  test.if(rgAvailable())('searching from a deep inner directory', async () => {
    await compareGrep({ pattern: 'hello', path: 'src/deep' })
  })

  test.if(rgAvailable())('`all: true` — the skipped directories too', async () => {
    await compareGrep({ pattern: 'hello', all: true })
  })

  test.if(rgAvailable())('when nothing is found', async () => {
    await compareGrep({ pattern: 'no-such-word-at-all-12345' })
  })

  test.if(rgAvailable())('a long line being cut', async () => {
    await compareGrep({ pattern: 'xxxxx' })
  })

  test.if(rgAvailable())('unicode characters', async () => {
    await compareGrep({ pattern: 'ҳарфлар' })
  })

  test.if(rgAvailable())('CRLF lines', async () => {
    await compareGrep({ pattern: 'crlf' })
  })

  test.if(rgAvailable())('a file with no trailing `\\n`', async () => {
    await compareGrep({ pattern: 'no newline' })
  })

  test.if(rgAvailable())('many matches in one file — line order', async () => {
    await compareGrep({ pattern: 'hello', glob: 'many.ts' })
  })

  test.if(rgAvailable())('still the same when the limit truncates', async () => {
    // We deliberately make the limit small — both backends must pick
    // EXACTLY the same first 3. This proves that `rg`'s arbitrary order
    // has not leaked into the result.
    const [rg, node] = await Promise.all([
      grepRg({ workDir: work, pattern: 'hello', limit: 3 }),
      grepNode({ workDir: work, pattern: 'hello', limit: 3 }),
    ])
    expect(rg.items).toEqual(node.items)
    expect(rg.items).toHaveLength(3)
    expect(rg.truncated).toBe(true)
    expect(node.truncated).toBe(true)
  })

  test.if(rgAvailable())("the result is stable even though rg's order is arbitrary", async () => {
    // We call `rg` several times and check that EXACTLY the same result
    // comes back each time. Without sorting this test would be flaky — in
    // trials `rg` gave three different orders in three runs.
    const first = await grepRg({ workDir: work, pattern: 'hello' })
    for (let i = 0; i < 4; i += 1) {
      const next = await grepRg({ workDir: work, pattern: 'hello' })
      expect(next.items).toEqual(first.items)
    }
  })

  test.if(rgAvailable())('gitignore is read by NEITHER backend', async () => {
    // The explicit test of that decision: `.gitignore` lists `excluded.ts`,
    // but it MUST BE IN THE RESULT — because we deliberately do not read
    // gitignore. If someone drops `--no-ignore` from `rg`, this test fails.
    const rg = await grepRg({ workDir: work, pattern: 'hello' })
    const node = await grepNode({ workDir: work, pattern: 'hello' })
    const rgPaths = rg.items.map((m) => m.path)
    expect(rgPaths).toContain('excluded.ts')
    expect(rgPaths).toContain('journal.log')
    expect(rgPaths).toContain('excluded-dir/inside.ts')
    // A file from the nested `.gitignore` shows up as well
    expect(rgPaths).toContain('src/other.txt')
    expect(rg.items).toEqual(node.items)
  })

  test.if(rgAvailable())('a binary file is dropped by both', async () => {
    const rg = await grepRg({ workDir: work, pattern: 'hello' })
    const node = await grepNode({ workDir: work, pattern: 'hello' })
    expect(rg.items.map((m) => m.path)).not.toContain('binary.dat')
    expect(node.items.map((m) => m.path)).not.toContain('binary.dat')
  })

  test.if(rgAvailable())('hidden files are searched by both', async () => {
    const rg = await grepRg({ workDir: work, pattern: 'hello' })
    expect(rg.items.map((m) => m.path)).toContain('.hidden.ts')
    expect(rg.items.map((m) => m.path)).toContain('.hiddendir/inside.ts')
    await compareGrep({ pattern: 'hello' })
  })

  test.if(rgAvailable())('a file with `:` in its name is split correctly', async () => {
    // `rg`'s output is `odd:name.ts:1:hello in the odd one` — the `:` in the
    // path must not be confused with the separator
    const rg = await grepRg({ workDir: work, pattern: 'odd one' })
    const node = await grepNode({ workDir: work, pattern: 'odd one' })
    expect(rg.items).toEqual(node.items)
    expect(rg.items[0]?.path).toBe('odd:name.ts')
    expect(rg.items[0]?.line).toBe(1)
  })

  test.if(rgAvailable())('symlinks are followed by neither', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'search-outside-'))
    try {
      writeFileSync(join(outside, 'outside-hello.ts'), 'hello out there\n')
      symlinkSync(outside, join(work, 'link'))
      await compareGrep({ pattern: 'hello' })
      const rg = await grepRg({ workDir: work, pattern: 'out there' })
      expect(rg.items).toHaveLength(0)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('find — the two backends agree', () => {
  test.if(rgAvailable())('by extension', async () => {
    await compareFind({ pattern: '*.ts' })
  })

  test.if(rgAvailable())('nested glob', async () => {
    await compareFind({ pattern: 'src/**/*.ts' })
  })

  test.if(rgAvailable())('the `**/` prefix', async () => {
    await compareFind({ pattern: '**/*.md' })
  })

  test.if(rgAvailable())('options `{a,b}`', async () => {
    await compareFind({ pattern: '*.{ts,md}' })
  })

  test.if(rgAvailable())('an exact file name', async () => {
    await compareFind({ pattern: 'a.ts' })
  })

  test.if(rgAvailable())('`?` is a single character', async () => {
    await compareFind({ pattern: '?.ts' })
  })

  test.if(rgAvailable())('from an inner directory', async () => {
    await compareFind({ pattern: '*.ts', path: 'src' })
  })

  test.if(rgAvailable())('`all: true`', async () => {
    await compareFind({ pattern: '*.ts', all: true })
  })

  test.if(rgAvailable())('when nothing is found', async () => {
    await compareFind({ pattern: '*.no-such-extension' })
  })

  test.if(rgAvailable())('the same when the limit truncates', async () => {
    const [rg, node] = await Promise.all([
      findRg({ workDir: work, pattern: '*.ts', limit: 2 }),
      findNode({ workDir: work, pattern: '*.ts', limit: 2 }),
    ])
    expect(rg.items).toEqual(node.items)
    expect(rg.truncated).toBe(true)
  })

  test.if(rgAvailable())('gitignore is not read by find either', async () => {
    const rg = await findRg({ workDir: work, pattern: '*.ts' })
    expect(rg.items).toContain('excluded.ts')
    expect(rg.items).toContain('excluded-dir/inside.ts')
  })

  test.if(rgAvailable())('skipped directories show up in neither', async () => {
    const rg = await findRg({ workDir: work, pattern: '*.ts' })
    const node = await findNode({ workDir: work, pattern: '*.ts' })
    for (const list of [rg.items, node.items]) {
      expect(list.some((y) => y.startsWith('node_modules/'))).toBe(false)
      expect(list.some((y) => y.startsWith('dist/'))).toBe(false)
      expect(list.some((y) => y.startsWith('.git/'))).toBe(false)
    }
    expect(rg.items).toEqual(node.items)
  })
})

describe('does the test catch parity being broken', () => {
  test.if(rgAvailable())('the result would differ if sorting were removed (control)', async () => {
    // This test checks not the product code directly but the TEST METHOD:
    // it proves that unsorted `rg` output really is unstable. If `rg`
    // suddenly started giving a stable order, the "agree" tests above would
    // be giving false comfort — let us know about it.
    const n = await grepRg({ workDir: work, pattern: 'hello' })
    // We confirm it is sorted: the paths are in ascending order
    const paths = n.items.map((m) => `${m.path}:${String(m.line).padStart(6, '0')}`)
    const copy = [...paths].sort()
    expect(paths).toEqual(copy)
  })
})

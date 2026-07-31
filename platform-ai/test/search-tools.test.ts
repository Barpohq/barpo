// The behaviour of the `grep`/`find`/`ls` tools: limits, cutting,
// formatting, error cases, and the tool interface matching `agent.ts`.
//
// These tests DELIBERATELY force the Node backend (`setRgCache(false)`), so
// that they take EXACTLY this path on a system where `rg` is not installed
// too, and the result is stable. The `rg` path is tested separately in
// `search-parity.test.ts`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  globMatches,
  globToRegExp,
  isBinary,
  ROW_LIMIT,
  prepareLine,
  setRgCache,
  pathOrder,
} from '../src/search-core.ts'
import { findNode, grepNode, lsList } from '../src/search-engine.ts'
import {
  findResultToText,
  createFindTool,
  grepResultToText,
  createGrepTool,
  lsResultToText,
  createLsTool,
  sizeToText,
  SEARCH_PROMPT_SECTION,
  searchTools,
  searchToolsRaw,
} from '../src/search-tools.ts'

let work: string

/** Runs the tool the way `agent.ts` calls it */
async function callTool(
  tool: ReturnType<typeof createGrepTool> | ReturnType<typeof createFindTool> | ReturnType<typeof createLsTool>,
  params: unknown,
): Promise<string> {
  const result = await (tool as {
    execute: (
      id: string,
      p: unknown,
      s: AbortSignal | undefined,
      u: unknown,
      k: { env: { cwd: string } },
    ) => Promise<{ content: { type: string; text?: string }[] }>
  }).execute('test-1', params, undefined, undefined, { env: { cwd: work } })
  return result.content.map((c) => c.text ?? '').join('')
}

beforeEach(() => {
  // Force the Node fallback — this path is tested on a PC that has `rg` too
  setRgCache(false)
  work = mkdtempSync(join(tmpdir(), 'search-tool-'))
})

afterEach(() => {
  setRgCache(undefined)
  rmSync(work, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('glob → regexp', () => {
  test('`*` stays inside a segment', () => {
    expect(globToRegExp('*.ts').test('a.ts')).toBe(true)
    expect(globToRegExp('*.ts').test('src/a.ts')).toBe(false)
  })

  test('`**` crosses segments', () => {
    expect(globToRegExp('src/**/*.ts').test('src/a/b/c.ts')).toBe(true)
  })

  test('`**/` also matches zero segments', () => {
    expect(globToRegExp('**/*.ts').test('a.ts')).toBe(true)
    expect(globToRegExp('**/*.ts').test('a/b.ts')).toBe(true)
  })

  test('`?` is a single character, not `/`', () => {
    expect(globToRegExp('?.ts').test('a.ts')).toBe(true)
    expect(globToRegExp('?.ts').test('ab.ts')).toBe(false)
  })

  test('`{a,b}` options', () => {
    const re = globToRegExp('*.{ts,md}')
    expect(re.test('a.ts')).toBe(true)
    expect(re.test('a.md')).toBe(true)
    expect(re.test('a.js')).toBe(false)
  })

  test('character set `[ab]`', () => {
    expect(globToRegExp('[ab].ts').test('a.ts')).toBe(true)
    expect(globToRegExp('[ab].ts').test('c.ts')).toBe(false)
  })

  test('a dot is escaped as a literal', () => {
    expect(globToRegExp('a.ts').test('axts')).toBe(false)
  })

  test('a pattern without `/` applies to the file name only', () => {
    expect(globMatches('*.ts', 'deep/folder/a.ts')).toBe(true)
    expect(globMatches('src/*.ts', 'deep/folder/a.ts')).toBe(false)
  })
})

describe('helper functions', () => {
  test('pathOrder goes by code point, independent of locale', () => {
    expect(pathOrder('a', 'b')).toBeLessThan(0)
    expect(pathOrder('b', 'a')).toBeGreaterThan(0)
    expect(pathOrder('a', 'a')).toBe(0)
    // Upper case before lower case — ASCII order
    expect(pathOrder('Z', 'a')).toBeLessThan(0)
  })

  test('prepareLine cuts a long line', () => {
    const long = 'x'.repeat(ROW_LIMIT + 100)
    const result = prepareLine(long)
    expect(result.length).toBe(ROW_LIMIT + 1) // + `…`
    expect(result.endsWith('…')).toBe(true)
  })

  test('prepareLine leaves a short line alone', () => {
    expect(prepareLine('short')).toBe('short')
  })

  test('prepareLine strips a trailing `\\r\\n`', () => {
    expect(prepareLine('text\r\n')).toBe('text')
    expect(prepareLine('text\n')).toBe('text')
  })

  test('isBinary detects by NUL byte', () => {
    expect(isBinary(new Uint8Array([1, 2, 0, 3]))).toBe(true)
    expect(isBinary(new Uint8Array([1, 2, 3]))).toBe(false)
  })

  test('sizeToText gives a readable form', () => {
    expect(sizeToText(512)).toBe('512B')
    expect(sizeToText(2048)).toBe('2.0K')
    expect(sizeToText(3 * 1024 * 1024)).toBe('3.0M')
  })
})

// ---------------------------------------------------------------------------

describe('grep tool', () => {
  beforeEach(() => {
    writeFileSync(join(work, 'a.ts'), 'const hello = 1\nconst bye = 2\n')
    mkdirSync(join(work, 'src'), { recursive: true })
    writeFileSync(join(work, 'src', 'b.ts'), 'hello inside\n')
  })

  test('returns the `file:line:text` format', async () => {
    const text = await callTool(createGrepTool(), { pattern: 'hello' })
    expect(text).toBe('a.ts:1:const hello = 1\nsrc/b.ts:1:hello inside')
  })

  test('a clear message when nothing is found', async () => {
    const text = await callTool(createGrepTool(), { pattern: 'no-such-word' })
    expect(text).toBe('No matches found.')
  })

  test('the glob filter works', async () => {
    const text = await callTool(createGrepTool(), { pattern: 'hello', glob: 'src/*.ts' })
    expect(text).toBe('src/b.ts:1:hello inside')
  })

  test('caseInsensitive works', async () => {
    writeFileSync(join(work, 'upper.ts'), 'HELLO\n')
    const text = await callTool(createGrepTool(), { pattern: 'hello', caseInsensitive: true })
    expect(text).toContain('upper.ts:1:HELLO')
  })

  test('throws for an outside path (NO permission is requested)', async () => {
    const attempt = callTool(createGrepTool(), { pattern: 'x', path: '../..' })
    expect(attempt).rejects.toThrow(/Permission denied/)
  })

  test('the detail carries the backend and the count', async () => {
    const tool = createGrepTool()
    const result = await (tool as unknown as {
      execute: (i: string, p: unknown, s: undefined, u: undefined, k: unknown) => Promise<{ details: unknown }>
    }).execute('id', { pattern: 'hello' }, undefined, undefined, { env: { cwd: work } })
    expect(result.details).toEqual({ backend: 'node', count: 2, truncated: false })
  })

  test('says it was truncated when the limit is exceeded', async () => {
    const manyLines = Array.from({ length: 50 }, () => 'hello').join('\n')
    writeFileSync(join(work, 'many.ts'), manyLines + '\n')
    const n = await grepNode({ workDir: work, pattern: 'hello', limit: 10 })
    expect(n.truncated).toBe(true)
    expect(n.items).toHaveLength(10)
    const text = grepResultToText(n)
    expect(text).toContain('capped')
    expect(text).toContain('Narrow the pattern')
  })

  test('a long line is cut in the result', async () => {
    writeFileSync(join(work, 'long.ts'), 'hello ' + 'y'.repeat(3000) + '\n')
    const n = await grepNode({ workDir: work, pattern: 'hello', glob: 'long.ts' })
    expect(n.items[0]!.text.length).toBe(ROW_LIMIT + 1)
  })

  test('skipped directories are not searched by default', async () => {
    mkdirSync(join(work, 'node_modules'), { recursive: true })
    writeFileSync(join(work, 'node_modules', 'x.ts'), 'hello in the package\n')
    const n = await grepNode({ workDir: work, pattern: 'hello' })
    expect(n.items.some((m) => m.path.startsWith('node_modules/'))).toBe(false)
  })

  test('with `all: true` the skipped directories are searched too', async () => {
    mkdirSync(join(work, 'node_modules'), { recursive: true })
    writeFileSync(join(work, 'node_modules', 'x.ts'), 'hello in the package\n')
    const n = await grepNode({ workDir: work, pattern: 'hello', all: true })
    expect(n.items.some((m) => m.path.startsWith('node_modules/'))).toBe(true)
  })

  test('an explicitly requested `node_modules` is searched', async () => {
    // If the agent deliberately passes `path: 'node_modules/package'`, it
    // must be shown — "skipping" only applies to walking the tree
    mkdirSync(join(work, 'node_modules', 'package'), { recursive: true })
    writeFileSync(join(work, 'node_modules', 'package', 'x.ts'), 'hello in the package\n')
    const n = await grepNode({ workDir: work, pattern: 'hello', path: 'node_modules/package' })
    expect(n.items).toHaveLength(1)
  })

  test('a binary file is not searched', async () => {
    writeFileSync(join(work, 'binary.dat'), Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00]))
    const n = await grepNode({ workDir: work, pattern: 'hello' })
    expect(n.items.some((m) => m.path === 'binary.dat')).toBe(false)
  })

  test('an unreadable directory does not break the result', async () => {
    // A symlink to a directory that does not exist — `readdir` errors, but
    // the search must carry on
    symlinkSync(join(work, 'missing'), join(work, 'broken-link'))
    const n = await grepNode({ workDir: work, pattern: 'hello' })
    expect(n.items.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------

describe('find tool', () => {
  beforeEach(() => {
    writeFileSync(join(work, 'a.ts'), '')
    writeFileSync(join(work, 'b.md'), '')
    mkdirSync(join(work, 'src', 'inner'), { recursive: true })
    writeFileSync(join(work, 'src', 'c.ts'), '')
    writeFileSync(join(work, 'src', 'inner', 'd.ts'), '')
  })

  test('finds by glob and sorts', async () => {
    const text = await callTool(createFindTool(), { pattern: '*.ts' })
    expect(text).toBe('a.ts\nsrc/c.ts\nsrc/inner/d.ts')
  })

  test('nested glob', async () => {
    const text = await callTool(createFindTool(), { pattern: 'src/**/*.ts' })
    expect(text).toBe('src/c.ts\nsrc/inner/d.ts')
  })

  test('a clear message when nothing is found', async () => {
    const text = await callTool(createFindTool(), { pattern: '*.none' })
    expect(text).toBe('No files found.')
  })

  test('narrowed by `path`', async () => {
    const text = await callTool(createFindTool(), { pattern: '*.ts', path: 'src/inner' })
    expect(text).toBe('src/inner/d.ts')
  })

  test('says it was truncated when the limit is exceeded', async () => {
    for (let i = 0; i < 20; i += 1) writeFileSync(join(work, `f${i}.txt`), '')
    const n = await findNode({ workDir: work, pattern: '*.txt', limit: 5 })
    expect(n.truncated).toBe(true)
    expect(n.items).toHaveLength(5)
    expect(findResultToText(n)).toContain('capped')
  })

  test('an outside path is rejected', async () => {
    const attempt = callTool(createFindTool(), { pattern: '*', path: '/etc' })
    expect(attempt).rejects.toThrow(/Permission denied/)
  })

  test('skipped directories do not show up by default', async () => {
    mkdirSync(join(work, 'dist'), { recursive: true })
    writeFileSync(join(work, 'dist', 'x.ts'), '')
    const n = await findNode({ workDir: work, pattern: '*.ts' })
    expect(n.items.some((y) => y.startsWith('dist/'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('ls tool', () => {
  beforeEach(() => {
    writeFileSync(join(work, 'small.txt'), 'x'.repeat(100))
    writeFileSync(join(work, 'large.txt'), 'y'.repeat(5000))
    mkdirSync(join(work, 'dir'), { recursive: true })
  })

  test('a directory is shown with `/` and a file with its size', async () => {
    const text = await callTool(createLsTool(), {})
    expect(text).toBe('dir/\nlarge.txt  (4.9K)\nsmall.txt  (100B)')
  })

  test('directories come before files', async () => {
    mkdirSync(join(work, 'zzz-dir'), { recursive: true })
    writeFileSync(join(work, 'aaa.txt'), '')
    const n = await lsList({ workDir: work })
    const kinds = n.items.map((e) => e.kind)
    const firstFile = kinds.indexOf('file')
    const lastDir = kinds.lastIndexOf('dir')
    expect(lastDir).toBeLessThan(firstFile)
  })

  test('a symlink is marked with `@`', async () => {
    symlinkSync(join(work, 'small.txt'), join(work, 'link'))
    const text = await callTool(createLsTool(), {})
    expect(text).toContain('link@')
  })

  test('lists an inner directory', async () => {
    writeFileSync(join(work, 'dir', 'inside.txt'), 'z')
    const text = await callTool(createLsTool(), { path: 'dir' })
    expect(text).toBe('inside.txt  (1B)')
  })

  test('a message for an empty directory', async () => {
    const text = await callTool(createLsTool(), { path: 'dir' })
    expect(text).toBe('The directory is empty.')
  })

  test('skipped directories are hidden by default', async () => {
    mkdirSync(join(work, 'node_modules'), { recursive: true })
    const n = await lsList({ workDir: work })
    expect(n.items.some((e) => e.name === 'node_modules')).toBe(false)
  })

  test('with `all: true` they show up too', async () => {
    mkdirSync(join(work, 'node_modules'), { recursive: true })
    const n = await lsList({ workDir: work, all: true })
    expect(n.items.some((e) => e.name === 'node_modules')).toBe(true)
  })

  test('a clear error for a directory that does not exist', async () => {
    const attempt = lsList({ workDir: work, path: 'no-such-dir' })
    expect(attempt).rejects.toThrow(/Not found/)
  })

  test('a "not a directory" error when a file is passed', async () => {
    const attempt = lsList({ workDir: work, path: 'small.txt' })
    expect(attempt).rejects.toThrow(/Not a directory/)
  })

  test('an outside path is rejected', async () => {
    const attempt = callTool(createLsTool(), { path: '/etc' })
    expect(attempt).rejects.toThrow(/Permission denied/)
  })

  test('says it was truncated when the limit is exceeded', async () => {
    for (let i = 0; i < 20; i += 1) writeFileSync(join(work, `f${i}.txt`), '')
    const n = await lsList({ workDir: work, limit: 5 })
    expect(n.truncated).toBe(true)
    expect(lsResultToText(n)).toContain('capped')
  })
})

// ---------------------------------------------------------------------------

describe('the tool interface matches agent.ts', () => {
  test('all three tools come back', () => {
    expect(searchToolsRaw().map((t) => t.name)).toEqual(['grep', 'find', 'ls'])
    expect(searchTools({ env: { cwd: work } }).map((t) => t.name)).toEqual(['grep', 'find', 'ls'])
  })

  test('in the raw shape the context is expected as the 5th argument', () => {
    for (const tool of searchToolsRaw()) {
      expect(typeof tool.name).toBe('string')
      expect(typeof tool.label).toBe('string')
      expect(typeof tool.description).toBe('string')
      expect(tool.parameters).toBeDefined()
      expect(typeof tool.execute).toBe('function')
      // pi's `AgentHarnessTool` shape — the context is the last argument
      expect(tool.execute.length).toBe(5)
    }
  })

  test("in the bound shape `execute` matches pi's AgentTool shape (4 arguments)", () => {
    // `agent.ts` can hand this list straight to `Agent`: the context is
    // already inside, no extra wrapper is needed
    for (const tool of searchTools({ env: { cwd: work } })) {
      expect(typeof tool.execute).toBe('function')
      expect(tool.execute.length).toBe(4)
    }
  })

  test('a bound tool works when called without a context too', async () => {
    // The main point: can `agent.ts` call the tool returned by
    // `searchTools(context)` WITHOUT a context — that is, was `cwd` really
    // bound? If the binding did not work, there would be an error here.
    writeFileSync(join(work, 'a.txt'), 'hello\n')
    const [grep] = searchTools({ env: { cwd: work } })
    const result = await grep!.execute('id', { pattern: 'hello' } as never, undefined)
    const text = (result.content as { type: string; text: string }[])[0]!.text
    expect(text).toBe('a.txt:1:hello')
  })

  test('the schemas are typebox objects (that is what pi expects)', () => {
    for (const tool of searchToolsRaw()) {
      const schema = tool.parameters as { type?: string; properties?: Record<string, unknown> }
      expect(schema.type).toBe('object')
      expect(schema.properties).toBeDefined()
    }
  })

  test('`pattern` is required in the grep schema', () => {
    const schema = searchToolsRaw()[0]!.parameters as { required?: string[] }
    expect(schema.required).toContain('pattern')
  })

  test('SEARCH_PROMPT_SECTION mentions all three tools', () => {
    const all = [...SEARCH_PROMPT_SECTION.list, ...SEARCH_PROMPT_SECTION.rules].join('\n')
    expect(SEARCH_PROMPT_SECTION.list).toHaveLength(3)
    for (const name of ['grep', 'find', 'ls']) expect(all).toContain(name)
    // The rules must say to use these instead of `bash`
    expect(all).toContain('bash')
  })

  test('the tool result is in pi shape', async () => {
    writeFileSync(join(work, 'a.txt'), 'hello\n')
    const tool = createGrepTool()
    const result = await (tool as unknown as {
      execute: (i: string, p: unknown, s: undefined, u: undefined, k: unknown) => Promise<{
        content: { type: string; text: string }[]
      }>
    }).execute('id', { pattern: 'hello' }, undefined, undefined, { env: { cwd: work } })
    expect(result.content).toHaveLength(1)
    expect(result.content[0]!.type).toBe('text')
  })

  test('an abort signal stops the search', async () => {
    for (let i = 0; i < 50; i += 1) writeFileSync(join(work, `f${i}.txt`), 'hello\n')
    const controller = new AbortController()
    controller.abort()
    const attempt = grepNode({ workDir: work, pattern: 'hello', signal: controller.signal })
    expect(attempt).rejects.toThrow()
  })
})

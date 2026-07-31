// The tar reader — mostly a zip-slip defence test.
//
// The archive comes from a stranger's GitHub repo, so the paths inside it may
// be hostile. `sanitisePath` is the only barrier — if it fell over, the
// archive could write outside the target folder.

import { describe, expect, test } from 'bun:test'
import { readTar, sanitisePath } from '../src/tar.ts'

describe('sanitisePath — zip-slip defence', () => {
  test('an ordinary path passes through', () => {
    expect(sanitisePath('a/b/c.txt')).toBe('a/b/c.txt')
  })

  test('a `..` segment is REJECTED', () => {
    expect(sanitisePath('../evil.txt')).toBeNull()
    expect(sanitisePath('a/../../evil.txt')).toBeNull()
    expect(sanitisePath('a/b/../../../etc/passwd')).toBeNull()
  })

  test('an absolute path is rejected', () => {
    expect(sanitisePath('/etc/passwd')).toBeNull()
    expect(sanitisePath('/root/.ssh/authorized_keys')).toBeNull()
  })

  test('a Windows drive prefix is rejected', () => {
    expect(sanitisePath('C:/Windows/system32')).toBeNull()
  })

  test('a backslash counts as a separator too', () => {
    // `..\..\x` must not slip through as an ordinary file name
    expect(sanitisePath('..\\..\\evil.txt')).toBeNull()
    expect(sanitisePath('a\\b\\c.txt')).toBe('a/b/c.txt')
  })

  test('a NUL byte is rejected', () => {
    expect(sanitisePath('a/\0b')).toBeNull()
  })

  test('redundant `.` and empty segments are cleaned away', () => {
    expect(sanitisePath('./a//b/./c')).toBe('a/b/c')
  })

  test('an empty path is null', () => {
    expect(sanitisePath('')).toBeNull()
    expect(sanitisePath('.')).toBeNull()
    expect(sanitisePath('/')).toBeNull()
  })
})

// ---------------------------------------------------------------------------

/** Builds a minimal tar archive for the tests */
function buildTar(files: { path: string; contents: string; kind?: string }[]): Uint8Array {
  const blocks: Uint8Array[] = []

  for (const f of files) {
    const header = new Uint8Array(512)
    const encoder = new TextEncoder()

    const name = encoder.encode(f.path)
    header.set(name.subarray(0, 100), 0)

    const contents = encoder.encode(f.contents)
    // Size — 11 octal digits plus a NUL
    const size = contents.length.toString(8).padStart(11, '0')
    header.set(encoder.encode(size), 124)
    header[135] = 0

    header[156] = (f.kind ?? '0').charCodeAt(0)

    blocks.push(header)

    const padded = new Uint8Array(Math.ceil(contents.length / 512) * 512)
    padded.set(contents)
    blocks.push(padded)
  }

  // The end marker: two empty blocks
  blocks.push(new Uint8Array(1024))

  const total = blocks.reduce((s, b) => s + b.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const b of blocks) {
    result.set(b, offset)
    offset += b.length
  }
  return result
}

describe('readTar', () => {
  test('ordinary files are read out', () => {
    const archive = buildTar([
      { path: 'repo/SKILL.md', contents: 'hello' },
      { path: 'repo/scripts/x.sh', contents: 'echo hi' },
    ])

    const result = readTar(archive, 1024 * 1024)
    expect(result).toHaveLength(2)
    expect(result[0]?.path).toBe('repo/SKILL.md')
    expect(new TextDecoder().decode(result[0]?.contents)).toBe('hello')
  })

  test('an entry with a DANGEROUS PATH is dropped silently, the rest is read', () => {
    const archive = buildTar([
      { path: 'repo/good.txt', contents: 'ok' },
      { path: '../../etc/passwd', contents: 'evil' },
      { path: 'repo/also-good.txt', contents: 'ok2' },
    ])

    const result = readTar(archive, 1024 * 1024)
    expect(result).toHaveLength(2)
    expect(result.every((f) => !f.path.includes('..'))).toBe(true)
    expect(result.every((f) => !f.path.startsWith('/'))).toBe(true)
  })

  test('directory entries are dropped', () => {
    const archive = buildTar([
      { path: 'repo/folder/', contents: '', kind: '5' },
      { path: 'repo/file.txt', contents: 'x' },
    ])
    expect(readTar(archive, 1024 * 1024)).toHaveLength(1)
  })

  test('symlink entries are dropped — they must not become a way out', () => {
    const archive = buildTar([
      { path: 'repo/link', contents: '/etc/passwd', kind: '2' },
      { path: 'repo/file.txt', contents: 'x' },
    ])
    const result = readTar(archive, 1024 * 1024)
    expect(result).toHaveLength(1)
    expect(result[0]?.path).toBe('repo/file.txt')
  })

  test('exceeding the size limit throws — zip bomb defence', () => {
    const archive = buildTar([{ path: 'repo/big.bin', contents: 'x'.repeat(5000) }])
    expect(() => readTar(archive, 1000)).toThrow(/too large/)
  })

  test('an empty archive yields an empty list', () => {
    expect(readTar(new Uint8Array(1024), 1024)).toEqual([])
  })
})

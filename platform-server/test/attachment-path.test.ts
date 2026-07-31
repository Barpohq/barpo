// The PATH layer for attachments: picking the directory, sanitising the name
// and detecting the kind. Neither the database nor HTTP takes part here — it is
// all pure functions or the file system.
//
// Name sanitisation is a SECURITY BOUNDARY: the name is written to disk and
// shown to the agent in the prompt, so both path escapes (`../`) and shell
// metacharacters have to be closed off right here. That is why the tests check
// ATTACK patterns rather than "does it work".

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { imageExtension, imageKind } from '../src/attachment.ts'
import {
  freeName,
  FILES_DIR,
  SESSION_DIR,
  sessionFilesDir,
  uploadName,
} from '../src/work-dir.ts'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'platform-attachment-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('sessionFilesDir', () => {
  test('the directory is created and the relative path comes back', () => {
    const { full, relative } = sessionFilesDir(tempDir, 'sid-1')

    expect(existsSync(full)).toBe(true)
    expect(relative).toBe(join(SESSION_DIR, 'sid-1', FILES_DIR))
    expect(full).toBe(join(tempDir, relative))
  })

  test('every session gets its own directory', () => {
    const one = sessionFilesDir(tempDir, 'sid-1')
    const two = sessionFilesDir(tempDir, 'sid-2')

    expect(one.full).not.toBe(two.full)
    expect(existsSync(one.full)).toBe(true)
    expect(existsSync(two.full)).toBe(true)
  })

  // The session id is a UUID, but a value arriving from outside is never
  // trusted — the same rule as in `workDir()`.
  test('path characters in the session id are stripped', () => {
    const { full } = sessionFilesDir(tempDir, '../../escaped')

    expect(full.startsWith(tempDir)).toBe(true)
    expect(full).not.toContain('..')
  })
})

describe('uploadName', () => {
  test('an ordinary name is left alone', () => {
    expect(uploadName('report.pdf')).toBe('report.pdf')
    expect(uploadName('main_test-2.ts')).toBe('main_test-2.ts')
  })

  test('the extension is kept and lower-cased', () => {
    expect(uploadName('Picture.PNG')).toBe('Picture.png')
  })

  test('`../../etc/passwd` — only the last segment survives', () => {
    expect(uploadName('../../etc/passwd')).toBe('passwd')
  })

  test('a Windows path is cut down too', () => {
    expect(uploadName('C:\\Users\\ms\\picture.png')).toBe('picture.png')
  })

  test('no shell metacharacters are left', () => {
    const name = uploadName('"; rm -rf ~; #.png')

    expect(name).not.toBeNull()
    expect(name).toMatch(/^[a-zA-Z0-9_.-]+$/)
    expect(name).not.toContain(';')
    expect(name).not.toContain(' ')
  })

  test('NUL and other control characters are dropped', () => {
    expect(uploadName('file\u0000.txt')).toBe('file.txt')
  })

  test('a name that is nothing but emoji or Cyrillic gives null', () => {
    expect(uploadName('🎉🎉')).toBeNull()
    expect(uploadName('ҳисобот')).toBeNull()
    expect(uploadName('')).toBeNull()
    expect(uploadName('...')).toBeNull()
  })

  // An image pasted from the clipboard arrives without a name and Bun gives
  // `File.name` as `undefined` — a real case, found in testing
  test('an undefined name gives null rather than throwing', () => {
    expect(uploadName(undefined)).toBeNull()
    expect(uploadName(null)).toBeNull()
  })

  test('a long name is truncated without losing the extension', () => {
    const name = uploadName(`${'a'.repeat(500)}.pdf`)

    expect(name).not.toBeNull()
    expect(name!.endsWith('.pdf')).toBe(true)
    expect(name!.length).toBeLessThanOrEqual(100)
  })

  // In `.env` the leading dot is not an extension but part of the stem. The dot
  // becomes `-`, and a dash at either edge is trimmed, so an uploaded hidden
  // file does not stay hidden — that is deliberate: a file the user attached
  // should be visible in the folder.
  test('a name starting with a dot does not stay hidden', () => {
    expect(uploadName('.env')).toBe('env')
    expect(uploadName('.gitignore')).toBe('gitignore')
  })

  test('a name with no extension is accepted', () => {
    expect(uploadName('Makefile')).toBe('Makefile')
  })
})

describe('freeName', () => {
  test('in an empty directory the name is unchanged', () => {
    expect(freeName(tempDir, 'a.png')).toBe('a.png')
  })

  test('a taken name gets -2, and the extension stays where it is', () => {
    writeFileSync(join(tempDir, 'a.png'), 'x')

    expect(freeName(tempDir, 'a.png')).toBe('a-2.png')
  })

  test('successive names keep counting up', () => {
    writeFileSync(join(tempDir, 'a.png'), 'x')
    writeFileSync(join(tempDir, 'a-2.png'), 'x')

    expect(freeName(tempDir, 'a.png')).toBe('a-3.png')
  })

  test('a name with no extension gets the suffix too', () => {
    writeFileSync(join(tempDir, 'Makefile'), 'x')

    expect(freeName(tempDir, 'Makefile')).toBe('Makefile-2')
  })
})

describe('imageKind', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0])
  const webp = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ])

  test('all four kinds are recognised', () => {
    expect(imageKind(png)).toBe('image/png')
    expect(imageKind(jpeg)).toBe('image/jpeg')
    expect(imageKind(gif)).toBe('image/gif')
    expect(imageKind(webp)).toBe('image/webp')
  })

  test('JPEG-LS is rejected — the providers do not support it', () => {
    expect(imageKind(new Uint8Array([0xff, 0xd8, 0xff, 0xf7, 0, 0]))).toBeNull()
  })

  test('a RIFF container that is not WEBP is not an image (WAV)', () => {
    const wav = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ])

    expect(imageKind(wav)).toBeNull()
  })

  // The most important case: the extension lies
  test('a ZIP called `.png` is NOT an image', () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])

    expect(imageKind(zip)).toBeNull()
  })

  test('an SVG does not count as an image — it is an ordinary file', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">')

    expect(imageKind(svg)).toBeNull()
  })

  test('a very short byte stream does not break it', () => {
    expect(imageKind(new Uint8Array([]))).toBeNull()
    expect(imageKind(new Uint8Array([0x89, 0x50]))).toBeNull()
    // RIFF is there, but it does not reach bytes 8-11
    expect(imageKind(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0]))).toBeNull()
  })
})

describe('imageExtension', () => {
  test('every kind has an extension', () => {
    expect(imageExtension('image/png')).toBe('png')
    expect(imageExtension('image/jpeg')).toBe('jpg')
    expect(imageExtension('image/gif')).toBe('gif')
    expect(imageExtension('image/webp')).toBe('webp')
  })
})

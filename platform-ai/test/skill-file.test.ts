// Parsing `SKILL.md` — the frontmatter and the lenient validation.
//
// The core rule is what is tested: ONLY a missing `description` rejects the
// skill; every other spec violation comes back as a warning and the skill
// loads anyway.

import { describe, expect, test } from 'bun:test'
import { NAME_LIMIT, parseSkillFile, DESCRIPTION_LIMIT } from '../src/skill-file.ts'

describe('frontmatter', () => {
  test('an ordinary skill is read in full', () => {
    const r = parseSkillFile(
      ['---', 'name: pdf-fill', 'description: Fills in a PDF form', '---', '', '# Instructions'].join('\n'),
      'pdf-fill',
    )
    expect(r?.name).toBe('pdf-fill')
    expect(r?.description).toBe('Fills in a PDF form')
    expect(r?.text).toBe('# Instructions')
    expect(r?.warnings).toEqual([])
  })

  test('null when there is no frontmatter', () => {
    expect(parseSkillFile('# Just markdown', 'x')).toBeNull()
  })

  test('null when description is missing — THE ONLY strict requirement', () => {
    expect(parseSkillFile(['---', 'name: x', '---', 'text'].join('\n'), 'x')).toBeNull()
  })

  test('an empty description is rejected too', () => {
    expect(
      parseSkillFile(['---', 'name: x', 'description: "   "', '---'].join('\n'), 'x'),
    ).toBeNull()
  })

  test('a missing name is taken from the folder name', () => {
    const r = parseSkillFile(['---', 'description: a description', '---'].join('\n'), 'folder-name')
    expect(r?.name).toBe('folder-name')
    // When taken from the folder name the "does not match" warning is NOT emitted
    expect(r?.warnings).toEqual([])
  })

  test('quoted values are cleaned up', () => {
    const r = parseSkillFile(
      ['---', 'name: "pdf-fill"', "description: 'Description text'", '---'].join('\n'),
      'pdf-fill',
    )
    expect(r?.name).toBe('pdf-fill')
    expect(r?.description).toBe('Description text')
  })

  test('comments are dropped', () => {
    const r = parseSkillFile(
      ['---', '# this is a comment', 'name: x # a trailing comment', 'description: a description', '---'].join('\n'),
      'x',
    )
    expect(r?.name).toBe('x')
  })

  test('it works with CRLF and a BOM too', () => {
    const r = parseSkillFile('﻿---\r\nname: x\r\ndescription: a description\r\n---\r\ntext', 'x')
    expect(r?.name).toBe('x')
    expect(r?.description).toBe('a description')
  })
})

describe('block scalars (|, >) — they turn up in anthropics/skills', () => {
  test('a `|-` multi-line description is read in full', () => {
    // The `claude-api` skill has exactly this shape. The description used to
    // come out as "|-" and the model did not know when to use the skill.
    const r = parseSkillFile(
      [
        '---',
        'name: claude-api',
        'description: |-',
        '  First line of text.',
        '  Second line of text.',
        'license: MIT',
        '---',
        '',
        '# Body',
      ].join('\n'),
      'claude-api',
    )
    expect(r?.description).toBe('First line of text.\nSecond line of text.')
    expect(r?.license).toBe('MIT')
    expect(r?.text).toBe('# Body')
  })

  test('`|` works without chomping too', () => {
    const r = parseSkillFile(
      ['---', 'name: x', 'description: |', '  The text is here.', '---'].join('\n'),
      'x',
    )
    expect(r?.description).toBe('The text is here.')
  })

  test('a `>` folded block is joined onto one line', () => {
    const r = parseSkillFile(
      ['---', 'name: x', 'description: >-', '  One', '  two', '---'].join('\n'),
      'x',
    )
    expect(r?.description).toBe('One two')
  })

  test('an empty line inside a block separates paragraphs', () => {
    const r = parseSkillFile(
      ['---', 'name: x', 'description: |-', '  One', '', '  Two', '---'].join('\n'),
      'x',
    )
    expect(r?.description).toContain('One')
    expect(r?.description).toContain('Two')
  })

  test('the keys after a block are read correctly', () => {
    const r = parseSkillFile(
      [
        '---',
        'description: |-',
        '  Description text',
        'name: next-key',
        'allowed-tools: [read]',
        '---',
      ].join('\n'),
      'folder',
    )
    expect(r?.description).toBe('Description text')
    expect(r?.name).toBe('next-key')
    expect(r?.allowedTools).toEqual(['read'])
  })

  test('an empty block does not bring the skill down', () => {
    // the description stays empty → null (a skill without a description is not accepted)
    expect(parseSkillFile(['---', 'name: x', 'description: |-', '---'].join('\n'), 'x')).toBeNull()
  })
})

describe('allowed-tools', () => {
  test('an inline list', () => {
    const r = parseSkillFile(
      ['---', 'name: x', 'description: d', 'allowed-tools: [read, bash]', '---'].join('\n'),
      'x',
    )
    expect(r?.allowedTools).toEqual(['read', 'bash'])
  })

  test('a block list', () => {
    const r = parseSkillFile(
      ['---', 'name: x', 'description: d', 'allowed-tools:', '  - read', '  - write', '---'].join('\n'),
      'x',
    )
    expect(r?.allowedTools).toEqual(['read', 'write'])
  })

  test('a comma-separated string', () => {
    const r = parseSkillFile(
      ['---', 'name: x', 'description: d', 'allowed-tools: read, bash', '---'].join('\n'),
      'x',
    )
    expect(r?.allowedTools).toEqual(['read', 'bash'])
  })

  test('undefined when absent', () => {
    const r = parseSkillFile(['---', 'name: x', 'description: d', '---'].join('\n'), 'x')
    expect(r?.allowedTools).toBeUndefined()
  })
})

describe('LENIENT validation — a broken skill still loads', () => {
  test('an uppercase name warns, but loads', () => {
    const r = parseSkillFile(['---', 'name: PDF-Fill', 'description: d', '---'].join('\n'), 'PDF-Fill')
    expect(r).not.toBeNull()
    expect(r?.name).toBe('PDF-Fill')
    expect(r?.warnings.some((x) => x.includes('lowercase'))).toBe(true)
  })

  test('a repeated dash is warned about', () => {
    const r = parseSkillFile(['---', 'name: a--b', 'description: d', '---'].join('\n'), 'a--b')
    expect(r?.warnings.some((x) => x.includes('repeated'))).toBe(true)
  })

  test('a long name is truncated', () => {
    const long = 'a'.repeat(NAME_LIMIT + 20)
    const r = parseSkillFile(['---', `name: ${long}`, 'description: d', '---'].join('\n'), long)
    expect(r?.name.length).toBe(NAME_LIMIT)
    expect(r?.warnings.some((x) => x.includes('longer than'))).toBe(true)
  })

  test('a long description is truncated — the prompt must not balloon', () => {
    const long = 'b'.repeat(DESCRIPTION_LIMIT + 500)
    const r = parseSkillFile(['---', 'name: x', `description: ${long}`, '---'].join('\n'), 'x')
    expect(r!.description.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT + 1)
    expect(r?.warnings.some((x) => x.includes('longer than'))).toBe(true)
  })

  test('a name that does not match the folder name warns (but is not rejected)', () => {
    // pi is deliberately like this: a strict requirement gets in the way when
    // a folder is shared between several tools
    const r = parseSkillFile(['---', 'name: other', 'description: d', '---'].join('\n'), 'folder')
    expect(r?.name).toBe('other')
    expect(r?.warnings.some((x) => x.includes('folder'))).toBe(true)
  })
})

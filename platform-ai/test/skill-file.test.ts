// `SKILL.md` tahlili — frontmatter va yumshoq validatsiya.
//
// Asosiy qoida sinaladi: FAQAT `description` yo'qligi skillni rad etadi,
// qolgan hamma spec buzilishi ogohlantirish bo'lib qaytadi va skill
// baribir yuklanadi.

import { describe, expect, test } from 'bun:test'
import { NAME_LIMIT, parseSkillFile, DESCRIPTION_LIMIT } from '../src/skill-file.ts'

describe('frontmatter', () => {
  test('oddiy skill to\'liq o\'qiladi', () => {
    const n = parseSkillFile(
      ['---', 'name: pdf-fill', 'description: PDF forma to\'ldiradi', '---', '', '# Ko\'rsatma'].join('\n'),
      'pdf-fill',
    )
    expect(n?.nom).toBe('pdf-fill')
    expect(n?.tavsif).toBe("PDF forma to'ldiradi")
    expect(n?.matn).toBe("# Ko'rsatma")
    expect(n?.ogohlantirishlar).toEqual([])
  })

  test('frontmatter yo\'q bo\'lsa null', () => {
    expect(parseSkillFile('# Shunchaki markdown', 'x')).toBeNull()
  })

  test('description yo\'q bo\'lsa null — YAGONA qat\'iy talab', () => {
    expect(parseSkillFile(['---', 'name: x', '---', 'matn'].join('\n'), 'x')).toBeNull()
  })

  test('bo\'sh description ham rad etiladi', () => {
    expect(
      parseSkillFile(['---', 'name: x', 'description: "   "', '---'].join('\n'), 'x'),
    ).toBeNull()
  })

  test('nom yo\'q bo\'lsa papka nomidan olinadi', () => {
    const n = parseSkillFile(['---', 'description: tavsif', '---'].join('\n'), 'papka-nomi')
    expect(n?.nom).toBe('papka-nomi')
    // Papka nomidan olinganda "mos emas" ogohlantirishi CHIQMAYDI
    expect(n?.ogohlantirishlar).toEqual([])
  })

  test('qo\'shtirnoqli qiymatlar tozalanadi', () => {
    const n = parseSkillFile(
      ['---', 'name: "pdf-fill"', "description: 'Tavsif matni'", '---'].join('\n'),
      'pdf-fill',
    )
    expect(n?.nom).toBe('pdf-fill')
    expect(n?.tavsif).toBe('Tavsif matni')
  })

  test('izohlar tashlanadi', () => {
    const n = parseSkillFile(
      ['---', '# bu izoh', 'name: x # yon izoh', 'description: tavsif', '---'].join('\n'),
      'x',
    )
    expect(n?.nom).toBe('x')
  })

  test('CRLF va BOM bilan ham ishlaydi', () => {
    const n = parseSkillFile('﻿---\r\nname: x\r\ndescription: tavsif\r\n---\r\nmatn', 'x')
    expect(n?.nom).toBe('x')
    expect(n?.tavsif).toBe('tavsif')
  })
})

describe('blok skalari (|, >) — anthropics/skills da uchraydi', () => {
  test('`|-` ko\'p qatorli tavsif to\'liq o\'qiladi', () => {
    // `claude-api` skilli aynan shu shaklda. Ilgari tavsif "|-" bo'lib
    // qolardi va model skillni qachon ishlatishni bilmasdi.
    const n = parseSkillFile(
      [
        '---',
        'name: claude-api',
        'description: |-',
        '  Birinchi qator matni.',
        '  Ikkinchi qator matni.',
        'license: MIT',
        '---',
        '',
        '# Tana',
      ].join('\n'),
      'claude-api',
    )
    expect(n?.tavsif).toBe('Birinchi qator matni.\nIkkinchi qator matni.')
    expect(n?.litsenziya).toBe('MIT')
    expect(n?.matn).toBe('# Tana')
  })

  test('`|` chomping\'siz ham ishlaydi', () => {
    const n = parseSkillFile(
      ['---', 'name: x', 'description: |', '  Matn shu yerda.', '---'].join('\n'),
      'x',
    )
    expect(n?.tavsif).toBe('Matn shu yerda.')
  })

  test('`>` buklangan blok bitta satrga qo\'shiladi', () => {
    const n = parseSkillFile(
      ['---', 'name: x', 'description: >-', '  Bir', '  ikki', '---'].join('\n'),
      'x',
    )
    expect(n?.tavsif).toBe('Bir ikki')
  })

  test('blok ichidagi bo\'sh qator abzasni ajratadi', () => {
    const n = parseSkillFile(
      ['---', 'name: x', 'description: |-', '  Bir', '', '  Ikki', '---'].join('\n'),
      'x',
    )
    expect(n?.tavsif).toContain('Bir')
    expect(n?.tavsif).toContain('Ikki')
  })

  test('blokdan keyingi kalitlar to\'g\'ri o\'qiladi', () => {
    const n = parseSkillFile(
      [
        '---',
        'description: |-',
        '  Tavsif matni',
        'name: keyingi-kalit',
        'allowed-tools: [read]',
        '---',
      ].join('\n'),
      'papka',
    )
    expect(n?.tavsif).toBe('Tavsif matni')
    expect(n?.nom).toBe('keyingi-kalit')
    expect(n?.allowedTools).toEqual(['read'])
  })

  test('bo\'sh blok skill\'ni yiqitmaydi', () => {
    // description bo'sh qoladi → null (tavsifsiz skill qabul qilinmaydi)
    expect(parseSkillFile(['---', 'name: x', 'description: |-', '---'].join('\n'), 'x')).toBeNull()
  })
})

describe('allowed-tools', () => {
  test('inline ro\'yxat', () => {
    const n = parseSkillFile(
      ['---', 'name: x', 'description: t', 'allowed-tools: [read, bash]', '---'].join('\n'),
      'x',
    )
    expect(n?.allowedTools).toEqual(['read', 'bash'])
  })

  test('blok ro\'yxat', () => {
    const n = parseSkillFile(
      ['---', 'name: x', 'description: t', 'allowed-tools:', '  - read', '  - write', '---'].join('\n'),
      'x',
    )
    expect(n?.allowedTools).toEqual(['read', 'write'])
  })

  test('vergul bilan ajratilgan satr', () => {
    const n = parseSkillFile(
      ['---', 'name: x', 'description: t', 'allowed-tools: read, bash', '---'].join('\n'),
      'x',
    )
    expect(n?.allowedTools).toEqual(['read', 'bash'])
  })

  test('yo\'q bo\'lsa undefined', () => {
    const n = parseSkillFile(['---', 'name: x', 'description: t', '---'].join('\n'), 'x')
    expect(n?.allowedTools).toBeUndefined()
  })
})

describe('YUMSHOQ validatsiya — buzilgan skill baribir yuklanadi', () => {
  test('katta harfli nom ogohlantirish beradi, lekin yuklanadi', () => {
    const n = parseSkillFile(['---', 'name: PDF-Fill', 'description: t', '---'].join('\n'), 'PDF-Fill')
    expect(n).not.toBeNull()
    expect(n?.nom).toBe('PDF-Fill')
    expect(n?.ogohlantirishlar.some((x) => x.includes('lowercase'))).toBe(true)
  })

  test('ketma-ket tire ogohlantiriladi', () => {
    const n = parseSkillFile(['---', 'name: a--b', 'description: t', '---'].join('\n'), 'a--b')
    expect(n?.ogohlantirishlar.some((x) => x.includes('repeated'))).toBe(true)
  })

  test('uzun nom kesiladi', () => {
    const uzun = 'a'.repeat(NAME_LIMIT + 20)
    const n = parseSkillFile(['---', `name: ${uzun}`, 'description: t', '---'].join('\n'), uzun)
    expect(n?.nom.length).toBe(NAME_LIMIT)
    expect(n?.ogohlantirishlar.some((x) => x.includes('longer than'))).toBe(true)
  })

  test('uzun tavsif kesiladi — prompt shishib ketmasin', () => {
    const uzun = 'b'.repeat(DESCRIPTION_LIMIT + 500)
    const n = parseSkillFile(['---', 'name: x', `description: ${uzun}`, '---'].join('\n'), 'x')
    expect(n!.tavsif.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT + 1)
    expect(n?.ogohlantirishlar.some((x) => x.includes('longer than'))).toBe(true)
  })

  test('nom papka nomiga mos kelmasa ogohlantirish (lekin rad etilmaydi)', () => {
    // pi ataylab shunday: bir papka bir necha vosita bilan bo'lishilganda
    // qat'iy talab halal beradi
    const n = parseSkillFile(['---', 'name: boshqa', 'description: t', '---'].join('\n'), 'papka')
    expect(n?.nom).toBe('boshqa')
    expect(n?.ogohlantirishlar.some((x) => x.includes('papka'))).toBe(true)
  })
})

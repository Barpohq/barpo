// `SKILL.md` tahlili — frontmatter va yumshoq validatsiya.
//
// Asosiy qoida sinaladi: FAQAT `description` yo'qligi skillni rad etadi,
// qolgan hamma spec buzilishi ogohlantirish bo'lib qaytadi va skill
// baribir yuklanadi.

import { describe, expect, test } from 'bun:test'
import { NOM_CHEGARASI, skillFayliniTahlil, TAVSIF_CHEGARASI } from '../src/skill-fayl.ts'

describe('frontmatter', () => {
  test('oddiy skill to\'liq o\'qiladi', () => {
    const n = skillFayliniTahlil(
      ['---', 'name: pdf-fill', 'description: PDF forma to\'ldiradi', '---', '', '# Ko\'rsatma'].join('\n'),
      'pdf-fill',
    )
    expect(n?.nom).toBe('pdf-fill')
    expect(n?.tavsif).toBe("PDF forma to'ldiradi")
    expect(n?.matn).toBe("# Ko'rsatma")
    expect(n?.ogohlantirishlar).toEqual([])
  })

  test('frontmatter yo\'q bo\'lsa null', () => {
    expect(skillFayliniTahlil('# Shunchaki markdown', 'x')).toBeNull()
  })

  test('description yo\'q bo\'lsa null — YAGONA qat\'iy talab', () => {
    expect(skillFayliniTahlil(['---', 'name: x', '---', 'matn'].join('\n'), 'x')).toBeNull()
  })

  test('bo\'sh description ham rad etiladi', () => {
    expect(
      skillFayliniTahlil(['---', 'name: x', 'description: "   "', '---'].join('\n'), 'x'),
    ).toBeNull()
  })

  test('nom yo\'q bo\'lsa papka nomidan olinadi', () => {
    const n = skillFayliniTahlil(['---', 'description: tavsif', '---'].join('\n'), 'papka-nomi')
    expect(n?.nom).toBe('papka-nomi')
    // Papka nomidan olinganda "mos emas" ogohlantirishi CHIQMAYDI
    expect(n?.ogohlantirishlar).toEqual([])
  })

  test('qo\'shtirnoqli qiymatlar tozalanadi', () => {
    const n = skillFayliniTahlil(
      ['---', 'name: "pdf-fill"', "description: 'Tavsif matni'", '---'].join('\n'),
      'pdf-fill',
    )
    expect(n?.nom).toBe('pdf-fill')
    expect(n?.tavsif).toBe('Tavsif matni')
  })

  test('izohlar tashlanadi', () => {
    const n = skillFayliniTahlil(
      ['---', '# bu izoh', 'name: x # yon izoh', 'description: tavsif', '---'].join('\n'),
      'x',
    )
    expect(n?.nom).toBe('x')
  })

  test('CRLF va BOM bilan ham ishlaydi', () => {
    const n = skillFayliniTahlil('﻿---\r\nname: x\r\ndescription: tavsif\r\n---\r\nmatn', 'x')
    expect(n?.nom).toBe('x')
    expect(n?.tavsif).toBe('tavsif')
  })
})

describe('blok skalari (|, >) — anthropics/skills da uchraydi', () => {
  test('`|-` ko\'p qatorli tavsif to\'liq o\'qiladi', () => {
    // `claude-api` skilli aynan shu shaklda. Ilgari tavsif "|-" bo'lib
    // qolardi va model skillni qachon ishlatishni bilmasdi.
    const n = skillFayliniTahlil(
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
    const n = skillFayliniTahlil(
      ['---', 'name: x', 'description: |', '  Matn shu yerda.', '---'].join('\n'),
      'x',
    )
    expect(n?.tavsif).toBe('Matn shu yerda.')
  })

  test('`>` buklangan blok bitta satrga qo\'shiladi', () => {
    const n = skillFayliniTahlil(
      ['---', 'name: x', 'description: >-', '  Bir', '  ikki', '---'].join('\n'),
      'x',
    )
    expect(n?.tavsif).toBe('Bir ikki')
  })

  test('blok ichidagi bo\'sh qator abzasni ajratadi', () => {
    const n = skillFayliniTahlil(
      ['---', 'name: x', 'description: |-', '  Bir', '', '  Ikki', '---'].join('\n'),
      'x',
    )
    expect(n?.tavsif).toContain('Bir')
    expect(n?.tavsif).toContain('Ikki')
  })

  test('blokdan keyingi kalitlar to\'g\'ri o\'qiladi', () => {
    const n = skillFayliniTahlil(
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
    expect(skillFayliniTahlil(['---', 'name: x', 'description: |-', '---'].join('\n'), 'x')).toBeNull()
  })
})

describe('allowed-tools', () => {
  test('inline ro\'yxat', () => {
    const n = skillFayliniTahlil(
      ['---', 'name: x', 'description: t', 'allowed-tools: [read, bash]', '---'].join('\n'),
      'x',
    )
    expect(n?.allowedTools).toEqual(['read', 'bash'])
  })

  test('blok ro\'yxat', () => {
    const n = skillFayliniTahlil(
      ['---', 'name: x', 'description: t', 'allowed-tools:', '  - read', '  - write', '---'].join('\n'),
      'x',
    )
    expect(n?.allowedTools).toEqual(['read', 'write'])
  })

  test('vergul bilan ajratilgan satr', () => {
    const n = skillFayliniTahlil(
      ['---', 'name: x', 'description: t', 'allowed-tools: read, bash', '---'].join('\n'),
      'x',
    )
    expect(n?.allowedTools).toEqual(['read', 'bash'])
  })

  test('yo\'q bo\'lsa undefined', () => {
    const n = skillFayliniTahlil(['---', 'name: x', 'description: t', '---'].join('\n'), 'x')
    expect(n?.allowedTools).toBeUndefined()
  })
})

describe('YUMSHOQ validatsiya — buzilgan skill baribir yuklanadi', () => {
  test('katta harfli nom ogohlantirish beradi, lekin yuklanadi', () => {
    const n = skillFayliniTahlil(['---', 'name: PDF-Fill', 'description: t', '---'].join('\n'), 'PDF-Fill')
    expect(n).not.toBeNull()
    expect(n?.nom).toBe('PDF-Fill')
    expect(n?.ogohlantirishlar.some((x) => x.includes('kichik harf'))).toBe(true)
  })

  test('ketma-ket tire ogohlantiriladi', () => {
    const n = skillFayliniTahlil(['---', 'name: a--b', 'description: t', '---'].join('\n'), 'a--b')
    expect(n?.ogohlantirishlar.some((x) => x.includes('ketma-ket'))).toBe(true)
  })

  test('uzun nom kesiladi', () => {
    const uzun = 'a'.repeat(NOM_CHEGARASI + 20)
    const n = skillFayliniTahlil(['---', `name: ${uzun}`, 'description: t', '---'].join('\n'), uzun)
    expect(n?.nom.length).toBe(NOM_CHEGARASI)
    expect(n?.ogohlantirishlar.some((x) => x.includes('uzun'))).toBe(true)
  })

  test('uzun tavsif kesiladi — prompt shishib ketmasin', () => {
    const uzun = 'b'.repeat(TAVSIF_CHEGARASI + 500)
    const n = skillFayliniTahlil(['---', 'name: x', `description: ${uzun}`, '---'].join('\n'), 'x')
    expect(n!.tavsif.length).toBeLessThanOrEqual(TAVSIF_CHEGARASI + 1)
    expect(n?.ogohlantirishlar.some((x) => x.includes('uzun'))).toBe(true)
  })

  test('nom papka nomiga mos kelmasa ogohlantirish (lekin rad etilmaydi)', () => {
    // pi ataylab shunday: bir papka bir necha vosita bilan bo'lishilganda
    // qat'iy talab halal beradi
    const n = skillFayliniTahlil(['---', 'name: boshqa', 'description: t', '---'].join('\n'), 'papka')
    expect(n?.nom).toBe('boshqa')
    expect(n?.ogohlantirishlar.some((x) => x.includes('papka'))).toBe(true)
  })
})

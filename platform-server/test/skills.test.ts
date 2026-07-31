// Skilllar: baza qatlami + loyihaga sinxronlash.
//
// Tarmoq so'rovlari (GitHub) SINALMAYDI — ular tashqi xizmatga bog'liq.
// Bu yerda ular kelgandan KEYINGI mantiq tekshiriladi: katalog UPSERT'i,
// qamrov, va diskdagi `.platforma/skills/` ning bazaga moslashuvi.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bazaOch, dbOrnat } from '../src/db.ts'
import { manzilniAjrat } from '../src/github.ts'
import {
  faolSkilllar,
  loyihaYarat,
  manbaOchir,
  manbalarOqi,
  manbaYarat,
  skillOqi,
  skillOrnat,
  skillOrnatishniOchir,
  skilllarniSinxronla,
  skilllarOqi,
} from '../src/repo.ts'
import { ISH_SKILL_PAPKASI, loyihagaSinxronla, skillOmborYoli } from '../src/skill-ombor.ts'

let db: Database
let ombor: string

beforeEach(() => {
  db = bazaOch(':memory:')
  dbOrnat(db)
  ombor = mkdtempSync(join(tmpdir(), 'ombor-'))
  process.env.PLATFORMA_SKILLS = ombor
})

afterEach(() => {
  db.close()
  rmSync(ombor, { recursive: true, force: true })
  delete process.env.PLATFORMA_SKILLS
})

/** Test uchun manba + bitta skill */
function manbaVaSkill(nom = 'pdf-fill', yol = `${nom}/SKILL.md`) {
  const manba = manbaYarat(
    { tur: 'github', url: `https://github.com/test/${nom}`, owner: 'test', repo: nom, ref: 'main' },
    db,
  )
  skilllarniSinxronla(
    manba.id,
    [{ yol, nom, tavsif: `${nom} tavsifi`, ogohlantirishlar: [] }],
    'sha1',
    db,
  )
  const skill = skilllarOqi(db).find((s) => s.yol === yol)!
  return { manba, skill }
}

// ---------------------------------------------------------------------------

describe('manzilniAjrat', () => {
  test('to\'liq URL', () => {
    expect(manzilniAjrat('https://github.com/anthropics/skills')).toEqual({
      owner: 'anthropics',
      repo: 'skills',
      ref: '',
    })
  })

  test('qisqa shakl', () => {
    expect(manzilniAjrat('anthropics/skills')).toEqual({
      owner: 'anthropics',
      repo: 'skills',
      ref: '',
    })
  })

  test('.git qo\'shimchasi olib tashlanadi', () => {
    expect(manzilniAjrat('github.com/a/b.git')?.repo).toBe('b')
  })

  test('/tree/<branch> dan ref olinadi', () => {
    expect(manzilniAjrat('https://github.com/a/b/tree/dev')?.ref).toBe('dev')
  })

  test('SSH shakli', () => {
    expect(manzilniAjrat('git@github.com:a/b.git')).toEqual({ owner: 'a', repo: 'b', ref: '' })
  })

  test('noto\'g\'ri manzil null', () => {
    expect(manzilniAjrat('')).toBeNull()
    expect(manzilniAjrat('shunchaki-matn')).toBeNull()
    // `owner` yoki `repo` da yo'l belgilari — API URL'iga sizib ketmasin
    expect(manzilniAjrat('../etc/passwd')).toBeNull()
    expect(manzilniAjrat('a b/c')).toBeNull()
  })

  test('ortiqcha yo\'l bo\'laklari e\'tiborsiz qoladi', () => {
    // `tree`/`blob` bo'lmagan qo'shimcha bo'laklar ref bermaydi, ya'ni
    // `..` API so'roviga tushmaydi
    expect(manzilniAjrat('a/b/../../etc')).toEqual({ owner: 'a', repo: 'b', ref: '' })
  })

  test('ref da `..` bo\'lsa rad etiladi', () => {
    // Ref URL'ga qo'shiladi — u yerda yo'l chiqishi xavfli
    expect(manzilniAjrat('https://github.com/a/b/tree/../../../etc')).toBeNull()
  })
})

// ---------------------------------------------------------------------------

describe('manba va katalog', () => {
  test('manba yaratiladi va o\'qiladi', () => {
    const m = manbaYarat(
      { tur: 'github', url: 'https://github.com/a/b', owner: 'a', repo: 'b', ref: 'main' },
      db,
    )
    expect(manbalarOqi(db)).toHaveLength(1)
    expect(m.owner).toBe('a')
  })

  test('takroriy ulash mavjudini qaytaradi (xato emas)', () => {
    const bir = manbaYarat(
      { tur: 'github', url: 'https://github.com/a/b', owner: 'a', repo: 'b', ref: 'main' },
      db,
    )
    const ikki = manbaYarat(
      { tur: 'github', url: 'boshqa-url', owner: 'a', repo: 'b', ref: 'main' },
      db,
    )
    expect(ikki.id).toBe(bir.id)
    expect(manbalarOqi(db)).toHaveLength(1)
  })

  test('sinxronlash: qo\'shildi / yangilandi / o\'chirildi', () => {
    const m = manbaYarat(
      { tur: 'github', url: 'u', owner: 'a', repo: 'b', ref: 'main' },
      db,
    )

    const bir = skilllarniSinxronla(
      m.id,
      [
        { yol: 'x/SKILL.md', nom: 'x', tavsif: 'X', ogohlantirishlar: [] },
        { yol: 'y/SKILL.md', nom: 'y', tavsif: 'Y', ogohlantirishlar: [] },
      ],
      'sha1',
      db,
    )
    expect(bir).toEqual({ qoshildi: 2, yangilandi: 0, ochirildi: 0 })

    // `y` repo'dan ketdi, `z` qo'shildi, `x` qoldi
    const ikki = skilllarniSinxronla(
      m.id,
      [
        { yol: 'x/SKILL.md', nom: 'x', tavsif: 'X yangi', ogohlantirishlar: [] },
        { yol: 'z/SKILL.md', nom: 'z', tavsif: 'Z', ogohlantirishlar: [] },
      ],
      'sha2',
      db,
    )
    expect(ikki).toEqual({ qoshildi: 1, yangilandi: 1, ochirildi: 1 })
    expect(skilllarOqi(db).find((s) => s.nom === 'x')?.tavsif).toBe('X yangi')
  })

  test('sinxronlashda o\'rnatish SAQLANADI — id o\'zgarmaydi', () => {
    const { manba, skill } = manbaVaSkill()
    skillOrnat(skill.id, 'global', null, db)

    skilllarniSinxronla(
      manba.id,
      [{ yol: skill.yol, nom: skill.nom, tavsif: 'yangi tavsif', ogohlantirishlar: [] }],
      'sha2',
      db,
    )

    const keyin = skillOqi(skill.id, db)
    expect(keyin?.tavsif).toBe('yangi tavsif')
    expect(keyin?.ornatilgan).toHaveLength(1) // o'rnatish yo'qolmadi
  })

  test('manba o\'chirilsa skilllari ham ketadi (CASCADE)', () => {
    const { manba } = manbaVaSkill()
    expect(skilllarOqi(db)).toHaveLength(1)

    manbaOchir(manba.id, db)
    expect(skilllarOqi(db)).toHaveLength(0)
  })

  test('allowedTools va ogohlantirishlar saqlanadi', () => {
    const m = manbaYarat({ tur: 'github', url: 'u', owner: 'a', repo: 'b', ref: '' }, db)
    skilllarniSinxronla(
      m.id,
      [
        {
          yol: 'x/SKILL.md',
          nom: 'x',
          tavsif: 'X',
          allowedTools: ['read', 'bash'],
          ogohlantirishlar: ['nom mos emas'],
        },
      ],
      null,
      db,
    )
    const s = skilllarOqi(db)[0]
    expect(s?.allowedTools).toEqual(['read', 'bash'])
    expect(s?.ogohlantirishlar).toEqual(['nom mos emas'])
  })
})

// ---------------------------------------------------------------------------

describe('qamrov (o\'rnatish)', () => {
  test('global o\'rnatish', () => {
    const { skill } = manbaVaSkill()
    skillOrnat(skill.id, 'global', null, db)

    expect(skillOqi(skill.id, db)?.ornatilgan).toEqual([{ qamrov: 'global', projectId: undefined }])
  })

  test('bir skill BIR NECHA loyihaga o\'rnatiladi', () => {
    const { skill } = manbaVaSkill()
    const l1 = loyihaYarat('bir', '/tmp/bir', db)
    const l2 = loyihaYarat('ikki', '/tmp/ikki', db)

    skillOrnat(skill.id, 'loyiha', l1.id, db)
    skillOrnat(skill.id, 'loyiha', l2.id, db)

    expect(skillOqi(skill.id, db)?.ornatilgan).toHaveLength(2)
  })

  test('takroriy o\'rnatish idempotent', () => {
    const { skill } = manbaVaSkill()
    skillOrnat(skill.id, 'global', null, db)
    skillOrnat(skill.id, 'global', null, db)

    expect(skillOqi(skill.id, db)?.ornatilgan).toHaveLength(1)
  })

  test('o\'rnatishni bekor qilish', () => {
    const { skill } = manbaVaSkill()
    skillOrnat(skill.id, 'global', null, db)
    expect(skillOrnatishniOchir(skill.id, 'global', null, db)).toBe(true)
    expect(skillOqi(skill.id, db)?.ornatilgan).toEqual([])
  })

  test('faolSkilllar: global + loyihaniki qaytadi', () => {
    const { skill: global } = manbaVaSkill('global-skill')
    const { skill: loyihali } = manbaVaSkill('loyiha-skill')
    const { skill: begona } = manbaVaSkill('begona-skill')

    const l1 = loyihaYarat('bir', '/tmp/bir', db)
    const l2 = loyihaYarat('ikki', '/tmp/ikki', db)

    skillOrnat(global.id, 'global', null, db)
    skillOrnat(loyihali.id, 'loyiha', l1.id, db)
    skillOrnat(begona.id, 'loyiha', l2.id, db)

    const faol = faolSkilllar(l1.id, db).map((s) => s.nom).sort()
    expect(faol).toEqual(['global-skill', 'loyiha-skill'])
  })

  test('loyihasiz sessiyada faqat global', () => {
    const { skill: global } = manbaVaSkill('global-skill')
    const { skill: loyihali } = manbaVaSkill('loyiha-skill')
    const l1 = loyihaYarat('bir', '/tmp/bir', db)

    skillOrnat(global.id, 'global', null, db)
    skillOrnat(loyihali.id, 'loyiha', l1.id, db)

    expect(faolSkilllar(null, db).map((s) => s.nom)).toEqual(['global-skill'])
  })

  test('o\'rnatilmagan skill faol emas', () => {
    manbaVaSkill()
    expect(faolSkilllar(null, db)).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('loyihagaSinxronla — disk', () => {
  let ish: string

  beforeEach(() => {
    ish = mkdtempSync(join(tmpdir(), 'ish-'))
  })

  afterEach(() => {
    rmSync(ish, { recursive: true, force: true })
  })

  /** Ombor ga skill fayllarini qo'yadi (o'rnatish natijasini taqlid qiladi) */
  function omborgaYoz(manbaId: string, skillId: string, mazmun: string) {
    const yol = skillOmborYoli(manbaId, skillId)
    mkdirSync(yol, { recursive: true })
    writeFileSync(join(yol, 'SKILL.md'), mazmun)
  }

  test('ombordan ish papkasiga NUSXALANADI (symlink emas)', () => {
    const { manba, skill } = manbaVaSkill()
    omborgaYoz(manba.id, skill.id, '---\nname: pdf-fill\ndescription: t\n---')

    const natija = loyihagaSinxronla(ish, [skill])
    expect(natija.nusxalandi).toBe(1)

    const nishon = join(ish, ISH_SKILL_PAPKASI, 'pdf-fill', 'SKILL.md')
    expect(existsSync(nishon)).toBe(true)
    expect(readFileSync(nishon, 'utf8')).toContain('pdf-fill')
  })

  test('nusxa mustaqil — ish papkasidagini o\'zgartirish omborga tegmaydi', () => {
    // Symlink bo'lganda bu test yiqilardi: bir loyihadagi agent
    // ombordagi aslini buzib, hamma loyihaga zarar qilardi
    const { manba, skill } = manbaVaSkill()
    omborgaYoz(manba.id, skill.id, 'ASL')
    loyihagaSinxronla(ish, [skill])

    writeFileSync(join(ish, ISH_SKILL_PAPKASI, 'pdf-fill', 'SKILL.md'), 'BUZILGAN')

    const omborFayli = join(skillOmborYoli(manba.id, skill.id), 'SKILL.md')
    expect(readFileSync(omborFayli, 'utf8')).toBe('ASL')
  })

  test('bazada yo\'q skill diskdan O\'CHIRILADI', () => {
    const { manba, skill } = manbaVaSkill()
    omborgaYoz(manba.id, skill.id, 'x')
    loyihagaSinxronla(ish, [skill])
    expect(existsSync(join(ish, ISH_SKILL_PAPKASI, 'pdf-fill'))).toBe(true)

    // Endi skill o'rnatilmagan — sinxronlash uni olib tashlashi kerak
    const natija = loyihagaSinxronla(ish, [])
    expect(natija.ochirildi).toBe(1)
    expect(existsSync(join(ish, ISH_SKILL_PAPKASI, 'pdf-fill'))).toBe(false)
  })

  test('qo\'lda qo\'yilgan papka ham o\'chiriladi — papka BOSHQARILADI', () => {
    mkdirSync(join(ish, ISH_SKILL_PAPKASI, 'qolbola'), { recursive: true })
    const natija = loyihagaSinxronla(ish, [])
    expect(natija.ochirildi).toBe(1)
    expect(existsSync(join(ish, ISH_SKILL_PAPKASI, 'qolbola'))).toBe(false)
  })

  test('ombor yangilanса nusxa ham yangilanadi', () => {
    const { manba, skill } = manbaVaSkill()
    omborgaYoz(manba.id, skill.id, 'ESKI')
    loyihagaSinxronla(ish, [skill])

    omborgaYoz(manba.id, skill.id, 'YANGI')
    loyihagaSinxronla(ish, [skill])

    expect(readFileSync(join(ish, ISH_SKILL_PAPKASI, 'pdf-fill', 'SKILL.md'), 'utf8')).toBe('YANGI')
  })

  test('ombor da yo\'q skill jim o\'tkazib yuboriladi', () => {
    const { skill } = manbaVaSkill()
    // omborga hech narsa yozilmadi
    const natija = loyihagaSinxronla(ish, [skill])
    expect(natija.nusxalandi).toBe(0)
  })

  test('ichki papkalar ham nusxalanadi (scripts/ va h.k.)', () => {
    const { manba, skill } = manbaVaSkill()
    const omborYol = skillOmborYoli(manba.id, skill.id)
    mkdirSync(join(omborYol, 'scripts'), { recursive: true })
    writeFileSync(join(omborYol, 'SKILL.md'), 'x')
    writeFileSync(join(omborYol, 'scripts', 'ish.sh'), 'echo hi')

    loyihagaSinxronla(ish, [skill])

    expect(existsSync(join(ish, ISH_SKILL_PAPKASI, 'pdf-fill', 'scripts', 'ish.sh'))).toBe(true)
  })

  test('xavfli nomli skill papka nomiga aylanmaydi', () => {
    const { manba, skill } = manbaVaSkill()
    omborgaYoz(manba.id, skill.id, 'x')

    // Nom bazada `../../evil` bo'lsa ham papka ish papkasidan chiqmasin
    const yovuz = { ...skill, nom: '../../evil' }
    loyihagaSinxronla(ish, [yovuz])

    expect(existsSync(join(ish, '..', '..', 'evil'))).toBe(false)
  })
})

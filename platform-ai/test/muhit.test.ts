// Chegaralangan muhit — tool'lar ish papkasidan chiqib keta olmasligi.
//
// Bu testlar ruxsat so'rovlarini avtomatik javob beruvchi soxta
// boshqaruvchi bilan sinaydi, shunda haqiqiy UI kerak emas.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuxsatBoshqaruvchi } from '../src/ruxsat.ts'
import { ChegaralanganMuhit } from '../src/muhit.ts'
import type { RuxsatJavobi, RuxsatSorovi } from '@platforma/shared'

let ish: string
let tashqi: string
let sorovlar: RuxsatSorovi[]

/** Har so'rovga oldindan belgilangan javobni beradigan boshqaruvchi */
function soxtaRuxsat(javob: RuxsatJavobi): RuxsatBoshqaruvchi {
  const b = new RuxsatBoshqaruvchi('sinov')
  b.kuzat((sorov) => {
    sorovlar.push(sorov)
    // Keyingi tick'da javob beramiz — haqiqiy oqimga o'xshash
    queueMicrotask(() => b.javobBer(sorov.id, javob))
  })
  return b
}

function muhitYarat(javob: RuxsatJavobi): ChegaralanganMuhit {
  return new ChegaralanganMuhit({ ishPapkasi: ish, ruxsat: soxtaRuxsat(javob) })
}

beforeEach(() => {
  const asos = mkdtempSync(join(tmpdir(), 'muhit-sinov-'))
  ish = join(asos, 'ish')
  tashqi = join(asos, 'tashqi')
  mkdirSync(ish, { recursive: true })
  mkdirSync(tashqi, { recursive: true })
  writeFileSync(join(ish, 'ichki.txt'), 'ichki mazmun')
  writeFileSync(join(tashqi, 'maxfiy.txt'), 'maxfiy mazmun')
  sorovlar = []
})

afterEach(() => {
  // asos papkasini o'chirish uchun ish papkasining otasini olamiz
  rmSync(join(ish, '..'), { recursive: true, force: true })
})

describe('ish papkasi ichida', () => {
  test('fayl o\'qish so\'rovsiz ishlaydi', async () => {
    const m = muhitYarat('rad')
    const r = await m.readTextFile('ichki.txt')
    expect(r.ok).toBe(true)
    expect(r.ok && r.value).toBe('ichki mazmun')
    expect(sorovlar).toHaveLength(0)
  })

  test('fayl yozish so\'rovsiz ishlaydi', async () => {
    const m = muhitYarat('rad')
    const r = await m.writeFile('yangi.txt', 'salom')
    expect(r.ok).toBe(true)
    expect(sorovlar).toHaveLength(0)
  })

  test('ichki papkada ham so\'ralmaydi', async () => {
    const m = muhitYarat('rad')
    const r = await m.writeFile('a/b/c.txt', 'chuqur')
    expect(r.ok).toBe(true)
    expect(sorovlar).toHaveLength(0)
  })

  test('xavfsiz buyruq so\'rovsiz bajariladi', async () => {
    const m = muhitYarat('rad')
    const r = await m.exec('cat ichki.txt')
    expect(r.ok).toBe(true)
    expect(r.ok && r.value.stdout.trim()).toBe('ichki mazmun')
    expect(sorovlar).toHaveLength(0)
  })
})

describe('ish papkasidan tashqarida', () => {
  test('o\'qish ruxsat so\'raydi va rad etilsa bloklanadi', async () => {
    const m = muhitYarat('rad')
    const r = await m.readTextFile(join(tashqi, 'maxfiy.txt'))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.code).toBe('permission_denied')
    expect(sorovlar).toHaveLength(1)
    expect(sorovlar[0]?.tur).toBe('fayl')
    expect(sorovlar[0]?.amal).toBe('read')
  })

  test('ruxsat berilsa o\'qiydi', async () => {
    const m = muhitYarat('ruxsat')
    const r = await m.readTextFile(join(tashqi, 'maxfiy.txt'))
    expect(r.ok).toBe(true)
    expect(r.ok && r.value).toBe('maxfiy mazmun')
    expect(sorovlar).toHaveLength(1)
  })

  test('`..` orqali chiqish ushlanadi', async () => {
    const m = muhitYarat('rad')
    const r = await m.readTextFile('../tashqi/maxfiy.txt')
    expect(r.ok).toBe(false)
    expect(sorovlar).toHaveLength(1)
  })

  test('absolut tashqi yo\'l ushlanadi', async () => {
    const m = muhitYarat('rad')
    const r = await m.readTextFile('/etc/passwd')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.code).toBe('permission_denied')
  })

  test('yozish ham ushlanadi', async () => {
    const m = muhitYarat('rad')
    const r = await m.writeFile(join(tashqi, 'yangi.txt'), 'x')
    expect(r.ok).toBe(false)
    expect(sorovlar[0]?.amal).toBe('write')
  })

  test('bir marta ruxsat berilgan yo\'l qayta so\'ralmaydi', async () => {
    const m = muhitYarat('ruxsat')
    const yol = join(tashqi, 'maxfiy.txt')
    await m.readTextFile(yol)
    await m.readTextFile(yol)
    await m.readTextFile(yol)
    expect(sorovlar).toHaveLength(1)
  })
})

describe('symlink orqali chiqish', () => {
  test('ish papkasidagi symlink tashqariga qarasa ushlanadi', async () => {
    // ish/koprik → tashqi
    symlinkSync(tashqi, join(ish, 'koprik'))
    const m = muhitYarat('rad')

    const r = await m.readTextFile('koprik/maxfiy.txt')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.code).toBe('permission_denied')
    expect(sorovlar).toHaveLength(1)
  })

  test('ichkariga qaragan symlink so\'ralmaydi', async () => {
    mkdirSync(join(ish, 'haqiqiy'))
    writeFileSync(join(ish, 'haqiqiy', 'f.txt'), 'ok')
    symlinkSync(join(ish, 'haqiqiy'), join(ish, 'ichki-link'))
    const m = muhitYarat('rad')

    const r = await m.readTextFile('ichki-link/f.txt')
    expect(r.ok).toBe(true)
    expect(sorovlar).toHaveLength(0)
  })
})

describe('exists — tashqarida yolg\'on qaytaradi', () => {
  test('tashqi fayl uchun false, so\'rov yo\'q', async () => {
    const m = muhitYarat('rad')
    const r = await m.exists(join(tashqi, 'maxfiy.txt'))
    expect(r.ok && r.value).toBe(false)
    // Fayl tizimini paypaslashga yo'l qo'ymaymiz, lekin so'rov ham chiqmaydi
    expect(sorovlar).toHaveLength(0)
  })

  test('ichki fayl uchun true', async () => {
    const m = muhitYarat('rad')
    const r = await m.exists('ichki.txt')
    expect(r.ok && r.value).toBe(true)
  })
})

describe('buyruq bajarish', () => {
  test('xavfli buyruq rad etilsa bajarilmaydi', async () => {
    const m = muhitYarat('rad')
    const r = await m.exec('rm -rf ichki.txt')
    expect(r.ok).toBe(false)
    expect(sorovlar).toHaveLength(1)
    expect(sorovlar[0]?.tur).toBe('buyruq')

    // Fayl joyida turibdi
    const oqish = await m.readTextFile('ichki.txt')
    expect(oqish.ok).toBe(true)
  })

  test('ruxsat berilsa bajariladi', async () => {
    const m = muhitYarat('ruxsat')
    const r = await m.exec('rm ichki.txt')
    expect(r.ok).toBe(true)
    expect(sorovlar).toHaveLength(1)
  })

  test('notanish buyruq ham so\'raydi', async () => {
    const m = muhitYarat('rad')
    const r = await m.exec('mening-notanish-buyrugim')
    expect(r.ok).toBe(false)
    expect(sorovlar[0]?.sabab).toContain('notanish')
  })

  test('buyruq ish papkasida boshlanadi', async () => {
    const m = muhitYarat('rad')
    const r = await m.exec('pwd')
    expect(r.ok && r.value.stdout.trim()).toBe(ish)
  })

  test('rad etilgan buyruq xato xabari tushunarli', async () => {
    const m = muhitYarat('rad')
    const r = await m.exec('sudo ls')
    expect(!r.ok && r.error.message).toContain('Ruxsat berilmadi')
  })
})

describe('remove — ichkarida ham so\'raladi', () => {
  test('ish papkasi ichidagi faylni o\'chirish so\'raydi', async () => {
    const m = muhitYarat('rad')
    const r = await m.remove('ichki.txt')
    expect(r.ok).toBe(false)
    expect(sorovlar).toHaveLength(1)
    expect(sorovlar[0]?.amal).toBe('remove')
  })
})

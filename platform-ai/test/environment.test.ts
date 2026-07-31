// Chegaralangan muhit — tool'lar ish papkasidan chiqib keta olmasligi.
//
// Bu testlar ruxsat so'rovlarini avtomatik javob beruvchi soxta
// boshqaruvchi bilan sinaydi, shunda haqiqiy UI kerak emas.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermissionManager } from '../src/permission.ts'
import { RestrictedEnv, DEFAULT_COMMAND_TIMEOUT_MS } from '../src/environment.ts'
import type { PermissionAnswer, PermissionRequest } from '@platforma/shared'

let ish: string
let tashqi: string
let sorovlar: PermissionRequest[]

/** Har so'rovga oldindan belgilangan javobni beradigan boshqaruvchi */
function soxtaRuxsat(javob: PermissionAnswer): PermissionManager {
  const b = new PermissionManager('sinov')
  b.subscribe((sorov) => {
    sorovlar.push(sorov)
    // Keyingi tick'da javob beramiz — haqiqiy oqimga o'xshash
    queueMicrotask(() => b.answer(sorov.id, javob))
  })
  return b
}

function muhitYarat(javob: PermissionAnswer): RestrictedEnv {
  return new RestrictedEnv({ workDir: ish, permission: soxtaRuxsat(javob) })
}

/**
 * `exec` ga qanday sozlama uzatilganini yozib oladigan soxta ichki muhit.
 * Faqat `exec` va `cleanup` kerak — qolgan metodlar bu testlarda chaqirilmaydi.
 */
function soxtaIchki(yozuv: { timeout?: number }[]) {
  return {
    exec: async (_buyruq: string, options?: { timeout?: number }) => {
      yozuv.push({ timeout: options?.timeout })
      return { ok: true as const, value: { stdout: '', stderr: '', exitCode: 0 } }
    },
    cleanup: async () => undefined,
  } as unknown as ConstructorParameters<typeof RestrictedEnv>[0]['inner']
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
    const m = muhitYarat('deny')
    const r = await m.readTextFile('ichki.txt')
    expect(r.ok).toBe(true)
    expect(r.ok && r.value).toBe('ichki mazmun')
    expect(sorovlar).toHaveLength(0)
  })

  test('fayl yozish so\'rovsiz ishlaydi', async () => {
    const m = muhitYarat('deny')
    const r = await m.writeFile('yangi.txt', 'salom')
    expect(r.ok).toBe(true)
    expect(sorovlar).toHaveLength(0)
  })

  test('ichki papkada ham so\'ralmaydi', async () => {
    const m = muhitYarat('deny')
    const r = await m.writeFile('a/b/c.txt', 'chuqur')
    expect(r.ok).toBe(true)
    expect(sorovlar).toHaveLength(0)
  })

  test('xavfsiz buyruq so\'rovsiz bajariladi', async () => {
    const m = muhitYarat('deny')
    const r = await m.exec('cat ichki.txt')
    expect(r.ok).toBe(true)
    expect(r.ok && r.value.stdout.trim()).toBe('ichki mazmun')
    expect(sorovlar).toHaveLength(0)
  })
})

describe('ish papkasidan tashqarida', () => {
  test('o\'qish ruxsat so\'raydi va rad etilsa bloklanadi', async () => {
    const m = muhitYarat('deny')
    const r = await m.readTextFile(join(tashqi, 'maxfiy.txt'))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.code).toBe('permission_denied')
    expect(sorovlar).toHaveLength(1)
    expect(sorovlar[0]?.kind).toBe('file')
    expect(sorovlar[0]?.action).toBe('read')
  })

  test('ruxsat berilsa o\'qiydi', async () => {
    const m = muhitYarat('allow')
    const r = await m.readTextFile(join(tashqi, 'maxfiy.txt'))
    expect(r.ok).toBe(true)
    expect(r.ok && r.value).toBe('maxfiy mazmun')
    expect(sorovlar).toHaveLength(1)
  })

  test('`..` orqali chiqish ushlanadi', async () => {
    const m = muhitYarat('deny')
    const r = await m.readTextFile('../tashqi/maxfiy.txt')
    expect(r.ok).toBe(false)
    expect(sorovlar).toHaveLength(1)
  })

  test('absolut tashqi yo\'l ushlanadi', async () => {
    const m = muhitYarat('deny')
    const r = await m.readTextFile('/etc/passwd')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.code).toBe('permission_denied')
  })

  test('yozish ham ushlanadi', async () => {
    const m = muhitYarat('deny')
    const r = await m.writeFile(join(tashqi, 'yangi.txt'), 'x')
    expect(r.ok).toBe(false)
    expect(sorovlar[0]?.action).toBe('write')
  })

  test('bir marta ruxsat berilgan yo\'l qayta so\'ralmaydi', async () => {
    const m = muhitYarat('allow')
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
    const m = muhitYarat('deny')

    const r = await m.readTextFile('koprik/maxfiy.txt')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.code).toBe('permission_denied')
    expect(sorovlar).toHaveLength(1)
  })

  test('ichkariga qaragan symlink so\'ralmaydi', async () => {
    mkdirSync(join(ish, 'haqiqiy'))
    writeFileSync(join(ish, 'haqiqiy', 'f.txt'), 'ok')
    symlinkSync(join(ish, 'haqiqiy'), join(ish, 'ichki-link'))
    const m = muhitYarat('deny')

    const r = await m.readTextFile('ichki-link/f.txt')
    expect(r.ok).toBe(true)
    expect(sorovlar).toHaveLength(0)
  })
})

describe('exists — tashqarida yolg\'on qaytaradi', () => {
  test('tashqi fayl uchun false, so\'rov yo\'q', async () => {
    const m = muhitYarat('deny')
    const r = await m.exists(join(tashqi, 'maxfiy.txt'))
    expect(r.ok && r.value).toBe(false)
    // Fayl tizimini paypaslashga yo'l qo'ymaymiz, lekin so'rov ham chiqmaydi
    expect(sorovlar).toHaveLength(0)
  })

  test('ichki fayl uchun true', async () => {
    const m = muhitYarat('deny')
    const r = await m.exists('ichki.txt')
    expect(r.ok && r.value).toBe(true)
  })
})

describe('buyruq bajarish', () => {
  test('xavfli buyruq rad etilsa bajarilmaydi', async () => {
    const m = muhitYarat('deny')
    const r = await m.exec('rm -rf ichki.txt')
    expect(r.ok).toBe(false)
    expect(sorovlar).toHaveLength(1)
    expect(sorovlar[0]?.kind).toBe('command')

    // Fayl joyida turibdi
    const oqish = await m.readTextFile('ichki.txt')
    expect(oqish.ok).toBe(true)
  })

  test('ruxsat berilsa bajariladi', async () => {
    const m = muhitYarat('allow')
    const r = await m.exec('rm ichki.txt')
    expect(r.ok).toBe(true)
    expect(sorovlar).toHaveLength(1)
  })

  test('notanish buyruq ham so\'raydi', async () => {
    const m = muhitYarat('deny')
    const r = await m.exec('mening-notanish-buyrugim')
    expect(r.ok).toBe(false)
    expect(sorovlar[0]?.reason).toContain('notanish')
  })

  test('buyruq ish papkasida boshlanadi', async () => {
    const m = muhitYarat('deny')
    const r = await m.exec('pwd')
    // `realpathSync` bilan solishtiramiz: muhit ish papkasini kanonizatsiya
    // qiladi (macOS'da /var → /private/var), `pwd` ham kanonik yo'l beradi
    expect(r.ok && r.value.stdout.trim()).toBe(realpathSync(ish))
  })

  test('rad etilgan buyruq xato xabari tushunarli', async () => {
    const m = muhitYarat('deny')
    const r = await m.exec('sudo ls')
    expect(!r.ok && r.error.message).toContain('Permission denied')
  })
})

describe('remove — ichkarida ham so\'raladi', () => {
  test('ish papkasi ichidagi faylni o\'chirish so\'raydi', async () => {
    const m = muhitYarat('deny')
    const r = await m.remove('ichki.txt')
    expect(r.ok).toBe(false)
    expect(sorovlar).toHaveLength(1)
    expect(sorovlar[0]?.action).toBe('remove')
  })
})

describe('cp/mv — mavjud fayl ustiga yozish', () => {
  test('mavjud fayl ustiga nusxalash ruxsat so\'raydi', async () => {
    const m = muhitYarat('deny')
    writeFileSync(join(ish, 'manba.txt'), 'yangi')
    // `ichki.txt` beforeEach da yaratilgan — ustiga yozilishi kerak emas
    const r = await m.exec('cp manba.txt ichki.txt')
    expect(r.ok).toBe(false)
    expect(sorovlar).toHaveLength(1)
    expect(sorovlar[0]?.reason).toContain('overwrites')

    // Eski mazmun joyida
    const oqish = await m.readTextFile('ichki.txt')
    expect(oqish.ok && oqish.value).toBe('ichki mazmun')
  })

  test('yangi nomga nusxalash so\'rovsiz ishlaydi', async () => {
    const m = muhitYarat('deny')
    const r = await m.exec('cp ichki.txt nusxa.txt')
    expect(r.ok).toBe(true)
    expect(sorovlar).toHaveLength(0)
  })

  test('yangi nomga ko\'chirish so\'rovsiz ishlaydi', async () => {
    const m = muhitYarat('deny')
    const r = await m.exec('mv ichki.txt boshqa-nom.txt')
    expect(r.ok).toBe(true)
    expect(sorovlar).toHaveLength(0)
  })

  test('mavjud fayl ustiga ko\'chirish ruxsat berilsa bajariladi', async () => {
    const m = muhitYarat('allow')
    writeFileSync(join(ish, 'manba.txt'), 'yangi mazmun')
    const r = await m.exec('mv manba.txt ichki.txt')
    expect(r.ok).toBe(true)
    expect(sorovlar).toHaveLength(1)

    const oqish = await m.readTextFile('ichki.txt')
    expect(oqish.ok && oqish.value).toBe('yangi mazmun')
  })
})

describe('buyruq timeout', () => {
  test('standart timeout oqilona chegarada', () => {
    // Juda kichik bo'lsa oddiy build/test yiqiladi, juda katta bo'lsa
    // sessiya uzoq qotib qoladi
    expect(DEFAULT_COMMAND_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000)
    expect(DEFAULT_COMMAND_TIMEOUT_MS).toBeLessThanOrEqual(10 * 60 * 1000)
  })

  test('timeout berilmasa standart qiymat ichki muhitga uzatiladi', async () => {
    const uzatilgan: { timeout?: number }[] = []
    const m = new RestrictedEnv({
      workDir: ish,
      permission: soxtaRuxsat('deny'),
      inner: soxtaIchki(uzatilgan),
    })

    await m.exec('ls')
    // `ShellExecOptions.timeout` SONIYADA
    expect(uzatilgan[0]?.timeout).toBe(DEFAULT_COMMAND_TIMEOUT_MS / 1000)
  })

  test('chaqiruvchi bergan timeout ustun turadi', async () => {
    const uzatilgan: { timeout?: number }[] = []
    const m = new RestrictedEnv({
      workDir: ish,
      permission: soxtaRuxsat('deny'),
      inner: soxtaIchki(uzatilgan),
    })

    await m.exec('ls', { timeout: 5 })
    expect(uzatilgan[0]?.timeout).toBe(5)
  })

  test('sozlamadagi timeout standartni almashtiradi', async () => {
    const uzatilgan: { timeout?: number }[] = []
    const m = new RestrictedEnv({
      workDir: ish,
      permission: soxtaRuxsat('deny'),
      inner: soxtaIchki(uzatilgan),
      commandTimeoutMs: 30_000,
    })

    await m.exec('ls')
    expect(uzatilgan[0]?.timeout).toBe(30)
  })

  test('uzoq davom etadigan buyruq timeout bilan uziladi', async () => {
    // Haqiqiy uzilishni tekshiramiz: `sleep` xavfsiz ro'yxatda emas,
    // shuning uchun ruxsat beruvchi boshqaruvchi kerak.
    const m = new RestrictedEnv({
      workDir: ish,
      permission: soxtaRuxsat('allow'),
      commandTimeoutMs: 1000,
    })

    const boshlandi = Date.now()
    const r = await m.exec('sleep 30')
    const ketgan = Date.now() - boshlandi

    // Cheksiz kutmadi — timeout ishladi
    expect(ketgan).toBeLessThan(15_000)
    expect(r.ok).toBe(false)
  }, 20_000)
})

// Qidiruv tool'larining xavfsizlik chegarasi.
//
// `grep`/`find`/`ls` ruxsat SO'RAMAYDI — shuning uchun ularning yagona
// himoyasi shu chegara. Agar u ishlamasa, prompt injection orqali
// "~/.ssh ichida nima bor?" degan so'rov to'g'ridan-to'g'ri javob olardi.
//
// Uchta narsa sinaladi:
//   1) ish papkasidan tashqaridagi yo'l rad etiladi,
//   2) symlink orqali chiqib ketish `realpath` bilan ushlanadi,
//   3) natijada absolut yo'llar HECH QACHON chiqmaydi.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chegaraniTekshir, nisbiyYol } from '../src/qidiruv-asos.ts'
import {
  ChegaraXatosi,
  findNode,
  findRg,
  grepNode,
  grepRg,
  lsRoyxat,
  NaqshXatosi,
} from '../src/qidiruv-motor.ts'
import { rgBormi } from './qidiruv-yordamchi.ts'

let asos: string
let ish: string
let tashqi: string

beforeEach(() => {
  asos = mkdtempSync(join(tmpdir(), 'qidiruv-xavfsizlik-'))
  ish = join(asos, 'ish')
  tashqi = join(asos, 'tashqi')
  mkdirSync(ish, { recursive: true })
  mkdirSync(tashqi, { recursive: true })
  writeFileSync(join(ish, 'ichki.txt'), 'maxfiy so\'z bor\n')
  writeFileSync(join(tashqi, 'maxfiy.txt'), 'maxfiy so\'z bor\n')
})

afterEach(() => {
  rmSync(asos, { recursive: true, force: true })
})

describe('chegaraniTekshir', () => {
  test('ish papkasi ichidagi yo\'l o\'tadi', async () => {
    const n = await chegaraniTekshir(ish, 'ichki.txt')
    expect(n.ok).toBe(true)
  })

  test('ish papkasining o\'zi o\'tadi', async () => {
    const n = await chegaraniTekshir(ish, undefined)
    expect(n.ok).toBe(true)
  })

  test('`..` bilan yuqoriga chiqish rad etiladi', async () => {
    const n = await chegaraniTekshir(ish, '../tashqi')
    expect(n.ok).toBe(false)
    expect(n.sabab).toContain('tashqarida')
  })

  test('absolut tashqi yo\'l rad etiladi', async () => {
    const n = await chegaraniTekshir(ish, '/etc')
    expect(n.ok).toBe(false)
  })

  test('chuqur `../../..` ham rad etiladi', async () => {
    const n = await chegaraniTekshir(ish, '../../../../../../etc/passwd')
    expect(n.ok).toBe(false)
  })

  test('symlink orqali chiqish ushlanadi', async () => {
    symlinkSync(tashqi, join(ish, 'ko\'prik'))
    const n = await chegaraniTekshir(ish, "ko'prik")
    expect(n.ok).toBe(false)
    expect(n.sabab).toContain('symlink')
  })

  test('mavjud bo\'lmagan ichki yo\'l o\'tadi (matn tekshiruvi yetarli)', async () => {
    const n = await chegaraniTekshir(ish, 'hali/yoq/fayl.txt')
    expect(n.ok).toBe(true)
  })

  test('ish papkasining o\'zi symlink bo\'lsa ham ichkarisi o\'tadi', async () => {
    // macOS'da /tmp → /private/tmp; shu holat taqlid qilinadi
    const koprik = join(asos, 'ish-koprik')
    symlinkSync(ish, koprik)
    const n = await chegaraniTekshir(koprik, 'ichki.txt')
    expect(n.ok).toBe(true)
  })
})

describe('tool darajasida chegara', () => {
  test('grepNode tashqi yo\'lni rad etadi', async () => {
    const urinish = grepNode({ ishPapkasi: ish, pattern: 'maxfiy', path: '../tashqi' })
    expect(urinish).rejects.toThrow(ChegaraXatosi)
  })

  test('findNode tashqi yo\'lni rad etadi', async () => {
    const urinish = findNode({ ishPapkasi: ish, pattern: '*.txt', path: '/etc' })
    expect(urinish).rejects.toThrow(ChegaraXatosi)
  })

  test('lsRoyxat tashqi yo\'lni rad etadi', async () => {
    const urinish = lsRoyxat({ ishPapkasi: ish, path: '../tashqi' })
    expect(urinish).rejects.toThrow(ChegaraXatosi)
  })

  test('grepNode symlink orqali chiqishni rad etadi', async () => {
    symlinkSync(tashqi, join(ish, 'ko\'prik'))
    const urinish = grepNode({ ishPapkasi: ish, pattern: 'maxfiy', path: "ko'prik" })
    expect(urinish).rejects.toThrow(ChegaraXatosi)
  })

  test('xato xabarida absolut yo\'l oshkor bo\'lmaydi', async () => {
    try {
      await grepNode({ ishPapkasi: ish, pattern: 'x', path: '/etc/ssh' })
      throw new Error('xato kutilgan edi')
    } catch (xato) {
      expect(xato).toBeInstanceOf(ChegaraXatosi)
      // Xabarda foydalanuvchi bergan yo'l bor, lekin ish papkasining
      // haqiqiy absolut joyi yo'q
      expect((xato as Error).message).not.toContain(ish)
    }
  })
})

describe('symlink kuzatilmaydi', () => {
  test('grepNode symlink ichidagi tashqi faylni qidirmaydi', async () => {
    // Ish papkasi ichida tashqariga qaragan symlink bor; aylanish uni
    // ochmasligi kerak, aks holda `maxfiy.txt` natijaga tushardi
    symlinkSync(tashqi, join(ish, 'ko\'prik'))
    const n = await grepNode({ ishPapkasi: ish, pattern: 'maxfiy' })
    // Faqat ichki faylni topadi
    expect(n.elementlar.map((m) => m.yol)).toEqual(['ichki.txt'])
  })

  test.if(rgBormi())('grepRg ham symlink ichiga kirmaydi', async () => {
    symlinkSync(tashqi, join(ish, 'ko\'prik'))
    const n = await grepRg({ ishPapkasi: ish, pattern: 'maxfiy' })
    expect(n.elementlar.map((m) => m.yol)).toEqual(['ichki.txt'])
  })

  test('findNode symlink ichidagi faylni ro\'yxatlamaydi', async () => {
    symlinkSync(tashqi, join(ish, 'ko\'prik'))
    const n = await findNode({ ishPapkasi: ish, pattern: '*.txt' })
    expect(n.elementlar).toEqual(['ichki.txt'])
  })

  test.if(rgBormi())('findRg ham symlink ichiga kirmaydi', async () => {
    symlinkSync(tashqi, join(ish, 'ko\'prik'))
    const n = await findRg({ ishPapkasi: ish, pattern: '*.txt' })
    expect(n.elementlar).toEqual(['ichki.txt'])
  })
})

describe('natijada absolut yo\'l chiqmaydi', () => {
  test('grep natijasi nisbiy yo\'l beradi', async () => {
    mkdirSync(join(ish, 'a', 'b'), { recursive: true })
    writeFileSync(join(ish, 'a', 'b', 'c.txt'), 'maxfiy\n')
    const n = await grepNode({ ishPapkasi: ish, pattern: 'maxfiy' })
    for (const m of n.elementlar) {
      expect(m.yol.startsWith('/')).toBe(false)
      expect(m.yol).not.toContain(ish)
    }
  })

  test('ls natijasi faqat nomlarni beradi', async () => {
    const n = await lsRoyxat({ ishPapkasi: ish })
    for (const e of n.elementlar) {
      expect(e.nom).not.toContain('/')
    }
  })

  test('nisbiyYol ish papkasining o\'zini `.` qiladi', () => {
    expect(nisbiyYol(ish, ish)).toBe('.')
  })
})

describe('naqsh xavfsizligi', () => {
  // Naqsh shell'ga XOM uzatilmasligi kerak. Agar `spawn` `shell: true`
  // bilan chaqirilsa, quyidagi naqsh `touch` buyrug'ini bajarardi.
  test('shell metabelgilari naqsh sifatida qoladi, buyruq bo\'lmaydi', async () => {
    writeFileSync(join(ish, 'nishon.txt'), 'oddiy matn\n')
    const yomon = 'x"; touch /tmp/qidiruv-buzildi; echo "'
    // Xato bo'lmasligi kerak — bu shunchaki hech narsaga mos kelmaydigan naqsh
    const n = await grepNode({ ishPapkasi: ish, pattern: yomon })
    expect(n.elementlar).toHaveLength(0)
  })

  test.if(rgBormi())('rg yo\'lida ham shell metabelgilari zararsiz', async () => {
    const yomon = 'x`touch /tmp/qidiruv-buzildi-rg`y'
    const n = await grepRg({ ishPapkasi: ish, pattern: yomon })
    expect(n.elementlar).toHaveLength(0)
    // Fayl yaratilmagan bo'lishi kerak
    expect(await Bun.file('/tmp/qidiruv-buzildi-rg').exists()).toBe(false)
  })

  test('`-` bilan boshlanadigan naqsh bayroq deb o\'qilmaydi', async () => {
    writeFileSync(join(ish, 'tire.txt'), 'bu -qator bor\n')
    const n = await grepNode({ ishPapkasi: ish, pattern: '-qator' })
    expect(n.elementlar).toHaveLength(1)
  })

  test.if(rgBormi())('rg da ham `-` bilan boshlanadigan naqsh ishlaydi', async () => {
    writeFileSync(join(ish, 'tire.txt'), 'bu -qator bor\n')
    const n = await grepRg({ ishPapkasi: ish, pattern: '-qator' })
    expect(n.elementlar).toHaveLength(1)
  })

  test('noto\'g\'ri regex tushunarli xato beradi', async () => {
    const urinish = grepNode({ ishPapkasi: ish, pattern: '[yopilmagan' })
    expect(urinish).rejects.toThrow(NaqshXatosi)
  })

  test('bo\'sh naqsh rad etiladi', async () => {
    const urinish = grepNode({ ishPapkasi: ish, pattern: '' })
    expect(urinish).rejects.toThrow(NaqshXatosi)
  })

  test.if(rgBormi())('rg yo\'lida ham noto\'g\'ri regex bir xil xato beradi', async () => {
    // Bu bir xillik uchun muhim: naqsh xatosi ikkala backendda ham
    // `NaqshXatosi` bo'lishi kerak, `rg` ning o'z xabari emas
    const urinish = grepRg({ ishPapkasi: ish, pattern: '[yopilmagan' })
    expect(urinish).rejects.toThrow(NaqshXatosi)
  })
})

// `grep`/`find`/`ls` tool'larining xulqi: limitlar, kesish, formatlash,
// xato holatlari va tool interfeysining `agent.ts` bilan mosligi.
//
// Bu testlar ATAYLAB Node backend'ini majburlaydi (`rgKeshiniOrnat(false)`),
// shunda ular `rg` o'rnatilmagan tizimda ham AYNAN shu yo'ldan o'tadi va
// natija barqaror bo'ladi. `rg` yo'li `qidiruv-bir-xillik.test.ts` da
// alohida sinaladi.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  globMosKeladimi,
  globniRegexpga,
  ikkilikmi,
  QATOR_CHEGARASI,
  qatorniTayyorla,
  rgKeshiniOrnat,
  yolTartibi,
} from '../src/qidiruv-asos.ts'
import { findNode, grepNode, lsRoyxat } from '../src/qidiruv-motor.ts'
import {
  findNatijasiniMatnga,
  findToolYarat,
  grepNatijasiniMatnga,
  grepToolYarat,
  lsNatijasiniMatnga,
  lsToolYarat,
  olchamniMatnga,
  QIDIRUV_PROMPT_QISMI,
  qidiruvToollari,
  qidiruvToollariXom,
} from '../src/qidiruv-toollari.ts'

let ish: string

/** Tool'ni `agent.ts` chaqiradigan shaklda ishga tushiradi */
async function toolniChaqir(
  tool: ReturnType<typeof grepToolYarat> | ReturnType<typeof findToolYarat> | ReturnType<typeof lsToolYarat>,
  params: unknown,
): Promise<string> {
  const natija = await (tool as {
    execute: (
      id: string,
      p: unknown,
      s: AbortSignal | undefined,
      u: unknown,
      k: { env: { cwd: string } },
    ) => Promise<{ content: { type: string; text?: string }[] }>
  }).execute('sinov-1', params, undefined, undefined, { env: { cwd: ish } })
  return natija.content.map((c) => c.text ?? '').join('')
}

beforeEach(() => {
  // Node zaxirasini majburlaymiz — `rg` bor PC'da ham shu yo'l sinaladi
  rgKeshiniOrnat(false)
  ish = mkdtempSync(join(tmpdir(), 'qidiruv-tool-'))
})

afterEach(() => {
  rgKeshiniOrnat(undefined)
  rmSync(ish, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('glob → regexp', () => {
  test('`*` segment ichida qoladi', () => {
    expect(globniRegexpga('*.ts').test('a.ts')).toBe(true)
    expect(globniRegexpga('*.ts').test('src/a.ts')).toBe(false)
  })

  test('`**` segmentlardan o\'tadi', () => {
    expect(globniRegexpga('src/**/*.ts').test('src/a/b/c.ts')).toBe(true)
  })

  test('`**/` nol segmentga ham mos keladi', () => {
    expect(globniRegexpga('**/*.ts').test('a.ts')).toBe(true)
    expect(globniRegexpga('**/*.ts').test('a/b.ts')).toBe(true)
  })

  test('`?` bitta belgi, `/` emas', () => {
    expect(globniRegexpga('?.ts').test('a.ts')).toBe(true)
    expect(globniRegexpga('?.ts').test('ab.ts')).toBe(false)
  })

  test('`{a,b}` variantlari', () => {
    const re = globniRegexpga('*.{ts,md}')
    expect(re.test('a.ts')).toBe(true)
    expect(re.test('a.md')).toBe(true)
    expect(re.test('a.js')).toBe(false)
  })

  test('belgi to\'plami `[ab]`', () => {
    expect(globniRegexpga('[ab].ts').test('a.ts')).toBe(true)
    expect(globniRegexpga('[ab].ts').test('c.ts')).toBe(false)
  })

  test('nuqta literal sifatida ekranlanadi', () => {
    expect(globniRegexpga('a.ts').test('axts')).toBe(false)
  })

  test('`/` siz naqsh faqat fayl nomiga qo\'llanadi', () => {
    expect(globMosKeladimi('*.ts', 'chuqur/papka/a.ts')).toBe(true)
    expect(globMosKeladimi('src/*.ts', 'chuqur/papka/a.ts')).toBe(false)
  })
})

describe('yordamchi funksiyalar', () => {
  test('yolTartibi kod nuqtasi bo\'yicha, lokaldan mustaqil', () => {
    expect(yolTartibi('a', 'b')).toBeLessThan(0)
    expect(yolTartibi('b', 'a')).toBeGreaterThan(0)
    expect(yolTartibi('a', 'a')).toBe(0)
    // Katta harf kichikdan oldin — ASCII tartibi
    expect(yolTartibi('Z', 'a')).toBeLessThan(0)
  })

  test('qatorniTayyorla uzun qatorni kesadi', () => {
    const uzun = 'x'.repeat(QATOR_CHEGARASI + 100)
    const natija = qatorniTayyorla(uzun)
    expect(natija.length).toBe(QATOR_CHEGARASI + 1) // + `…`
    expect(natija.endsWith('…')).toBe(true)
  })

  test('qatorniTayyorla qisqa qatorga tegmaydi', () => {
    expect(qatorniTayyorla('qisqa')).toBe('qisqa')
  })

  test('qatorniTayyorla oxiridagi `\\r\\n` ni olib tashlaydi', () => {
    expect(qatorniTayyorla('matn\r\n')).toBe('matn')
    expect(qatorniTayyorla('matn\n')).toBe('matn')
  })

  test('ikkilikmi NUL bayt bo\'yicha aniqlaydi', () => {
    expect(ikkilikmi(new Uint8Array([1, 2, 0, 3]))).toBe(true)
    expect(ikkilikmi(new Uint8Array([1, 2, 3]))).toBe(false)
  })

  test('olchamniMatnga o\'qishga qulay ko\'rinish beradi', () => {
    expect(olchamniMatnga(512)).toBe('512B')
    expect(olchamniMatnga(2048)).toBe('2.0K')
    expect(olchamniMatnga(3 * 1024 * 1024)).toBe('3.0M')
  })
})

// ---------------------------------------------------------------------------

describe('grep tool', () => {
  beforeEach(() => {
    writeFileSync(join(ish, 'a.ts'), 'const salom = 1\nconst xayr = 2\n')
    mkdirSync(join(ish, 'src'), { recursive: true })
    writeFileSync(join(ish, 'src', 'b.ts'), 'salom ichkarida\n')
  })

  test('`fayl:qator:matn` formatida qaytaradi', async () => {
    const matn = await toolniChaqir(grepToolYarat(), { pattern: 'salom' })
    expect(matn).toBe('a.ts:1:const salom = 1\nsrc/b.ts:1:salom ichkarida')
  })

  test('topilmasa tushunarli xabar', async () => {
    const matn = await toolniChaqir(grepToolYarat(), { pattern: 'yoq-bunday-soz' })
    expect(matn).toBe('No matches found.')
  })

  test('glob filtri ishlaydi', async () => {
    const matn = await toolniChaqir(grepToolYarat(), { pattern: 'salom', glob: 'src/*.ts' })
    expect(matn).toBe('src/b.ts:1:salom ichkarida')
  })

  test('caseInsensitive ishlaydi', async () => {
    writeFileSync(join(ish, 'katta.ts'), 'SALOM\n')
    const matn = await toolniChaqir(grepToolYarat(), { pattern: 'salom', caseInsensitive: true })
    expect(matn).toContain('katta.ts:1:SALOM')
  })

  test('tashqi yo\'l uchun xato tashlaydi (ruxsat SO\'RALMAYDI)', async () => {
    const urinish = toolniChaqir(grepToolYarat(), { pattern: 'x', path: '../..' })
    expect(urinish).rejects.toThrow(/Permission denied/)
  })

  test('tafsilotda backend va soni bor', async () => {
    const tool = grepToolYarat()
    const natija = await (tool as unknown as {
      execute: (i: string, p: unknown, s: undefined, u: undefined, k: unknown) => Promise<{ details: unknown }>
    }).execute('id', { pattern: 'salom' }, undefined, undefined, { env: { cwd: ish } })
    expect(natija.details).toEqual({ backend: 'node', soni: 2, kesildi: false })
  })

  test('chegaradan oshsa kesilgani aytiladi', async () => {
    const kopQator = Array.from({ length: 50 }, () => 'salom').join('\n')
    writeFileSync(join(ish, 'kop.ts'), kopQator + '\n')
    const n = await grepNode({ ishPapkasi: ish, pattern: 'salom', chegara: 10 })
    expect(n.kesildi).toBe(true)
    expect(n.elementlar).toHaveLength(10)
    const matn = grepNatijasiniMatnga(n)
    expect(matn).toContain('capped')
    expect(matn).toContain('Naqshni toraytiring')
  })

  test('uzun qator natijada kesiladi', async () => {
    writeFileSync(join(ish, 'uzun.ts'), 'salom ' + 'y'.repeat(3000) + '\n')
    const n = await grepNode({ ishPapkasi: ish, pattern: 'salom', glob: 'uzun.ts' })
    expect(n.elementlar[0]!.matn.length).toBe(QATOR_CHEGARASI + 1)
  })

  test('tashlanadigan papkalar standart holda qidirilmaydi', async () => {
    mkdirSync(join(ish, 'node_modules'), { recursive: true })
    writeFileSync(join(ish, 'node_modules', 'x.ts'), 'salom paketda\n')
    const n = await grepNode({ ishPapkasi: ish, pattern: 'salom' })
    expect(n.elementlar.some((m) => m.yol.startsWith('node_modules/'))).toBe(false)
  })

  test('`all: true` bilan tashlanadigan papkalar ham qidiriladi', async () => {
    mkdirSync(join(ish, 'node_modules'), { recursive: true })
    writeFileSync(join(ish, 'node_modules', 'x.ts'), 'salom paketda\n')
    const n = await grepNode({ ishPapkasi: ish, pattern: 'salom', barchasi: true })
    expect(n.elementlar.some((m) => m.yol.startsWith('node_modules/'))).toBe(true)
  })

  test('aniq so\'ralgan `node_modules` ichi qidiriladi', async () => {
    // Agent ataylab `path: 'node_modules/paket'` bersa, uni ko'rsatish kerak —
    // "tashlab yuborish" faqat aylanib chiqishga tegishli
    mkdirSync(join(ish, 'node_modules', 'paket'), { recursive: true })
    writeFileSync(join(ish, 'node_modules', 'paket', 'x.ts'), 'salom paketda\n')
    const n = await grepNode({ ishPapkasi: ish, pattern: 'salom', path: 'node_modules/paket' })
    expect(n.elementlar).toHaveLength(1)
  })

  test('ikkilik fayl qidirilmaydi', async () => {
    writeFileSync(join(ish, 'binar.dat'), Buffer.from([0x73, 0x61, 0x6c, 0x6f, 0x6d, 0x00]))
    const n = await grepNode({ ishPapkasi: ish, pattern: 'salom' })
    expect(n.elementlar.some((m) => m.yol === 'binar.dat')).toBe(false)
  })

  test('o\'qib bo\'lmaydigan papka natijani buzmaydi', async () => {
    // Mavjud bo'lmagan papkaga symlink — `readdir` xato beradi, lekin
    // qidiruv davom etishi kerak
    symlinkSync(join(ish, 'yoq'), join(ish, 'singan-koprik'))
    const n = await grepNode({ ishPapkasi: ish, pattern: 'salom' })
    expect(n.elementlar.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------

describe('find tool', () => {
  beforeEach(() => {
    writeFileSync(join(ish, 'a.ts'), '')
    writeFileSync(join(ish, 'b.md'), '')
    mkdirSync(join(ish, 'src', 'ichki'), { recursive: true })
    writeFileSync(join(ish, 'src', 'c.ts'), '')
    writeFileSync(join(ish, 'src', 'ichki', 'd.ts'), '')
  })

  test('glob bo\'yicha topadi va saralaydi', async () => {
    const matn = await toolniChaqir(findToolYarat(), { pattern: '*.ts' })
    expect(matn).toBe('a.ts\nsrc/c.ts\nsrc/ichki/d.ts')
  })

  test('ichma-ich glob', async () => {
    const matn = await toolniChaqir(findToolYarat(), { pattern: 'src/**/*.ts' })
    expect(matn).toBe('src/c.ts\nsrc/ichki/d.ts')
  })

  test('topilmasa tushunarli xabar', async () => {
    const matn = await toolniChaqir(findToolYarat(), { pattern: '*.yoq' })
    expect(matn).toBe('No files found.')
  })

  test('`path` bilan cheklanadi', async () => {
    const matn = await toolniChaqir(findToolYarat(), { pattern: '*.ts', path: 'src/ichki' })
    expect(matn).toBe('src/ichki/d.ts')
  })

  test('chegaradan oshsa kesilgani aytiladi', async () => {
    for (let i = 0; i < 20; i += 1) writeFileSync(join(ish, `f${i}.txt`), '')
    const n = await findNode({ ishPapkasi: ish, pattern: '*.txt', chegara: 5 })
    expect(n.kesildi).toBe(true)
    expect(n.elementlar).toHaveLength(5)
    expect(findNatijasiniMatnga(n)).toContain('capped')
  })

  test('tashqi yo\'l rad etiladi', async () => {
    const urinish = toolniChaqir(findToolYarat(), { pattern: '*', path: '/etc' })
    expect(urinish).rejects.toThrow(/Permission denied/)
  })

  test('tashlanadigan papkalar standart holda chiqmaydi', async () => {
    mkdirSync(join(ish, 'dist'), { recursive: true })
    writeFileSync(join(ish, 'dist', 'x.ts'), '')
    const n = await findNode({ ishPapkasi: ish, pattern: '*.ts' })
    expect(n.elementlar.some((y) => y.startsWith('dist/'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('ls tool', () => {
  beforeEach(() => {
    writeFileSync(join(ish, 'kichik.txt'), 'x'.repeat(100))
    writeFileSync(join(ish, 'katta.txt'), 'y'.repeat(5000))
    mkdirSync(join(ish, 'papka'), { recursive: true })
  })

  test('papka `/` bilan, fayl o\'lchami bilan ko\'rsatiladi', async () => {
    const matn = await toolniChaqir(lsToolYarat(), {})
    expect(matn).toBe('papka/\nkatta.txt  (4.9K)\nkichik.txt  (100B)')
  })

  test('papkalar fayllardan oldin turadi', async () => {
    mkdirSync(join(ish, 'zzz-papka'), { recursive: true })
    writeFileSync(join(ish, 'aaa.txt'), '')
    const n = await lsRoyxat({ ishPapkasi: ish })
    const turlar = n.elementlar.map((e) => e.tur)
    const birinchiFayl = turlar.indexOf('fayl')
    const oxirgiPapka = turlar.lastIndexOf('papka')
    expect(oxirgiPapka).toBeLessThan(birinchiFayl)
  })

  test('symlink `@` bilan belgilanadi', async () => {
    symlinkSync(join(ish, 'kichik.txt'), join(ish, 'havola'))
    const matn = await toolniChaqir(lsToolYarat(), {})
    expect(matn).toContain('havola@')
  })

  test('ichki papkani ro\'yxatlaydi', async () => {
    writeFileSync(join(ish, 'papka', 'ichi.txt'), 'z')
    const matn = await toolniChaqir(lsToolYarat(), { path: 'papka' })
    expect(matn).toBe('ichi.txt  (1B)')
  })

  test('bo\'sh papka uchun xabar', async () => {
    const matn = await toolniChaqir(lsToolYarat(), { path: 'papka' })
    expect(matn).toBe('The directory is empty.')
  })

  test('tashlanadigan papkalar standart holda yashiriladi', async () => {
    mkdirSync(join(ish, 'node_modules'), { recursive: true })
    const n = await lsRoyxat({ ishPapkasi: ish })
    expect(n.elementlar.some((e) => e.nom === 'node_modules')).toBe(false)
  })

  test('`all: true` bilan ular ham ko\'rinadi', async () => {
    mkdirSync(join(ish, 'node_modules'), { recursive: true })
    const n = await lsRoyxat({ ishPapkasi: ish, barchasi: true })
    expect(n.elementlar.some((e) => e.nom === 'node_modules')).toBe(true)
  })

  test('mavjud bo\'lmagan papka uchun tushunarli xato', async () => {
    const urinish = lsRoyxat({ ishPapkasi: ish, path: 'yoq-bunday-papka' })
    expect(urinish).rejects.toThrow(/Not found/)
  })

  test('fayl berilsa "papka emas" xatosi', async () => {
    const urinish = lsRoyxat({ ishPapkasi: ish, path: 'kichik.txt' })
    expect(urinish).rejects.toThrow(/Not a directory/)
  })

  test('tashqi yo\'l rad etiladi', async () => {
    const urinish = toolniChaqir(lsToolYarat(), { path: '/etc' })
    expect(urinish).rejects.toThrow(/Permission denied/)
  })

  test('chegaradan oshsa kesilgani aytiladi', async () => {
    for (let i = 0; i < 20; i += 1) writeFileSync(join(ish, `f${i}.txt`), '')
    const n = await lsRoyxat({ ishPapkasi: ish, chegara: 5 })
    expect(n.kesildi).toBe(true)
    expect(lsNatijasiniMatnga(n)).toContain('capped')
  })
})

// ---------------------------------------------------------------------------

describe('tool interfeysi agent.ts bilan mos', () => {
  test('uchala tool qaytadi', () => {
    expect(qidiruvToollariXom().map((t) => t.name)).toEqual(['grep', 'find', 'ls'])
    expect(qidiruvToollari({ env: { cwd: ish } }).map((t) => t.name)).toEqual(['grep', 'find', 'ls'])
  })

  test('xom shaklda kontekst 5-argument sifatida kutiladi', () => {
    for (const tool of qidiruvToollariXom()) {
      expect(typeof tool.name).toBe('string')
      expect(typeof tool.label).toBe('string')
      expect(typeof tool.description).toBe('string')
      expect(tool.parameters).toBeDefined()
      expect(typeof tool.execute).toBe('function')
      // pi'ning `AgentHarnessTool` shakli — kontekst oxirgi argument
      expect(tool.execute.length).toBe(5)
    }
  })

  test("biriktirilgan shaklda `execute` pi'ning AgentTool shakliga mos (4 argument)", () => {
    // `agent.ts` bu ro'yxatni to'g'ridan-to'g'ri `Agent` ga bera oladi:
    // kontekst allaqachon ichida, qo'shimcha o'ram kerak emas
    for (const tool of qidiruvToollari({ env: { cwd: ish } })) {
      expect(typeof tool.execute).toBe('function')
      expect(tool.execute.length).toBe(4)
    }
  })

  test('biriktirilgan tool kontekstsiz chaqirilganda ham ishlaydi', async () => {
    // Asosiy maqsad: `qidiruvToollari(kontekst)` dan qaytgan tool'ni
    // `agent.ts` KONTEKSTSIZ chaqira oladimi — ya'ni `cwd` haqiqatan
    // biriktirilganmi. Agar biriktirish ishlamasa, bu yerda xato bo'lardi.
    writeFileSync(join(ish, 'a.txt'), 'salom\n')
    const [grep] = qidiruvToollari({ env: { cwd: ish } })
    const natija = await grep!.execute('id', { pattern: 'salom' } as never, undefined)
    const matn = (natija.content as { type: string; text: string }[])[0]!.text
    expect(matn).toBe('a.txt:1:salom')
  })

  test('sxemalar typebox obyekti (pi shuni kutadi)', () => {
    for (const tool of qidiruvToollariXom()) {
      const sxema = tool.parameters as { type?: string; properties?: Record<string, unknown> }
      expect(sxema.type).toBe('object')
      expect(sxema.properties).toBeDefined()
    }
  })

  test('grep sxemasida `pattern` majburiy', () => {
    const sxema = qidiruvToollariXom()[0]!.parameters as { required?: string[] }
    expect(sxema.required).toContain('pattern')
  })

  test('QIDIRUV_PROMPT_QISMI uchala toolni tilga oladi', () => {
    const hammasi = [...QIDIRUV_PROMPT_QISMI.royxat, ...QIDIRUV_PROMPT_QISMI.qoida].join('\n')
    expect(QIDIRUV_PROMPT_QISMI.royxat).toHaveLength(3)
    for (const nom of ['grep', 'find', 'ls']) expect(hammasi).toContain(nom)
    // Qoidada `bash` o'rniga bularni ishlatish aytilgan bo'lishi kerak
    expect(hammasi).toContain('bash')
  })

  test('tool natijasi pi shaklida', async () => {
    writeFileSync(join(ish, 'a.txt'), 'salom\n')
    const tool = grepToolYarat()
    const natija = await (tool as unknown as {
      execute: (i: string, p: unknown, s: undefined, u: undefined, k: unknown) => Promise<{
        content: { type: string; text: string }[]
      }>
    }).execute('id', { pattern: 'salom' }, undefined, undefined, { env: { cwd: ish } })
    expect(natija.content).toHaveLength(1)
    expect(natija.content[0]!.type).toBe('text')
  })

  test('abort signali qidiruvni to\'xtatadi', async () => {
    for (let i = 0; i < 50; i += 1) writeFileSync(join(ish, `f${i}.txt`), 'salom\n')
    const boshqaruvchi = new AbortController()
    boshqaruvchi.abort()
    const urinish = grepNode({ ishPapkasi: ish, pattern: 'salom', signal: boshqaruvchi.signal })
    expect(urinish).rejects.toThrow()
  })
})

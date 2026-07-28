// IKKI BACKEND BIR XILLIGI — bu fayl butun qidiruv qatlamining eng muhim testi.
//
// NEGA: `rg` bor PC'da agent bir xil, `rg` yo'q PC'da boshqacha ishlasa —
// bu jimgina buziladigan xato. Hech qanday istisno tashlanmaydi, log
// chiqmaydi; shunchaki foydalanuvchi "menda ishlaydi, sende ishlamaydi"
// deb qoladi va sababini hech qachon topmaydi. Shuning uchun bir xillik
// niyat bo'lib qolmasligi kerak — u SHU YERDA majburlanadi.
//
// Usul: bir xil kirish uchun `grepRg()` va `grepNode()` ALOHIDA chaqiriladi
// (tanlovchi `grepQidir()` emas — u faqat bittasini ishga tushirardi), keyin
// natijalar TARTIBI BILAN solishtiriladi.
//
// `rg` yo'q tizimda bu testlar o'tkazib yuboriladi (`test.if`), lekin Node
// yo'lining o'zi qolgan fayllarda to'liq sinaladi.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findNode, findRg, grepNode, grepRg } from '../src/qidiruv-motor.ts'
import type { FindSozlamalari, GrepSozlamalari } from '../src/qidiruv-motor.ts'
import { rgBormi } from './qidiruv-yordamchi.ts'

let ish: string

/** Sinov uchun boy fayl daraxti — bir xillikni buzishi mumkin joylarni qamraydi */
function daraxtniYarat(asos: string): void {
  const yoz = (nisbiy: string, mazmun: string) => {
    const toliq = join(asos, nisbiy)
    mkdirSync(join(toliq, '..'), { recursive: true })
    writeFileSync(toliq, mazmun)
  }

  yoz('a.ts', 'const salom = 1\nexport { salom }\n')
  yoz('b.ts', 'const SALOM = 2\n')
  yoz('c.md', 'salom dunyo\n')
  yoz('src/ichki.ts', 'function salom() {}\n')
  yoz('src/chuqur/juda/ichkari.ts', 'salom bu chuqurda\n')
  yoz('src/boshqa.txt', 'salom matn\n')

  // Yashirin fayl — `rg` standart holda ko'rmaydi, `--hidden` bilan ko'radi.
  // Ikkala backend ham ko'rishi kerak.
  yoz('.yashirin.ts', 'salom yashirin\n')
  yoz('.yashirinpapka/ichi.ts', 'salom yashirin papkada\n')

  // Gitignore — QAROR: ikkala backend ham uni O'QIMAYDI.
  // Agar `rg` gitignore'ni hurmat qilsa, `chetlangan.ts` uning natijasida
  // bo'lmasdi, Node esa uni topardi — aynan shu farqni ushlash uchun.
  yoz('.gitignore', 'chetlangan.ts\nchetlangan-papka/\n*.log\n')
  yoz('chetlangan.ts', 'salom chetlangan\n')
  yoz('chetlangan-papka/ichi.ts', 'salom chetlangan papkada\n')
  yoz('jurnal.log', 'salom jurnalda\n')

  // Ichma-ich gitignore — Node'da takrorlash eng qiyin joy
  yoz('src/.gitignore', 'boshqa.txt\n')

  // Tashlanadigan papkalar — ikkalasi ham chiqarib tashlashi kerak
  yoz('node_modules/paket/index.ts', 'salom paketda\n')
  yoz('.git/HEAD', 'salom gitda\n')
  yoz('dist/qurilgan.ts', 'salom distda\n')

  // Nomida `:` bor fayl — `fayl:qator:matn` ajratuvchisini sinaydi
  yoz('g'.repeat(1) + 'alati:nom.ts', 'salom alatida\n')

  // Juda uzun qator — kesish ikkala tomonda bir xil bo'lishi kerak
  yoz('uzun.ts', 'salom ' + 'x'.repeat(2000) + '\n')

  // Ikkilik fayl — ikkalasi ham tashlashi kerak
  writeFileSync(join(asos, 'binar.dat'), Buffer.from([0x73, 0x61, 0x6c, 0x6f, 0x6d, 0x00, 0xff]))

  // Oxirida `\n` bo'lmagan fayl — qator sanashda farq chiqishi mumkin
  yoz('oxirsiz.ts', 'salom oxirsiz')

  // CRLF qatorlar — `\r` ni tozalash ikkalasida bir xil bo'lsin
  yoz('crlf.ts', 'salom crlf\r\nikkinchi\r\n')

  // Bo'sh fayl
  yoz('bosh.ts', '')

  // Bir faylda ko'p moslik — qator tartibini sinaydi
  yoz('kop.ts', 'salom\nyoq\nsalom\nyoq\nsalom\n')

  // UTF-8 belgilar
  yoz('unicode.ts', "salom o'zbek tili — ҳарфлар\n")
}

beforeEach(() => {
  ish = mkdtempSync(join(tmpdir(), 'qidiruv-birxil-'))
  daraxtniYarat(ish)
})

afterEach(() => {
  rmSync(ish, { recursive: true, force: true })
})

/**
 * Ikkala backendni bir xil kirish bilan chaqirib solishtiradi.
 *
 * `toEqual` massiv TARTIBINI ham tekshiradi — bu ataylab: tartib farqi
 * ham xato, chunki chegara (200 moslik) tartibga qarab boshqa 200 talikni
 * kesib qolardi.
 */
async function grepSolishtir(sozlama: Omit<GrepSozlamalari, 'ishPapkasi'>): Promise<void> {
  const [rg, node] = await Promise.all([
    grepRg({ ishPapkasi: ish, ...sozlama }),
    grepNode({ ishPapkasi: ish, ...sozlama }),
  ])
  expect(rg.backend).toBe('rg')
  expect(node.backend).toBe('node')
  expect(rg.elementlar).toEqual(node.elementlar)
  expect(rg.kesildi).toBe(node.kesildi)
}

async function findSolishtir(sozlama: Omit<FindSozlamalari, 'ishPapkasi'>): Promise<void> {
  const [rg, node] = await Promise.all([
    findRg({ ishPapkasi: ish, ...sozlama }),
    findNode({ ishPapkasi: ish, ...sozlama }),
  ])
  expect(rg.elementlar).toEqual(node.elementlar)
  expect(rg.kesildi).toBe(node.kesildi)
}

describe('grep — ikki backend bir xil', () => {
  test.if(rgBormi())('oddiy naqsh', async () => {
    await grepSolishtir({ pattern: 'salom' })
  })

  test.if(rgBormi())('katta-kichik harf farqi', async () => {
    await grepSolishtir({ pattern: 'SALOM' })
  })

  test.if(rgBormi())('caseInsensitive', async () => {
    await grepSolishtir({ pattern: 'salom', caseInsensitive: true })
  })

  test.if(rgBormi())('regex metabelgilari', async () => {
    await grepSolishtir({ pattern: 'sal[o0]m\\s+\\w+' })
  })

  test.if(rgBormi())('qator boshi va oxiri langarlari', async () => {
    await grepSolishtir({ pattern: '^const .*= \\d$' })
  })

  test.if(rgBormi())('lookahead — PCRE2 talab qilinadigan sheva', async () => {
    // Bu aynan `rg` ning standart Rust engine'i RAD ETADIGAN naqsh.
    // `--pcre2` bo'lmasa bu test yiqilardi — ya'ni u shevaning bir xil
    // qolishini qo'riqlaydi.
    await grepSolishtir({ pattern: 'salom(?=\\s+dunyo)' })
  })

  test.if(rgBormi())('lookbehind', async () => {
    await grepSolishtir({ pattern: '(?<=const )salom' })
  })

  test.if(rgBormi())('glob filtri — kengaytma', async () => {
    await grepSolishtir({ pattern: 'salom', glob: '*.ts' })
  })

  test.if(rgBormi())('glob filtri — ichma-ich yo\'l', async () => {
    await grepSolishtir({ pattern: 'salom', glob: 'src/**/*.ts' })
  })

  test.if(rgBormi())('glob filtri — `{a,b}` variantlari', async () => {
    await grepSolishtir({ pattern: 'salom', glob: '*.{ts,md}' })
  })

  test.if(rgBormi())('ichki papkadan qidirish', async () => {
    await grepSolishtir({ pattern: 'salom', path: 'src' })
  })

  test.if(rgBormi())('chuqur ichki papkadan qidirish', async () => {
    await grepSolishtir({ pattern: 'salom', path: 'src/chuqur' })
  })

  test.if(rgBormi())('`all: true` — tashlanadigan papkalar ham', async () => {
    await grepSolishtir({ pattern: 'salom', barchasi: true })
  })

  test.if(rgBormi())('hech narsa topilmaganda', async () => {
    await grepSolishtir({ pattern: 'bunday-so\'z-umuman-yo\'q-12345' })
  })

  test.if(rgBormi())('uzun qator kesilishi', async () => {
    await grepSolishtir({ pattern: 'xxxxx' })
  })

  test.if(rgBormi())('unicode belgilar', async () => {
    await grepSolishtir({ pattern: 'ҳарфлар' })
  })

  test.if(rgBormi())('CRLF qatorlar', async () => {
    await grepSolishtir({ pattern: 'crlf' })
  })

  test.if(rgBormi())('oxirida `\\n` bo\'lmagan fayl', async () => {
    await grepSolishtir({ pattern: 'oxirsiz' })
  })

  test.if(rgBormi())('bir faylda ko\'p moslik — qator tartibi', async () => {
    await grepSolishtir({ pattern: 'salom', glob: 'kop.ts' })
  })

  test.if(rgBormi())('chegara kesilganda ham bir xil', async () => {
    // Chegarani ataylab kichik qilamiz — ikkala backend AYNAN bir xil
    // birinchi 3 talikni tanlashi kerak. Bu `rg` ning tasodifiy tartibi
    // natijaga sizib o'tmaganini isbotlaydi.
    const [rg, node] = await Promise.all([
      grepRg({ ishPapkasi: ish, pattern: 'salom', chegara: 3 }),
      grepNode({ ishPapkasi: ish, pattern: 'salom', chegara: 3 }),
    ])
    expect(rg.elementlar).toEqual(node.elementlar)
    expect(rg.elementlar).toHaveLength(3)
    expect(rg.kesildi).toBe(true)
    expect(node.kesildi).toBe(true)
  })

  test.if(rgBormi())('rg tartibi tasodifiy bo\'lsa ham natija barqaror', async () => {
    // `rg` ni bir necha marta chaqirib, har safar AYNAN bir xil natija
    // kelishini tekshiramiz. Saralashsiz bu test beqaror bo'lardi —
    // sinovda `rg` uch marta uch xil tartib bergan edi.
    const birinchi = await grepRg({ ishPapkasi: ish, pattern: 'salom' })
    for (let i = 0; i < 4; i += 1) {
      const keyingi = await grepRg({ ishPapkasi: ish, pattern: 'salom' })
      expect(keyingi.elementlar).toEqual(birinchi.elementlar)
    }
  })

  test.if(rgBormi())('gitignore IKKALA backendda ham o\'qilmaydi', async () => {
    // Bu qarorning ochiq testi: `.gitignore` da `chetlangan.ts` bor,
    // lekin u NATIJADA BO'LISHI KERAK — chunki biz gitignore'ni ataylab
    // o'qimaymiz. Agar kimdir `rg` dan `--no-ignore` ni olib tashlasa,
    // bu test yiqiladi.
    const rg = await grepRg({ ishPapkasi: ish, pattern: 'salom' })
    const node = await grepNode({ ishPapkasi: ish, pattern: 'salom' })
    const rgYollar = rg.elementlar.map((m) => m.yol)
    expect(rgYollar).toContain('chetlangan.ts')
    expect(rgYollar).toContain('jurnal.log')
    expect(rgYollar).toContain('chetlangan-papka/ichi.ts')
    // Ichma-ich `.gitignore` dagi fayl ham ko'rinadi
    expect(rgYollar).toContain('src/boshqa.txt')
    expect(rg.elementlar).toEqual(node.elementlar)
  })

  test.if(rgBormi())('ikkilik fayl ikkalasida ham tashlanadi', async () => {
    const rg = await grepRg({ ishPapkasi: ish, pattern: 'salom' })
    const node = await grepNode({ ishPapkasi: ish, pattern: 'salom' })
    expect(rg.elementlar.map((m) => m.yol)).not.toContain('binar.dat')
    expect(node.elementlar.map((m) => m.yol)).not.toContain('binar.dat')
  })

  test.if(rgBormi())('yashirin fayllar ikkalasida ham qidiriladi', async () => {
    const rg = await grepRg({ ishPapkasi: ish, pattern: 'salom' })
    expect(rg.elementlar.map((m) => m.yol)).toContain('.yashirin.ts')
    expect(rg.elementlar.map((m) => m.yol)).toContain('.yashirinpapka/ichi.ts')
    await grepSolishtir({ pattern: 'salom' })
  })

  test.if(rgBormi())('nomida `:` bor fayl to\'g\'ri ajratiladi', async () => {
    // `rg` chiqishi `galati:nom.ts:1:salom alatida` bo'ladi — yo'ldagi `:`
    // ajratuvchi bilan chalkashmasligi kerak
    const rg = await grepRg({ ishPapkasi: ish, pattern: 'alatida' })
    const node = await grepNode({ ishPapkasi: ish, pattern: 'alatida' })
    expect(rg.elementlar).toEqual(node.elementlar)
    expect(rg.elementlar[0]?.yol).toBe('galati:nom.ts')
    expect(rg.elementlar[0]?.qator).toBe(1)
  })

  test.if(rgBormi())('symlink ikkalasida ham kuzatilmaydi', async () => {
    const tashqi = mkdtempSync(join(tmpdir(), 'qidiruv-tashqi-'))
    try {
      writeFileSync(join(tashqi, 'tashqi-salom.ts'), 'salom tashqarida\n')
      symlinkSync(tashqi, join(ish, 'koprik'))
      await grepSolishtir({ pattern: 'salom' })
      const rg = await grepRg({ ishPapkasi: ish, pattern: 'tashqarida' })
      expect(rg.elementlar).toHaveLength(0)
    } finally {
      rmSync(tashqi, { recursive: true, force: true })
    }
  })
})

describe('find — ikki backend bir xil', () => {
  test.if(rgBormi())('kengaytma bo\'yicha', async () => {
    await findSolishtir({ pattern: '*.ts' })
  })

  test.if(rgBormi())('ichma-ich glob', async () => {
    await findSolishtir({ pattern: 'src/**/*.ts' })
  })

  test.if(rgBormi())('`**/` prefiksi', async () => {
    await findSolishtir({ pattern: '**/*.md' })
  })

  test.if(rgBormi())('variantlar `{a,b}`', async () => {
    await findSolishtir({ pattern: '*.{ts,md}' })
  })

  test.if(rgBormi())('aniq fayl nomi', async () => {
    await findSolishtir({ pattern: 'a.ts' })
  })

  test.if(rgBormi())('`?` bitta belgi', async () => {
    await findSolishtir({ pattern: '?.ts' })
  })

  test.if(rgBormi())('ichki papkadan', async () => {
    await findSolishtir({ pattern: '*.ts', path: 'src' })
  })

  test.if(rgBormi())('`all: true`', async () => {
    await findSolishtir({ pattern: '*.ts', barchasi: true })
  })

  test.if(rgBormi())('hech narsa topilmaganda', async () => {
    await findSolishtir({ pattern: '*.bunday-kengaytma-yoq' })
  })

  test.if(rgBormi())('chegara kesilganda bir xil', async () => {
    const [rg, node] = await Promise.all([
      findRg({ ishPapkasi: ish, pattern: '*.ts', chegara: 2 }),
      findNode({ ishPapkasi: ish, pattern: '*.ts', chegara: 2 }),
    ])
    expect(rg.elementlar).toEqual(node.elementlar)
    expect(rg.kesildi).toBe(true)
  })

  test.if(rgBormi())('gitignore find\'da ham o\'qilmaydi', async () => {
    const rg = await findRg({ ishPapkasi: ish, pattern: '*.ts' })
    expect(rg.elementlar).toContain('chetlangan.ts')
    expect(rg.elementlar).toContain('chetlangan-papka/ichi.ts')
  })

  test.if(rgBormi())('tashlanadigan papkalar ikkalasida ham chiqmaydi', async () => {
    const rg = await findRg({ ishPapkasi: ish, pattern: '*.ts' })
    const node = await findNode({ ishPapkasi: ish, pattern: '*.ts' })
    for (const royxat of [rg.elementlar, node.elementlar]) {
      expect(royxat.some((y) => y.startsWith('node_modules/'))).toBe(false)
      expect(royxat.some((y) => y.startsWith('dist/'))).toBe(false)
      expect(royxat.some((y) => y.startsWith('.git/'))).toBe(false)
    }
    expect(rg.elementlar).toEqual(node.elementlar)
  })
})

describe('bir xillik buzilganda test uni ushlaydimi', () => {
  test.if(rgBormi())('saralash olib tashlansa natija farq qilardi (nazorat)', async () => {
    // Bu test bevosita mahsulot kodini emas, TEST USULINI tekshiradi:
    // saralanmagan `rg` chiqishi haqiqatan ham beqaror ekanini isbotlaydi.
    // Agar `rg` birdan barqaror tartib bera boshlasa, yuqoridagi
    // "bir xil" testlar yolg'on xotirjamlik berardi — shuni bilib turaylik.
    const n = await grepRg({ ishPapkasi: ish, pattern: 'salom' })
    // Saralanganini tasdiqlaymiz: yo'llar o'sish tartibida
    const yollar = n.elementlar.map((m) => `${m.yol}:${String(m.qator).padStart(6, '0')}`)
    const nusxa = [...yollar].sort()
    expect(yollar).toEqual(nusxa)
  })
})

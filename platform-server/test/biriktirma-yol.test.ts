// Biriktirmalarning YO'L qatlami: papka tanlash, nom sanitizatsiyasi va
// tur aniqlash. Baza va HTTP bu yerda qatnashmaydi — hammasi sof funksiya
// yoki fayl tizimi.
//
// Nom sanitizatsiyasi XAVFSIZLIK CHEGARASI: nom diskka yoziladi va agentga
// promptda ko'rsatiladi, ya'ni yo'ldan chiqish (`../`) va shell metabelgisi
// ikkalasi ham shu yerda yopilishi kerak. Shuning uchun testlar "ishlaydi"
// ni emas, aynan HUJUM naqshlarini tekshiradi.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rasmKengaytmasi, rasmTuri } from '../src/biriktirma.ts'
import {
  bandsizNom,
  FAYLLAR_PAPKASI,
  SESSIYA_PAPKASI,
  sessiyaFayllarPapkasi,
  yuklamaNomi,
} from '../src/ish-papkasi.ts'

let vaqtinchalik: string

beforeEach(() => {
  vaqtinchalik = mkdtempSync(join(tmpdir(), 'platforma-biriktirma-'))
})

afterEach(() => {
  rmSync(vaqtinchalik, { recursive: true, force: true })
})

describe('sessiyaFayllarPapkasi', () => {
  test('papka yaratiladi va nisbiy yo\'l qaytadi', () => {
    const { toliq, nisbiy } = sessiyaFayllarPapkasi(vaqtinchalik, 'sid-1')

    expect(existsSync(toliq)).toBe(true)
    expect(nisbiy).toBe(join(SESSIYA_PAPKASI, 'sid-1', FAYLLAR_PAPKASI))
    expect(toliq).toBe(join(vaqtinchalik, nisbiy))
  })

  test('har sessiya o\'z papkasini oladi', () => {
    const bir = sessiyaFayllarPapkasi(vaqtinchalik, 'sid-1')
    const ikki = sessiyaFayllarPapkasi(vaqtinchalik, 'sid-2')

    expect(bir.toliq).not.toBe(ikki.toliq)
    expect(existsSync(bir.toliq)).toBe(true)
    expect(existsSync(ikki.toliq)).toBe(true)
  })

  // Sessiya id'si UUID, lekin tashqaridan kelgan qiymatga ishonmaymiz —
  // `ishPapkasi()` dagi bilan bir xil qoida.
  test('sessiya id\'sidagi yo\'l belgilari tashlanadi', () => {
    const { toliq } = sessiyaFayllarPapkasi(vaqtinchalik, '../../qochdim')

    expect(toliq.startsWith(vaqtinchalik)).toBe(true)
    expect(toliq).not.toContain('..')
  })
})

describe('yuklamaNomi', () => {
  test('oddiy nom o\'zgarmaydi', () => {
    expect(yuklamaNomi('hisobot.pdf')).toBe('hisobot.pdf')
    expect(yuklamaNomi('main_test-2.ts')).toBe('main_test-2.ts')
  })

  test('kengaytma saqlanadi va kichik harfga o\'tadi', () => {
    expect(yuklamaNomi('Rasm.PNG')).toBe('Rasm.png')
  })

  test('`../../etc/passwd` — faqat oxirgi bo\'lak qoladi', () => {
    expect(yuklamaNomi('../../etc/passwd')).toBe('passwd')
  })

  test('Windows yo\'li ham kesiladi', () => {
    expect(yuklamaNomi('C:\\Users\\ms\\rasm.png')).toBe('rasm.png')
  })

  test('shell metabelgilari qolmaydi', () => {
    const nom = yuklamaNomi('"; rm -rf ~; #.png')

    expect(nom).not.toBeNull()
    expect(nom).toMatch(/^[a-zA-Z0-9_.-]+$/)
    expect(nom).not.toContain(';')
    expect(nom).not.toContain(' ')
  })

  test('NUL va boshqa nazorat belgilari tashlanadi', () => {
    expect(yuklamaNomi('fayl\u0000.txt')).toBe('fayl.txt')
  })

  test('faqat emoji yoki kirill nomdan null qaytadi', () => {
    expect(yuklamaNomi('🎉🎉')).toBeNull()
    expect(yuklamaNomi('ҳисобот')).toBeNull()
    expect(yuklamaNomi('')).toBeNull()
    expect(yuklamaNomi('...')).toBeNull()
  })

  // Clipboard'dan paste qilingan rasm nomsiz keladi va Bun `File.name` ni
  // `undefined` qilib beradi — bu haqiqiy holat, sinovda topilgan
  test('nom undefined bo\'lsa null qaytadi, yiqilmaydi', () => {
    expect(yuklamaNomi(undefined)).toBeNull()
    expect(yuklamaNomi(null)).toBeNull()
  })

  test('uzun nom kesiladi, kengaytma yo\'qolmaydi', () => {
    const nom = yuklamaNomi(`${'a'.repeat(500)}.pdf`)

    expect(nom).not.toBeNull()
    expect(nom!.endsWith('.pdf')).toBe(true)
    expect(nom!.length).toBeLessThanOrEqual(100)
  })

  // `.env` da nuqta boshida — u kengaytma emas, tananing qismi. Nuqta `-`
  // ga aylanadi, chetdagi chiziqcha esa kesiladi, ya'ni yashirin fayl
  // yuklangach yashirin bo'lib qolmaydi — bu ataylab: foydalanuvchi
  // biriktirgan fayl papkada ko'rinib turishi kerak.
  test('nuqta bilan boshlanadigan nom yashirin qolmaydi', () => {
    expect(yuklamaNomi('.env')).toBe('env')
    expect(yuklamaNomi('.gitignore')).toBe('gitignore')
  })

  test('kengaytmasiz nom qabul qilinadi', () => {
    expect(yuklamaNomi('Makefile')).toBe('Makefile')
  })
})

describe('bandsizNom', () => {
  test('bo\'sh papkada nom o\'zgarmaydi', () => {
    expect(bandsizNom(vaqtinchalik, 'a.png')).toBe('a.png')
  })

  test('band nomga -2 qo\'shiladi, kengaytma joyida qoladi', () => {
    writeFileSync(join(vaqtinchalik, 'a.png'), 'x')

    expect(bandsizNom(vaqtinchalik, 'a.png')).toBe('a-2.png')
  })

  test('ketma-ket nomlar sanaladi', () => {
    writeFileSync(join(vaqtinchalik, 'a.png'), 'x')
    writeFileSync(join(vaqtinchalik, 'a-2.png'), 'x')

    expect(bandsizNom(vaqtinchalik, 'a.png')).toBe('a-3.png')
  })

  test('kengaytmasiz nomga ham qo\'shiladi', () => {
    writeFileSync(join(vaqtinchalik, 'Makefile'), 'x')

    expect(bandsizNom(vaqtinchalik, 'Makefile')).toBe('Makefile-2')
  })
})

describe('rasmTuri', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0])
  const webp = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ])

  test('to\'rt tur tanildi', () => {
    expect(rasmTuri(png)).toBe('image/png')
    expect(rasmTuri(jpeg)).toBe('image/jpeg')
    expect(rasmTuri(gif)).toBe('image/gif')
    expect(rasmTuri(webp)).toBe('image/webp')
  })

  test('JPEG-LS rad etiladi — providerlar qo\'llamaydi', () => {
    expect(rasmTuri(new Uint8Array([0xff, 0xd8, 0xff, 0xf7, 0, 0]))).toBeNull()
  })

  test('RIFF konteyneri WEBP bo\'lmasa rasm emas (WAV)', () => {
    const wav = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ])

    expect(rasmTuri(wav)).toBeNull()
  })

  // Eng muhim holat: kengaytma yolg'on gapiradi
  test('`.png` deb atalgan ZIP — rasm EMAS', () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])

    expect(rasmTuri(zip)).toBeNull()
  })

  test('SVG rasm deb hisoblanmaydi — u oddiy fayl', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">')

    expect(rasmTuri(svg)).toBeNull()
  })

  test('juda qisqa bayt oqimi yiqitmaydi', () => {
    expect(rasmTuri(new Uint8Array([]))).toBeNull()
    expect(rasmTuri(new Uint8Array([0x89, 0x50]))).toBeNull()
    // RIFF bor, lekin 8-11 baytga yetmaydi
    expect(rasmTuri(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0]))).toBeNull()
  })
})

describe('rasmKengaytmasi', () => {
  test('har turga kengaytma bor', () => {
    expect(rasmKengaytmasi('image/png')).toBe('png')
    expect(rasmKengaytmasi('image/jpeg')).toBe('jpg')
    expect(rasmKengaytmasi('image/gif')).toBe('gif')
    expect(rasmKengaytmasi('image/webp')).toBe('webp')
  })
})

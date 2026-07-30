// Biriktirmalarning BAZA qatlami: migratsiya 012, repo funksiyalari va
// `xabarlarOqi()` ga ulanishi. Fayl tizimi va HTTP bu yerda qatnashmaydi.
//
// Diqqat markazi — `message_id` NULL holati. U bu jadvalning eng o'ziga xos
// tomoni: yozuv xabardan OLDIN paydo bo'ladi, ya'ni "hali bog'lanmagan"
// normal holat. Shu sababli testlar aynan shu chegarani bosadi.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { bazaOch, dbOrnat } from '../src/db.ts'
import {
  biriktirmalarniOl,
  biriktirmalarniXabargaBogla,
  biriktirmaOchir,
  biriktirmaOqi,
  biriktirmaYoz,
  sessiyaBiriktirmalari,
  sessiyaOchir,
  sessiyaYarat,
  xabarlarOqi,
  xabarYoz,
  yetimBiriktirmalarniOchir,
} from '../src/repo.ts'

let db: Database

beforeEach(() => {
  db = bazaOch(':memory:')
  dbOrnat(db)
})

afterEach(() => {
  dbOrnat(null)
  db.close()
})

/** Sinov uchun biriktirma — faqat farq qiladigan maydonlar beriladi */
function yoz(
  sessionId: string,
  ozgarish: Partial<Parameters<typeof biriktirmaYoz>[0]> = {},
) {
  return biriktirmaYoz({
    sessionId,
    tur: 'fayl',
    nom: 'a.txt',
    aslNom: 'a.txt',
    yol: '.platforma/sessiyalar/s/fayllar/a.txt',
    mime: 'text/plain',
    hajm: 10,
    ...ozgarish,
  })
}

describe('migratsiya 012', () => {
  test('chat_biriktirmalar jadvali va ustunlari bor', () => {
    const ustunlar = db
      .query<{ name: string; notnull: number }, []>('PRAGMA table_info(chat_biriktirmalar)')
      .all()

    expect(ustunlar.map((u) => u.name)).toEqual([
      'id',
      'session_id',
      'message_id',
      'tur',
      'nom',
      'asl_nom',
      'yol',
      'mime',
      'hajm',
      'created_at',
    ])
  })

  test('message_id NULL bo\'lishi mumkin — yozuv xabardan oldin paydo bo\'ladi', () => {
    const ustun = db
      .query<{ name: string; notnull: number }, []>('PRAGMA table_info(chat_biriktirmalar)')
      .all()
      .find((u) => u.name === 'message_id')

    expect(ustun?.notnull).toBe(0)
  })

  test('indekslar yaratilgan', () => {
    const indekslar = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'chat_biriktirmalar'",
      )
      .all()
      .map((i) => i.name)

    expect(indekslar).toContain('chat_biriktirmalar_message')
    expect(indekslar).toContain('chat_biriktirmalar_session')
  })
})

describe('biriktirmaYoz / biriktirmaOqi', () => {
  test('yozilgan biriktirma o\'qiladi', () => {
    const sessiya = sessiyaYarat('sinov')
    const yozilgan = yoz(sessiya.id, { tur: 'rasm', mime: 'image/png', hajm: 2048 })

    const oqilgan = biriktirmaOqi(yozilgan.id)
    expect(oqilgan).not.toBeNull()
    expect(oqilgan!.tur).toBe('rasm')
    expect(oqilgan!.mime).toBe('image/png')
    expect(oqilgan!.hajm).toBe(2048)
    expect(oqilgan!.sessionId).toBe(sessiya.id)
  })

  test('diskdagi nom tashqi tipda ko\'rinmaydi', () => {
    const sessiya = sessiyaYarat('sinov')
    const yozilgan = yoz(sessiya.id, { nom: 'tozalangan.txt', aslNom: 'asl nom!.txt' })

    expect(yozilgan.aslNom).toBe('asl nom!.txt')
    expect(yozilgan as unknown as Record<string, unknown>).not.toHaveProperty('nom')
  })

  test('yo\'q biriktirma uchun null', () => {
    expect(biriktirmaOqi('yo-q-id')).toBeNull()
  })

  test('messageId bilan darhol bog\'lab yozish mumkin', () => {
    const sessiya = sessiyaYarat('sinov')
    const xabar = xabarYoz({ sessionId: sessiya.id, role: 'user', text: 'salom' })
    yoz(sessiya.id, { messageId: xabar.id })

    const xabarlar = xabarlarOqi(sessiya.id)
    expect(xabarlar[0]?.biriktirmalar).toHaveLength(1)
  })
})

describe('biriktirmalarniOl', () => {
  test('so\'ralgan tartibda qaytadi', () => {
    const sessiya = sessiyaYarat('sinov')
    const bir = yoz(sessiya.id, { aslNom: 'bir.txt' })
    const ikki = yoz(sessiya.id, { aslNom: 'ikki.txt' })

    const teskari = biriktirmalarniOl(sessiya.id, [ikki.id, bir.id])
    expect(teskari.map((b) => b.aslNom)).toEqual(['ikki.txt', 'bir.txt'])
  })

  // XAVFSIZLIK: mijoz `chat.send` da ixtiyoriy id yuborishi mumkin
  test('boshqa sessiyaning biriktirmasi qaytmaydi', () => {
    const bir = sessiyaYarat('bir')
    const ikki = sessiyaYarat('ikki')
    const begona = yoz(ikki.id)

    expect(biriktirmalarniOl(bir.id, [begona.id])).toHaveLength(0)
  })

  test('yo\'q id jimgina tashlanadi — chaqiruvchi sonini tekshiradi', () => {
    const sessiya = sessiyaYarat('sinov')
    const bor = yoz(sessiya.id)

    const natija = biriktirmalarniOl(sessiya.id, [bor.id, 'yo-q'])
    expect(natija).toHaveLength(1)
  })

  test('bo\'sh ro\'yxat bo\'sh natija beradi', () => {
    const sessiya = sessiyaYarat('sinov')
    expect(biriktirmalarniOl(sessiya.id, [])).toEqual([])
  })
})

describe('biriktirmalarniXabargaBogla', () => {
  test('bog\'lanmagan yozuvlar xabarga o\'tadi', () => {
    const sessiya = sessiyaYarat('sinov')
    const bir = yoz(sessiya.id)
    const ikki = yoz(sessiya.id)
    const xabar = xabarYoz({ sessionId: sessiya.id, role: 'user', text: 'salom' })

    const soni = biriktirmalarniXabargaBogla(sessiya.id, xabar.id, [bir.id, ikki.id])

    expect(soni).toBe(2)
    expect(xabarlarOqi(sessiya.id)[0]?.biriktirmalar).toHaveLength(2)
  })

  // Takroriy yuborishdan himoya: fayl bir xabarga tegishli bo'lgach ko'chmaydi
  test('allaqachon bog\'langan yozuv ikkinchi xabarga ko\'chmaydi', () => {
    const sessiya = sessiyaYarat('sinov')
    const biriktirma = yoz(sessiya.id)
    const birinchi = xabarYoz({ sessionId: sessiya.id, role: 'user', text: 'bir' })
    const ikkinchi = xabarYoz({ sessionId: sessiya.id, role: 'user', text: 'ikki' })

    biriktirmalarniXabargaBogla(sessiya.id, birinchi.id, [biriktirma.id])
    const soni = biriktirmalarniXabargaBogla(sessiya.id, ikkinchi.id, [biriktirma.id])

    expect(soni).toBe(0)
    const xabarlar = xabarlarOqi(sessiya.id)
    expect(xabarlar.find((x) => x.id === birinchi.id)?.biriktirmalar).toHaveLength(1)
    expect(xabarlar.find((x) => x.id === ikkinchi.id)?.biriktirmalar).toBeUndefined()
  })

  test('boshqa sessiyaning yozuvi bog\'lanmaydi', () => {
    const bir = sessiyaYarat('bir')
    const ikki = sessiyaYarat('ikki')
    const begona = yoz(ikki.id)
    const xabar = xabarYoz({ sessionId: bir.id, role: 'user', text: 'salom' })

    expect(biriktirmalarniXabargaBogla(bir.id, xabar.id, [begona.id])).toBe(0)
  })
})

describe('xabarlarOqi bilan integratsiya', () => {
  test('message_id NULL — tarixda KO\'RINMAYDI', () => {
    const sessiya = sessiyaYarat('sinov')
    xabarYoz({ sessionId: sessiya.id, role: 'user', text: 'salom' })
    yoz(sessiya.id) // bog'lanmagan

    const xabarlar = xabarlarOqi(sessiya.id)
    expect(xabarlar).toHaveLength(1)
    expect(xabarlar[0]?.biriktirmalar).toBeUndefined()
  })

  // Tool chaqiruvlaridan farq: yetim uchun sun'iy xabar QURILMAYDI
  test('bog\'lanmagan biriktirma sun\'iy xabar yaratmaydi', () => {
    const sessiya = sessiyaYarat('sinov')
    yoz(sessiya.id)

    expect(xabarlarOqi(sessiya.id)).toHaveLength(0)
  })

  test('biriktirmalar yuklash tartibida keladi', () => {
    const sessiya = sessiyaYarat('sinov')
    const xabar = xabarYoz({ sessionId: sessiya.id, role: 'user', text: 'salom' })
    yoz(sessiya.id, { aslNom: 'bir.txt', messageId: xabar.id })
    yoz(sessiya.id, { aslNom: 'ikki.txt', messageId: xabar.id })

    const biriktirmalar = xabarlarOqi(sessiya.id)[0]?.biriktirmalar
    expect(biriktirmalar?.map((b) => b.aslNom)).toEqual(['bir.txt', 'ikki.txt'])
  })

  test('biriktirmasiz suhbat o\'zgarishsiz o\'qiladi', () => {
    const sessiya = sessiyaYarat('sinov')
    xabarYoz({ sessionId: sessiya.id, role: 'user', text: 'salom' })
    xabarYoz({ sessionId: sessiya.id, role: 'assistant', text: 'javob' })

    const xabarlar = xabarlarOqi(sessiya.id)
    expect(xabarlar).toHaveLength(2)
    expect(xabarlar.every((x) => x.biriktirmalar === undefined)).toBe(true)
  })
})

describe('o\'chirish', () => {
  test('biriktirmaOchir yozuvni o\'chiradi', () => {
    const sessiya = sessiyaYarat('sinov')
    const biriktirma = yoz(sessiya.id)

    expect(biriktirmaOchir(biriktirma.id)).toBe(true)
    expect(biriktirmaOqi(biriktirma.id)).toBeNull()
  })

  test('yo\'q yozuvni o\'chirish false qaytaradi', () => {
    expect(biriktirmaOchir('yo-q')).toBe(false)
  })

  test('sessiya o\'chirilsa CASCADE bilan ketadi', () => {
    const sessiya = sessiyaYarat('sinov')
    const biriktirma = yoz(sessiya.id)

    sessiyaOchir(sessiya.id)

    expect(biriktirmaOqi(biriktirma.id)).toBeNull()
  })
})

describe('yetimBiriktirmalarniOchir', () => {
  const eskiVaqt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()

  test('eski va bog\'lanmagan yozuv o\'chiriladi va qaytariladi', () => {
    const sessiya = sessiyaYarat('sinov')
    const yetim = yoz(sessiya.id, { createdAt: eskiVaqt })

    const ochirilgan = yetimBiriktirmalarniOchir(sessiya.id)

    expect(ochirilgan.map((b) => b.id)).toEqual([yetim.id])
    expect(biriktirmaOqi(yetim.id)).toBeNull()
  })

  test('yangi yozuv saqlanadi — foydalanuvchi chipni ko\'rib turgan bo\'lishi mumkin', () => {
    const sessiya = sessiyaYarat('sinov')
    const yangi = yoz(sessiya.id)

    expect(yetimBiriktirmalarniOchir(sessiya.id)).toEqual([])
    expect(biriktirmaOqi(yangi.id)).not.toBeNull()
  })

  test('xabarga bog\'langan eski yozuv saqlanadi', () => {
    const sessiya = sessiyaYarat('sinov')
    const xabar = xabarYoz({ sessionId: sessiya.id, role: 'user', text: 'salom' })
    const bogli = yoz(sessiya.id, { createdAt: eskiVaqt, messageId: xabar.id })

    expect(yetimBiriktirmalarniOchir(sessiya.id)).toEqual([])
    expect(biriktirmaOqi(bogli.id)).not.toBeNull()
  })

  test('boshqa sessiyaning yetimiga tegilmaydi', () => {
    const bir = sessiyaYarat('bir')
    const ikki = sessiyaYarat('ikki')
    const begona = yoz(ikki.id, { createdAt: eskiVaqt })

    expect(yetimBiriktirmalarniOchir(bir.id)).toEqual([])
    expect(biriktirmaOqi(begona.id)).not.toBeNull()
  })
})

describe('sessiyaBiriktirmalari', () => {
  test('bog\'langan va bog\'lanmaganlar birga qaytadi — papkani tozalash uchun', () => {
    const sessiya = sessiyaYarat('sinov')
    const xabar = xabarYoz({ sessionId: sessiya.id, role: 'user', text: 'salom' })
    yoz(sessiya.id, { aslNom: 'bogli.txt', messageId: xabar.id })
    yoz(sessiya.id, { aslNom: 'bosh.txt' })

    expect(sessiyaBiriktirmalari(sessiya.id)).toHaveLength(2)
  })
})

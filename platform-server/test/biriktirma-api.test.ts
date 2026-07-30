// Biriktirma marshrutlari: yuklash (multipart), berish (binary) va o'chirish.
//
// Fayl tizimi vaqtinchalik papkada — `PLATFORMA_ISHLAR` shu yerga qaratiladi,
// ya'ni haqiqiy `~/.platforma/ishlar` ga tegilmaydi.
//
// Diqqat markazida ikki xavfsizlik qoidasi:
//   1) TUR mazmundan aniqlanadi — `.png` deb atalgan ZIP rasm bo'lmasligi
//      kerak, aks holda uning `content-type` i brauzerga ishonib beriladi;
//   2) FAYL hech qachon `inline` berilmaydi — saqlangan XSS yo'li.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatBiriktirma } from '@platforma/shared'
import { app } from '../src/app.ts'
import { bazaOch, dbOrnat } from '../src/db.ts'
import { SESSIYA_PAPKASI } from '../src/ish-papkasi.ts'
import { biriktirmaOqi, sessiyaYarat, xabarlarOqi, xabarYoz } from '../src/repo.ts'
import { biriktirmalarniXabargaBogla } from '../src/repo.ts'

let db: Database
let vaqtinchalik: string
let eskiIshlar: string | undefined

// Haqiqiy signaturalar — `rasmTuri` aynan shularni tekshiradi
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])

beforeEach(() => {
  db = bazaOch(':memory:')
  dbOrnat(db)

  vaqtinchalik = mkdtempSync(join(tmpdir(), 'platforma-biriktirma-api-'))
  eskiIshlar = process.env.PLATFORMA_ISHLAR
  process.env.PLATFORMA_ISHLAR = join(vaqtinchalik, 'ishlar')
})

afterEach(() => {
  dbOrnat(null)
  db.close()

  if (eskiIshlar === undefined) delete process.env.PLATFORMA_ISHLAR
  else process.env.PLATFORMA_ISHLAR = eskiIshlar

  rmSync(vaqtinchalik, { recursive: true, force: true })
})

async function yukla(
  sessionId: string | undefined,
  fayllar: { nom: string; bayt: Uint8Array; tur?: string }[],
): Promise<{ status: number; body: Record<string, unknown> }> {
  const forma = new FormData()
  if (sessionId !== undefined) forma.set('sessionId', sessionId)
  for (const f of fayllar) {
    forma.append('fayl', new File([f.bayt], f.nom, { type: f.tur ?? 'application/octet-stream' }))
  }
  const javob = await app.request('/api/chat/biriktirma', { method: 'POST', body: forma })
  return { status: javob.status, body: (await javob.json()) as Record<string, unknown> }
}

/** Sessiya papkasidagi fayllar ro'yxati */
function papkadagiFayllar(sessionId: string): string[] {
  const yol = join(
    process.env.PLATFORMA_ISHLAR!,
    sessionId,
    SESSIYA_PAPKASI,
    sessionId,
    'fayllar',
  )
  return existsSync(yol) ? readdirSync(yol) : []
}

describe('POST /chat/biriktirma', () => {
  test('PNG yuklanadi — tur "rasm", fayl diskda', async () => {
    const sessiya = sessiyaYarat('sinov')
    const { status, body } = await yukla(sessiya.id, [{ nom: 'rasm.png', bayt: PNG }])

    expect(status).toBe(201)
    const biriktirmalar = body.biriktirmalar as ChatBiriktirma[]
    expect(biriktirmalar).toHaveLength(1)
    expect(biriktirmalar[0]!.tur).toBe('rasm')
    expect(biriktirmalar[0]!.mime).toBe('image/png')
    expect(biriktirmalar[0]!.aslNom).toBe('rasm.png')
    expect(papkadagiFayllar(sessiya.id)).toEqual(['rasm.png'])
  })

  test('ZIP yuklanadi — tur "fayl", mime octet-stream', async () => {
    const sessiya = sessiyaYarat('sinov')
    const { body } = await yukla(sessiya.id, [{ nom: 'arxiv.zip', bayt: ZIP }])

    const biriktirmalar = body.biriktirmalar as ChatBiriktirma[]
    expect(biriktirmalar[0]!.tur).toBe('fayl')
    expect(biriktirmalar[0]!.mime).toBe('application/octet-stream')
  })

  // Eng muhim holat: kengaytma ham, mijoz bergan mime ham yolg'on gapiradi
  test('".png" deb atalgan ZIP — "fayl" bo\'ladi, jimgina rasm bo\'lmaydi', async () => {
    const sessiya = sessiyaYarat('sinov')
    const { body } = await yukla(sessiya.id, [
      { nom: 'aldov.png', bayt: ZIP, tur: 'image/png' },
    ])

    const biriktirmalar = body.biriktirmalar as ChatBiriktirma[]
    expect(biriktirmalar[0]!.tur).toBe('fayl')
    expect(biriktirmalar[0]!.mime).toBe('application/octet-stream')
  })

  test('mijoz bergan "text/html" saqlanmaydi', async () => {
    const sessiya = sessiyaYarat('sinov')
    const { body } = await yukla(sessiya.id, [
      { nom: 'zarar.html', bayt: new TextEncoder().encode('<script>alert(1)</script>'), tur: 'text/html' },
    ])

    expect((body.biriktirmalar as ChatBiriktirma[])[0]!.mime).toBe('application/octet-stream')
  })

  test('bir necha fayl bir so\'rovda', async () => {
    const sessiya = sessiyaYarat('sinov')
    const { body } = await yukla(sessiya.id, [
      { nom: 'a.png', bayt: PNG },
      { nom: 'b.zip', bayt: ZIP },
    ])

    expect(body.biriktirmalar as ChatBiriktirma[]).toHaveLength(2)
    expect(papkadagiFayllar(sessiya.id).sort()).toEqual(['a.png', 'b.zip'])
  })

  test('bir xil nomli ikkinchi fayl -2 bilan saqlanadi', async () => {
    const sessiya = sessiyaYarat('sinov')
    await yukla(sessiya.id, [{ nom: 'a.png', bayt: PNG }])
    await yukla(sessiya.id, [{ nom: 'a.png', bayt: PNG }])

    expect(papkadagiFayllar(sessiya.id).sort()).toEqual(['a-2.png', 'a.png'])
  })

  test('nomi bo\'sh rasm zaxira nom oladi (Windows paste)', async () => {
    const sessiya = sessiyaYarat('sinov')
    const { body } = await yukla(sessiya.id, [{ nom: '', bayt: PNG }])

    const biriktirmalar = body.biriktirmalar as ChatBiriktirma[]
    expect(biriktirmalar[0]!.yol.endsWith('image.png')).toBe(true)
  })

  test('yo\'ldan chiqishga urinish papkada qolmaydi', async () => {
    const sessiya = sessiyaYarat('sinov')
    const { body } = await yukla(sessiya.id, [{ nom: '../../qochdim.png', bayt: PNG }])

    const biriktirmalar = body.biriktirmalar as ChatBiriktirma[]
    expect(biriktirmalar[0]!.yol).not.toContain('..')
    expect(papkadagiFayllar(sessiya.id)).toEqual(['qochdim.png'])
  })

  test('sessionId yo\'q — 400', async () => {
    const { status, body } = await yukla(undefined, [{ nom: 'a.png', bayt: PNG }])

    expect(status).toBe(400)
    expect(body.error).toContain('sessionId')
  })

  test('yo\'q sessiya — 404', async () => {
    const { status } = await yukla('yo-q-sessiya', [{ nom: 'a.png', bayt: PNG }])

    expect(status).toBe(404)
  })

  test('fayl yuborilmasa — 400', async () => {
    const sessiya = sessiyaYarat('sinov')
    const { status, body } = await yukla(sessiya.id, [])

    expect(status).toBe(400)
    expect(body.error).toContain('file')
  })

  test('bo\'sh fayl — 400', async () => {
    const sessiya = sessiyaYarat('sinov')
    const { status } = await yukla(sessiya.id, [{ nom: 'a.txt', bayt: new Uint8Array([]) }])

    expect(status).toBe(400)
  })

  test('multipart bo\'lmagan tana — 400', async () => {
    const javob = await app.request('/api/chat/biriktirma', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'x' }),
    })

    expect(javob.status).toBe(400)
  })

  test('soni chegarasidan oshsa — 400', async () => {
    const sessiya = sessiyaYarat('sinov')
    // Standart chegara 10 ta
    const fayllar = Array.from({ length: 11 }, (_, i) => ({ nom: `a${i}.png`, bayt: PNG }))
    const { status, body } = await yukla(sessiya.id, fayllar)

    expect(status).toBe(400)
    expect(body.error).toContain('limit')
  })
})

describe('GET /chat/biriktirma/:id', () => {
  test('rasm haqiqiy mime va inline bilan keladi', async () => {
    const sessiya = sessiyaYarat('sinov')
    const { body } = await yukla(sessiya.id, [{ nom: 'rasm.png', bayt: PNG }])
    const id = (body.biriktirmalar as ChatBiriktirma[])[0]!.id

    const javob = await app.request(`/api/chat/biriktirma/${id}`)

    expect(javob.status).toBe(200)
    expect(javob.headers.get('content-type')).toBe('image/png')
    expect(javob.headers.get('content-disposition')).toContain('inline')
    expect(javob.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await javob.arrayBuffer())).toEqual(PNG)
  })

  // XSS himoyasi: fayl brauzerda sahifa bo'lib ochilmasligi kerak
  test('fayl octet-stream va attachment bilan keladi', async () => {
    const sessiya = sessiyaYarat('sinov')
    const { body } = await yukla(sessiya.id, [
      { nom: 'zarar.html', bayt: new TextEncoder().encode('<script>alert(1)</script>') },
    ])
    const id = (body.biriktirmalar as ChatBiriktirma[])[0]!.id

    const javob = await app.request(`/api/chat/biriktirma/${id}`)

    expect(javob.headers.get('content-type')).toBe('application/octet-stream')
    expect(javob.headers.get('content-disposition')).toContain('attachment')
  })

  test('yo\'q id — 404', async () => {
    const javob = await app.request('/api/chat/biriktirma/yo-q')

    expect(javob.status).toBe(404)
  })
})

describe('DELETE /chat/biriktirma/:id', () => {
  test('yuborilmagan biriktirma yozuv bilan birga faylni ham o\'chiradi', async () => {
    const sessiya = sessiyaYarat('sinov')
    const { body } = await yukla(sessiya.id, [{ nom: 'a.png', bayt: PNG }])
    const id = (body.biriktirmalar as ChatBiriktirma[])[0]!.id

    const javob = await app.request(`/api/chat/biriktirma/${id}`, { method: 'DELETE' })

    expect(javob.status).toBe(200)
    expect(biriktirmaOqi(id)).toBeNull()
    expect(papkadagiFayllar(sessiya.id)).toEqual([])
  })

  // Tarixni orqaga o'zgartirish yolg'on kontekst yaratardi
  test('xabarga bog\'langan biriktirma o\'chirilmaydi — 409', async () => {
    const sessiya = sessiyaYarat('sinov')
    const { body } = await yukla(sessiya.id, [{ nom: 'a.png', bayt: PNG }])
    const id = (body.biriktirmalar as ChatBiriktirma[])[0]!.id
    const xabar = xabarYoz({ sessionId: sessiya.id, role: 'user', text: 'salom' })
    biriktirmalarniXabargaBogla(sessiya.id, xabar.id, [id])

    const javob = await app.request(`/api/chat/biriktirma/${id}`, { method: 'DELETE' })

    expect(javob.status).toBe(409)
    expect(biriktirmaOqi(id)).not.toBeNull()
    expect(papkadagiFayllar(sessiya.id)).toEqual(['a.png'])
  })

  test('yo\'q id — 404', async () => {
    const javob = await app.request('/api/chat/biriktirma/yo-q', { method: 'DELETE' })

    expect(javob.status).toBe(404)
  })
})

describe('DELETE /chat/sessions/:id — fayllarni tozalash', () => {
  test('sessiya o\'chirilsa yuklama papkasi diskdan ketadi', async () => {
    const sessiya = sessiyaYarat('sinov')
    await yukla(sessiya.id, [{ nom: 'a.png', bayt: PNG }])
    expect(papkadagiFayllar(sessiya.id)).toEqual(['a.png'])

    const javob = await app.request(`/api/chat/sessions/${sessiya.id}`, { method: 'DELETE' })

    expect(javob.status).toBe(200)
    expect(papkadagiFayllar(sessiya.id)).toEqual([])
  })

  test('biriktirmasiz sessiya ham muammosiz o\'chadi', async () => {
    const sessiya = sessiyaYarat('sinov')

    const javob = await app.request(`/api/chat/sessions/${sessiya.id}`, { method: 'DELETE' })

    expect(javob.status).toBe(200)
  })
})

describe('tarixdan tiklash', () => {
  test('bog\'langan biriktirma xabar bilan qaytadi', async () => {
    const sessiya = sessiyaYarat('sinov')
    const { body } = await yukla(sessiya.id, [{ nom: 'a.png', bayt: PNG }])
    const id = (body.biriktirmalar as ChatBiriktirma[])[0]!.id
    const xabar = xabarYoz({ sessionId: sessiya.id, role: 'user', text: 'bu nima?' })
    biriktirmalarniXabargaBogla(sessiya.id, xabar.id, [id])

    const javob = await app.request(`/api/chat/sessions/${sessiya.id}/messages`)
    const tana = (await javob.json()) as { messages: { biriktirmalar?: ChatBiriktirma[] }[] }

    expect(tana.messages[0]?.biriktirmalar).toHaveLength(1)
    expect(tana.messages[0]?.biriktirmalar?.[0]?.aslNom).toBe('a.png')
  })
})

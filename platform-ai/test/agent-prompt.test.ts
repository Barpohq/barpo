// Prompt tanlash — tarix `assistant` bilan tugagan holat.
//
// NEGA BU TEST BOR (haqiqiy poyga holati):
//   1) foydalanuvchi xabar yubordi, javob oqmoqda;
//   2) u "To'xtatish" bosdi va darhol yangi xabar yubordi;
//   3) `streamReply` eski oqimni abort qildi va YANGI user xabarini yozdi;
//   4) abort qilingan eski oqim `finally` da o'z javobini ENDI saqladi —
//      ya'ni yangi user xabaridan KEYIN.
//
// Natijada tarix `user, user, assistant` bo'lib qoladi. Oldin bu holatda
// `xabarlar.at(-1)?.role === 'user'` tekshiruvi yiqilib, agent
// "Yuboriladigan foydalanuvchi xabari topilmadi" xatosini berardi va
// foydalanuvchining xabari JIMGINA yo'qolardi.

import { describe, expect, test } from 'bun:test'
import { attachmentNote, nonTextBlocks, lastUserIndex } from '../src/agent.ts'
import type { MessageAttachment } from '../src/context.ts'
import type { ConversationMessage } from '../src/conversation.ts'

const u = (text: string): ConversationMessage => ({ role: 'user', text })
const a = (text: string): ConversationMessage => ({ role: 'assistant', text })

describe('lastUserIndex', () => {
  test('oddiy holat — oxirgi element user', () => {
    expect(lastUserIndex([u('salom'), a('javob'), u('yana')])).toBe(2)
  })

  test('tarix assistant bilan tugasa ham user topiladi', () => {
    // Aynan poyga holati: bekor qilingan javob user xabaridan keyin saqlandi
    const xabarlar = [
      u('birinchi so\'rov'),
      u('ikkinchi so\'rov'),
      a("⚠︎ Javob to'liq kelmadi: So'rov bekor qilindi"),
    ]
    expect(lastUserIndex(xabarlar)).toBe(1)
    expect(xabarlar[lastUserIndex(xabarlar)]!.text).toBe("ikkinchi so'rov")
  })

  test('ketma-ket bir necha assistant xabaridan keyin ham topiladi', () => {
    expect(lastUserIndex([u('so\'rov'), a('bir'), a('ikki'), a('uch')])).toBe(0)
  })

  test('faqat bitta user xabari', () => {
    expect(lastUserIndex([u('yolg\'iz')])).toBe(0)
  })

  test('user xabari umuman yo\'q — -1', () => {
    expect(lastUserIndex([a('faqat assistant')])).toBe(-1)
    expect(lastUserIndex([])).toBe(-1)
  })

  test('eng OXIRGI user tanlanadi, birinchisi emas', () => {
    const xabarlar = [u('eski'), a('javob'), u('yangi'), a('bekor qilindi')]
    expect(xabarlar[lastUserIndex(xabarlar)]!.text).toBe('yangi')
  })
})

// Biriktirilgan fayl agentga PROMPT MATNI orqali yetadi — base64 bo'lib
// emas. Rasm ham fayl: agent uni `read` bilan o'qiydi va o'shanda ko'radi.
describe('attachmentNote', () => {
  const rasm: MessageAttachment = {
    tur: 'rasm',
    aslNom: 'ekran.png',
    yol: '.platforma/sessiyalar/s1/fayllar/ekran.png',
  }
  const fayl: MessageAttachment = {
    tur: 'fayl',
    aslNom: 'hisobot.pdf',
    yol: '.platforma/sessiyalar/s1/fayllar/hisobot.pdf',
  }

  test('biriktirma bo\'lmasa matn tegilmaydi', () => {
    expect(attachmentNote('salom')).toBe('salom')
    expect(attachmentNote('salom', [])).toBe('salom')
  })

  test('yo\'l promptga tushadi', () => {
    const natija = attachmentNote('bu nima?', [rasm])

    expect(natija).toContain('bu nima?')
    expect(natija).toContain(rasm.yol)
  })

  test('rasm uchun `read` ko\'rsatmasi beriladi', () => {
    const natija = attachmentNote('tasvirla', [rasm])

    expect(natija).toContain('read')
    // Agent rasmni KO'RISHI mumkinligini bilishi kerak, aks holda u faylni
    // matn deb o'ylab "o'qib bo'lmadi" degan xulosaga kelardi
    expect(natija).toContain('image')
  })

  test('bir necha fayl ro\'yxat bo\'lib chiqadi', () => {
    const natija = attachmentNote('ko\'rib chiq', [rasm, fayl])

    expect(natija).toContain(rasm.yol)
    expect(natija).toContain(fayl.yol)
  })

  test('matn bo\'sh bo\'lsa ham eslatma qo\'shiladi', () => {
    // Foydalanuvchi faqat fayl yuborib, hech narsa yozmasligi mumkin
    const natija = attachmentNote('', [fayl])

    expect(natija).toContain(fayl.yol)
  })

  // Fayl mazmuni promptga QO'YILMAYDI — agent `read` bilan o'zi oladi.
  // Aks holda 10 MB log fayli kontekstni bir o'zi to'ldirardi.
  test('fayl mazmuni promptga qo\'yilmaydi — faqat yo\'l', () => {
    const natija = attachmentNote('tekshir', [fayl])

    expect(natija.length).toBeLessThan(500)
  })
})

// `afterToolCall` hook'lardan keyin natijani qayta quradi. Ilgari u
// `content` ni butunlay `[{type:'text'}]` bilan almashtirardi va bu RASMNI
// JIMGINA YO'Q QILARDI: `read` tool'i rasm faylini o'qiganda
// `[{type:'text'}, {type:'image'}]` qaytaradi, hook'lar esa (`lengthHook`,
// `redactSecretsHook`) deyarli har natijadan o'tadi.
//
// Biriktirilgan rasm AYNAN shu yo'ldan keladi, ya'ni bu tuzatishsiz
// "rasm biriktirish" funksiyasi ishlamas edi — xato xabarisiz.
describe('nonTextBlocks', () => {
  const rasmNatijasi = {
    content: [
      { type: 'text', text: 'Read image file [image/png]' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ],
  }

  test('rasm bloki saqlanadi', () => {
    const bloklar = nonTextBlocks(rasmNatijasi)

    expect(bloklar).toHaveLength(1)
    expect((bloklar[0] as { type: string }).type).toBe('image')
  })

  test('matn bloklari olinmaydi — ular hook natijasidan qayta quriladi', () => {
    const bloklar = nonTextBlocks({
      content: [
        { type: 'text', text: 'bir' },
        { type: 'text', text: 'ikki' },
      ],
    })

    expect(bloklar).toEqual([])
  })

  test('bir necha rasm ham saqlanadi', () => {
    const bloklar = nonTextBlocks({
      content: [
        { type: 'text', text: 'x' },
        { type: 'image', data: 'A', mimeType: 'image/png' },
        { type: 'image', data: 'B', mimeType: 'image/jpeg' },
      ],
    })

    expect(bloklar).toHaveLength(2)
  })

  test('noto\'g\'ri shakl yiqitmaydi', () => {
    expect(nonTextBlocks(undefined)).toEqual([])
    expect(nonTextBlocks(null)).toEqual([])
    expect(nonTextBlocks('matn')).toEqual([])
    expect(nonTextBlocks({})).toEqual([])
    expect(nonTextBlocks({ content: 'massiv emas' })).toEqual([])
    expect(nonTextBlocks({ content: [null, undefined] })).toEqual([])
  })

  // Filtr "image" ni ANIQ tanlaydi, "matn emas" deb inkor bilan emas.
  // Sabab: pi kelajakda yangi blok turi qo'shsa (masalan `audio`), u
  // tekshirilmagan holda providerga o'tib ketmasligi kerak.
  test('notanish blok turi o\'tkazilmaydi', () => {
    const bloklar = nonTextBlocks({
      content: [
        { type: 'text', text: 'x' },
        { type: 'kelajakdagi-tur', data: 'nimadir' },
        { type: 'image', data: 'A', mimeType: 'image/png' },
      ],
    })

    expect(bloklar).toHaveLength(1)
    expect(bloklar[0]!.type).toBe('image')
  })
})

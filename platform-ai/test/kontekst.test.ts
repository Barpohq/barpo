// Kontekst qatlami testlari.
//
// Ikki majburiy xulq sinaladi:
//   1) tool natijalari tarixda saqlanadi (usiz agent har turn xotirasini
//      yo'qotadi — bu asosiy funksional nuqson edi);
//   2) kesish HECH QACHON `toolResult` dan boshlanmaydi — aks holda
//      providerga "javobi bor, savoli yo'q" kontekst boradi va so'rov rad
//      etiladi. Bu jimgina buziladigan xato, shuning uchun test bilan
//      majburlanadi.
//
// LLM chaqiruvi (`siq`) bu yerda sinalmaydi — u tarmoqqa chiqadi. Sinaladigan
// qism sof mantiq: qaror, kesish nuqtasi, qisqartirish.

import { describe, expect, test } from 'bun:test'
import type { AgentMessage } from '@earendil-works/pi-agent-core/node'
import {
  eskilarniTashla,
  kesishNuqtasi,
  kontekstniQur,
  kontekstTokenlari,
  siqishKerakmi,
  toolNatijalariniQisqart,
} from '../src/kontekst.ts'

// --- Yordamchi quruvchilar ---

function user(matn: string): AgentMessage {
  return { role: 'user', content: matn, timestamp: 1 } as AgentMessage
}

function assistant(matn: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: matn }],
    api: 'openai-completions',
    provider: 'p',
    model: 'm',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: 1,
  } as AgentMessage
}

function toolNatija(matn: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: 'tc-1',
    toolName: 'read',
    content: [{ type: 'text', text: matn }],
    isError: false,
    timestamp: 1,
  } as unknown as AgentMessage
}

describe('kontekstni qurish', () => {
  test('agentMessages bor xabar xom holda o\'tadi (tool natijalari saqlanadi)', () => {
    // Bu asosiy tuzatish: ilgari tool natijalari yo'qolardi
    const saqlangan = [
      { role: 'user' as const, text: 'faylni o\'qi' },
      {
        role: 'assistant' as const,
        text: 'o\'qidim',
        agentMessages: [assistant('o\'qiyapman'), toolNatija('FAYL MAZMUNI'), assistant('o\'qidim')],
      },
    ]
    const kontekst = kontekstniQur(saqlangan)
    const matnlar = JSON.stringify(kontekst)
    expect(matnlar).toContain('FAYL MAZMUNI')
    expect(kontekst).toHaveLength(4) // 1 user + 3 agent xabari
  })

  test('agentMessages yo\'q bo\'lsa text dan quriladi (eski xabarlar)', () => {
    const kontekst = kontekstniQur([
      { role: 'user', text: 'salom' },
      { role: 'assistant', text: 'salom!' },
    ])
    expect(kontekst).toHaveLength(2)
    expect(kontekst[0]!.role).toBe('user')
    expect(kontekst[1]!.role).toBe('assistant')
  })

  test('eski va yangi xabarlar aralash bo\'lishi mumkin', () => {
    // Migratsiyadan oldingi suhbat davom ettirilsa shunday bo'ladi
    const kontekst = kontekstniQur([
      { role: 'user', text: 'eski savol' },
      { role: 'assistant', text: 'eski javob' },
      { role: 'user', text: 'yangi savol' },
      { role: 'assistant', text: 'yangi javob', agentMessages: [assistant('yangi javob')] },
    ])
    expect(kontekst).toHaveLength(4)
  })

  test('bo\'sh matnli xabar tashlanadi (ba\'zi providerlar rad etadi)', () => {
    const kontekst = kontekstniQur([
      { role: 'user', text: '   ' },
      { role: 'user', text: 'haqiqiy' },
    ])
    expect(kontekst).toHaveLength(1)
  })

  test('bo\'sh ro\'yxat bo\'sh kontekst beradi', () => {
    expect(kontekstniQur([])).toEqual([])
  })
})

describe('tool natijalarini qisqartirish', () => {
  test('chegaradan uzun natija kesiladi va bu AYTILADI', () => {
    const uzun = 'x'.repeat(5000)
    const natija = toolNatijalariniQisqart([toolNatija(uzun)], 1000)
    const matn = (natija[0] as unknown as { content: { text: string }[] }).content[0]!.text
    expect(matn.length).toBeLessThan(2000)
    // Agent natija to'liq emasligini bilishi shart
    expect(matn).toContain('qisqartirildi')
  })

  test('chegaradan qisqa natija tegilmaydi', () => {
    const kirish = [toolNatija('qisqa')]
    const natija = toolNatijalariniQisqart(kirish, 1000)
    expect(natija[0]).toBe(kirish[0]!)
  })

  test('toolResult bo\'lmagan xabarlar tegilmaydi', () => {
    const kirish = [user('a'.repeat(5000)), assistant('b'.repeat(5000))]
    const natija = toolNatijalariniQisqart(kirish, 100)
    expect(natija[0]).toBe(kirish[0]!)
    expect(natija[1]).toBe(kirish[1]!)
  })
})

describe('siqish qarori', () => {
  const sozlama = { yoqilgan: true, zaxiraTokenlar: 1000, saqlanadiganTokenlar: 500 }

  test('o\'chirilgan bo\'lsa hech qachon siqilmaydi', () => {
    const katta = Array.from({ length: 500 }, () => user('x'.repeat(1000)))
    expect(siqishKerakmi(katta, 8000, { ...sozlama, yoqilgan: false })).toBe(false)
  })

  test('kichik kontekst siqilmaydi', () => {
    expect(siqishKerakmi([user('salom')], 100_000, sozlama)).toBe(false)
  })

  test('katta kontekst siqiladi', () => {
    const katta = Array.from({ length: 200 }, () => user('x'.repeat(500)))
    expect(siqishKerakmi(katta, 8000, sozlama)).toBe(true)
  })

  test('contextWindow noma\'lum (0) bo\'lsa siqilmaydi', () => {
    // Taxmin qilib siqishdan ko'ra siqmaslik xavfsizroq: noto'g'ri siqish
    // kontekstni yo'qotadi, siqmaslik esa faqat xato beradi
    const katta = Array.from({ length: 200 }, () => user('x'.repeat(500)))
    expect(siqishKerakmi(katta, 0, sozlama)).toBe(false)
  })

  test('zaxira contextWindow dan katta bo\'lsa siqilmaydi', () => {
    expect(siqishKerakmi([user('a')], 500, { ...sozlama, zaxiraTokenlar: 1000 })).toBe(false)
  })
})

describe('kesish nuqtasi', () => {
  test('yangi xabarlar saqlanadi', () => {
    const xabarlar = Array.from({ length: 100 }, (_, i) => user(`xabar ${i} ${'x'.repeat(400)}`))
    const nuqta = kesishNuqtasi(xabarlar, 1000)
    expect(nuqta).toBeGreaterThan(0)
    expect(nuqta).toBeLessThan(xabarlar.length)
  })

  test('KESISH toolResult DAN BOSHLANMAYDI', () => {
    // Eng muhim qoida: toolResult o'zini chaqirgan assistant xabari bilan
    // birga qolishi shart, aks holda provider so'rovni rad etadi
    const xabarlar: AgentMessage[] = []
    for (let i = 0; i < 50; i += 1) {
      xabarlar.push(assistant(`chaqiruv ${i}`))
      xabarlar.push(toolNatija(`natija ${i} ${'x'.repeat(300)}`))
    }
    for (const saqlanadigan of [200, 500, 1000, 2000, 5000]) {
      const nuqta = kesishNuqtasi(xabarlar, saqlanadigan)
      expect(xabarlar[nuqta]?.role, `saqlanadigan=${saqlanadigan}`).not.toBe('toolResult')
    }
  })

  test('hamma narsa sig\'sa 0 qaytadi', () => {
    expect(kesishNuqtasi([user('kichik')], 1_000_000)).toBe(0)
  })

  test('bo\'sh ro\'yxatda 0', () => {
    expect(kesishNuqtasi([], 1000)).toBe(0)
  })
})

describe('eskilarni tashlash (zaxira yo\'l)', () => {
  test('chegaradan ko\'p bo\'lsa eskilari tashlanadi', () => {
    const xabarlar = Array.from({ length: 100 }, (_, i) => user(`x${i}`))
    const natija = eskilarniTashla(xabarlar, 10)
    expect(natija.length).toBeLessThanOrEqual(10)
    // Eng yangilari qoladi
    expect(JSON.stringify(natija.at(-1))).toContain('x99')
  })

  test('chegaradan kam bo\'lsa tegilmaydi', () => {
    const xabarlar = [user('a'), user('b')]
    expect(eskilarniTashla(xabarlar, 10)).toBe(xabarlar)
  })

  test('natija toolResult dan boshlanmaydi', () => {
    const xabarlar: AgentMessage[] = []
    for (let i = 0; i < 50; i += 1) {
      xabarlar.push(assistant(`c${i}`))
      xabarlar.push(toolNatija(`n${i}`))
    }
    for (const maks of [5, 10, 11, 20, 21]) {
      const natija = eskilarniTashla(xabarlar, maks)
      expect(natija[0]?.role, `maks=${maks}`).not.toBe('toolResult')
    }
  })
})

describe('token hisobi', () => {
  test('bo\'sh kontekst 0 token', () => {
    expect(kontekstTokenlari([])).toBe(0)
  })

  test('kattaroq kontekst ko\'proq token', () => {
    const kichik = [user('salom')]
    const katta = Array.from({ length: 100 }, () => user('x'.repeat(1000)))
    expect(kontekstTokenlari(katta)).toBeGreaterThan(kontekstTokenlari(kichik))
  })
})

// Rasm kontekstga `read` tool'i orqali keladi (biriktirilgan rasm faylini
// o'qiganda). Uning token hajmi base64 UZUNLIGI bo'yicha hisoblanmasligi
// kerak — aks holda 5 MB rasm ~1.7 million "token" bo'lib chiqadi va
// siqish mantiqi butunlay buziladi.
describe('rasmli kontekst', () => {
  /** ~1 MB base64 — haqiqiy rasm hajmi tartibida */
  const KATTA_BASE64 = 'A'.repeat(1_000_000)

  function rasmNatijasi(base64: string): AgentMessage {
    return {
      role: 'toolResult',
      toolCallId: 'tc-rasm',
      toolName: 'read',
      content: [
        { type: 'text', text: 'Read image file [image/png]' },
        { type: 'image', data: base64, mimeType: 'image/png' },
      ],
      isError: false,
      timestamp: 1,
    } as unknown as AgentMessage
  }

  test('rasm base64 uzunligi bo\'yicha sanalmaydi', () => {
    const tokenlar = kontekstTokenlari([rasmNatijasi(KATTA_BASE64)])

    // `JSON.stringify(...).length / 4` bo'lsa ~250 000 chiqardi.
    // pi rasmni fiksirlangan ~1200 token deb hisoblaydi.
    expect(tokenlar).toBeLessThan(5000)
  })

  test('rasm hajmi ikki barobar oshsa token oshmaydi', () => {
    const bir = kontekstTokenlari([rasmNatijasi(KATTA_BASE64)])
    const ikki = kontekstTokenlari([rasmNatijasi(KATTA_BASE64.repeat(2))])

    expect(ikki).toBe(bir)
  })

  // ENG MUHIM REGRESSIYA: `kesishNuqtasi` bitta rasmli xabarni ham
  // `saqlanadiganTokenlar` ga sig'dirmasa, siqishda YAQIN TARIX butunlay
  // xulosaga ketardi va agent hozirgi ishini yo'qotardi.
  test('rasmli xabar kesish nuqtasini buzmaydi', () => {
    const xabarlar = [
      user('eski so\'rov'),
      assistant('eski javob'),
      user('bu rasmda nima?'),
      assistant('o\'qiyman'),
      rasmNatijasi(KATTA_BASE64),
    ]

    const nuqta = kesishNuqtasi(xabarlar, 20_000)

    // Yaqin tarix saqlanishi kerak — hammasi kesilib ketmasin
    expect(nuqta).toBeLessThan(xabarlar.length)
    expect(nuqta).toBe(0)
  })

  test('rasm siqish qarorini o\'z-o\'zidan qo\'zg\'atmaydi', () => {
    const sozlama = { yoqilgan: true, zaxiraTokenlar: 16_384, saqlanadiganTokenlar: 20_000 }

    // 200k context window — bitta rasm uni to'ldirmasligi kerak
    expect(siqishKerakmi([rasmNatijasi(KATTA_BASE64)], 200_000, sozlama)).toBe(false)
  })
})

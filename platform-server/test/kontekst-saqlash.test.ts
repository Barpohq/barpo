// Tool natijalari suhbat davomida saqlanishi — uchdan-uchiga test.
//
// MUAMMO (tuzatilgan): tarix `{role, text}` juftliklaridan iborat edi, ya'ni
// tool natijalari LLM'ga qaytmasdi. Agent har turn xotirasini yo'qotardi:
//
//   1-xabar: "package.json ni o'qi" → agent read qiladi, javob beradi
//   2-xabar: "versiyani ayt"        → agent faylni QAYTA o'qishga majbur
//
// Bu testlar LLM'siz ishlaydi: bazaga yozish → o'qish → kontekst qurish
// zanjiri sinaladi. LLM chaqiruvi bu yerda kerak emas, chunki buzilgan
// joy aynan shu zanjir edi.

import { beforeEach, describe, expect, test } from 'bun:test'
import { kontekstniQur } from '@platforma/ai'
import { bazaOch, dbOrnat } from '../src/db.ts'
import { sessiyaYarat, xabarlarOqi, xabarYoz } from '../src/repo.ts'

beforeEach(() => {
  dbOrnat(bazaOch(':memory:'))
})

/** Tool natijasi bor assistant xabarining `agentMessages` shakli */
function toolliJavob(fayl: string, mazmun: string) {
  return [
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'tc-1', name: 'read', arguments: { path: fayl } }],
      api: 'openai-completions',
      provider: 'p',
      model: 'm',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse',
      timestamp: 1,
    },
    {
      role: 'toolResult',
      toolCallId: 'tc-1',
      toolName: 'read',
      content: [{ type: 'text', text: mazmun }],
      isError: false,
      timestamp: 2,
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: "O'qidim." }],
      api: 'openai-completions',
      provider: 'p',
      model: 'm',
      usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: 3,
    },
  ]
}

describe('tool natijalari bazada saqlanadi', () => {
  test('agentMessages yoziladi va o\'qiladi', () => {
    const s = sessiyaYarat('sinov')
    xabarYoz({ sessionId: s.id, role: 'user', text: "package.json ni o'qi" })
    xabarYoz({
      sessionId: s.id,
      role: 'assistant',
      text: "O'qidim.",
      agentMessages: toolliJavob('package.json', '{"version": "1.2.3"}'),
      contextTokens: 25,
    })

    const xabarlar = xabarlarOqi(s.id)
    expect(xabarlar).toHaveLength(2)

    const javob = xabarlar[1]!
    expect(javob.agentMessages).toHaveLength(3)
    expect(javob.contextTokens).toBe(25)
    // Tool natijasi — eng muhimi
    expect(JSON.stringify(javob.agentMessages)).toContain('1.2.3')
  })

  test('KEYINGI TURN tool natijasini ko\'radi', () => {
    // Bu asosiy tuzatishning uchdan-uchiga tasdig'i
    const s = sessiyaYarat('sinov')
    xabarYoz({ sessionId: s.id, role: 'user', text: "package.json ni o'qi" })
    xabarYoz({
      sessionId: s.id,
      role: 'assistant',
      text: "O'qidim.",
      agentMessages: toolliJavob('package.json', '{"version": "1.2.3"}'),
    })
    xabarYoz({ sessionId: s.id, role: 'user', text: 'versiyani ayt' })

    // Orchestrator shu shaklda tarix quradi
    const tarix = xabarlarOqi(s.id).map((x) => ({
      role: x.role,
      text: x.text,
      agentMessages: x.agentMessages,
    }))
    const kontekst = kontekstniQur(tarix)

    // Fayl mazmuni kontekstda bo'lishi SHART — aks holda agent faylni
    // qayta o'qishga majbur bo'ladi
    expect(JSON.stringify(kontekst)).toContain('1.2.3')
  })

  test('eski xabarlar (agentMessages siz) buzilmaydi', () => {
    // 004-migratsiyadan oldingi suhbatlar ishlashda davom etishi kerak
    const s = sessiyaYarat('eski')
    xabarYoz({ sessionId: s.id, role: 'user', text: 'salom' })
    xabarYoz({ sessionId: s.id, role: 'assistant', text: 'salom!' })

    const xabarlar = xabarlarOqi(s.id)
    expect(xabarlar[0]!.agentMessages).toBeUndefined()
    expect(xabarlar[1]!.agentMessages).toBeUndefined()

    const kontekst = kontekstniQur(
      xabarlar.map((x) => ({ role: x.role, text: x.text, agentMessages: x.agentMessages })),
    )
    expect(kontekst).toHaveLength(2)
  })

  test('eski va yangi xabarlar aralash ishlaydi', () => {
    // Migratsiyadan oldingi suhbat davom ettirilsa shunday bo'ladi
    const s = sessiyaYarat('aralash')
    xabarYoz({ sessionId: s.id, role: 'user', text: 'eski savol' })
    xabarYoz({ sessionId: s.id, role: 'assistant', text: 'eski javob' })
    xabarYoz({ sessionId: s.id, role: 'user', text: 'yangi savol' })
    xabarYoz({
      sessionId: s.id,
      role: 'assistant',
      text: 'yangi javob',
      agentMessages: toolliJavob('a.txt', 'YANGI MAZMUN'),
    })

    const kontekst = kontekstniQur(
      xabarlarOqi(s.id).map((x) => ({ role: x.role, text: x.text, agentMessages: x.agentMessages })),
    )
    const matn = JSON.stringify(kontekst)
    expect(matn).toContain('eski savol')
    expect(matn).toContain('YANGI MAZMUN')
  })
})

describe('buzuq ma\'lumot sessiyani o\'ldirmaydi', () => {
  test('buzuq agent_messages JSON o\'qishni to\'xtatmaydi', () => {
    const s = sessiyaYarat('buzuq')
    const yozilgan = xabarYoz({ sessionId: s.id, role: 'assistant', text: 'javob' })

    // Bazaga qo'lda buzuq JSON yozamiz (masalan yozish yarim uzilgan)
    const db = bazaOch(':memory:')
    dbOrnat(db)
    const s2 = sessiyaYarat('buzuq2')
    xabarYoz({ sessionId: s2.id, role: 'assistant', text: 'javob' })
    db.prepare('UPDATE chat_messages SET agent_messages = ? WHERE session_id = ?').run(
      '{buzuq json,,,',
      s2.id,
    )

    // O'qish xato tashlamasligi kerak — kontekst yo'qoladi, suhbat qoladi
    const xabarlar = xabarlarOqi(s2.id)
    expect(xabarlar).toHaveLength(1)
    expect(xabarlar[0]!.agentMessages).toBeUndefined()
    expect(xabarlar[0]!.text).toBe('javob')
    expect(yozilgan.id).toBeTruthy()
  })

  test('agent_messages massiv bo\'lmasa e\'tiborsiz qoldiriladi', () => {
    const db = bazaOch(':memory:')
    dbOrnat(db)
    const s = sessiyaYarat('obyekt')
    xabarYoz({ sessionId: s.id, role: 'assistant', text: 'javob' })
    db.prepare('UPDATE chat_messages SET agent_messages = ? WHERE session_id = ?').run(
      '{"massiv": "emas"}',
      s.id,
    )
    expect(xabarlarOqi(s.id)[0]!.agentMessages).toBeUndefined()
  })
})

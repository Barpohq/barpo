// Provider xatosi oqimdan tashqariga chiqadimi.
//
// Bu test bitta aniq xatoni qo'riqlaydi: pi-agent-core provider xatosini
// `agent.prompt()` dan TASHLAMAYDI, oxirgi `assistant` xabariga
// `stopReason: 'error'` bo'lib yoziladi. Tekshirmasak oqim muvaffaqiyatli
// hisoblanib, foydalanuvchiga BO'SH javob ko'rinardi va bazaga hech narsa
// yozilmasdi — "chat boshlandi va darhol tugadi" xatosi aynan shundan.
//
// Haqiqiy misollar (foydalanuvchi bazasidan olingan):
//   OpenRouter → 400 "Reasoning is mandatory for this endpoint"
//   Codex      → "Encountered invalidated oauth token for user"

import { describe, expect, test } from 'bun:test'
import { oqimXatosi } from '../src/agent.ts'

describe('oqimXatosi', () => {
  test('muvaffaqiyatli oqimda xato yo\'q', () => {
    expect(
      oqimXatosi([
        { role: 'user', content: [] },
        { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'salom' }] },
      ]),
    ).toBeUndefined()
  })

  test('provider xatosi sabab matni bilan qaytadi', () => {
    const xato = oqimXatosi([
      { role: 'user', content: [] },
      {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: '400: Reasoning is mandatory for this endpoint',
        content: [],
      },
    ])
    expect(xato).toBe('400: Reasoning is mandatory for this endpoint')
  })

  test('sabab matni bo\'lmasa ham xato yo\'qolmaydi', () => {
    expect(oqimXatosi([{ role: 'assistant', stopReason: 'error', content: [] }])).toBe(
      'the provider could not return a response',
    )
    expect(
      oqimXatosi([{ role: 'assistant', stopReason: 'error', errorMessage: '   ', content: [] }]),
    ).toBe('provider javobni qaytara olmadi')
  })

  test('faqat OXIRGI assistant xabari hisobga olinadi', () => {
    // Tool zanjirida oldingi turn xato bo'lib, keyingisi tuzalgan bo'lishi
    // mumkin — u holda javob haqiqatan ham kelgan, xato deb belgilamaymiz.
    expect(
      oqimXatosi([
        { role: 'assistant', stopReason: 'error', errorMessage: 'vaqtincha uzilish', content: [] },
        { role: 'toolResult', content: [] },
        { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'tayyor' }] },
      ]),
    ).toBeUndefined()
  })

  test('bekor qilish (aborted) xato deb hisoblanmaydi', () => {
    // Bekor qilishni chaqiruvchi o'zi biladi (`signal.aborted`) va uni
    // alohida xabar bilan bildiradi — bu yerda takrorlanmasin.
    expect(oqimXatosi([{ role: 'assistant', stopReason: 'aborted', content: [] }])).toBeUndefined()
  })

  test('assistant xabari umuman bo\'lmasa xato yo\'q', () => {
    expect(oqimXatosi([])).toBeUndefined()
    expect(oqimXatosi([{ role: 'user', content: [] }])).toBeUndefined()
  })
})

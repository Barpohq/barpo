// Protokol guard'lari — `chat.status` eventining kanali va sessiya filtri.
//
// Bu testlar ATAYLAB qattiq: `chat.status` ning sessiya bo'yicha
// filtrlanmasligi dizayn qarori, tasodifiy emas. Kimdir uni "unutilgan
// event" deb `eventSessiyasi()` ga qo'shib qo'ysa, sidebar boshqa
// sessiyalarning holatini ko'rmay qoladi va bu jimgina buziladi —
// hech qanday tip xatosi bermaydi.

import { describe, expect, test } from 'bun:test'
import {
  CHANNELS,
  eventKanali,
  eventSessiyasi,
  type OqimHolati,
  type ServerEvent,
} from '@platforma/shared'

function status(sessionId: string, holat: OqimHolati): ServerEvent {
  return { type: 'chat.status', sessionId, holat }
}

describe('chat.status — kanal', () => {
  test('chat kanaliga tegishli', () => {
    expect(eventKanali(status('s1', 'ishlayapti'))).toBe(CHANNELS.chat)
  })

  test('boshqa chat eventlari bilan bir xil kanalda', () => {
    const delta: ServerEvent = { type: 'chat.delta', sessionId: 's1', messageId: 'm', delta: 'x' }
    expect(eventKanali(status('s1', 'tugadi'))).toBe(eventKanali(delta))
  })
})

describe('chat.status — sessiya filtri', () => {
  test('sessiya qaytarmaydi, ya\'ni filtrlanmaydi', () => {
    // DIZAYN QARORI: eventda `sessionId` bor, lekin u filtr uchun emas —
    // sidebar hamma sessiyaning holatini ko'rishi kerak.
    expect(eventSessiyasi(status('s1', 'ishlayapti'))).toBeNull()
  })

  test('hamma holatlar uchun filtrlanmaydi', () => {
    const holatlar: OqimHolati[] = ['ishlayapti', 'ruxsat-kutmoqda', 'tugadi', 'xato']
    for (const h of holatlar) {
      expect(eventSessiyasi(status('s1', h))).toBeNull()
    }
  })

  test('mazmunli chat eventlari esa filtrlanishda davom etadi', () => {
    // Chegara saqlanganini tekshiramiz: status'ning istisnosi qolganlariga
    // yuqmasin — javob matni va ruxsat so'rovi hali ham sessiyaga bog'liq.
    expect(eventSessiyasi({ type: 'chat.delta', sessionId: 's1', messageId: 'm', delta: 'x' })).toBe(
      's1',
    )
    expect(eventSessiyasi({ type: 'chat.done', sessionId: 's1', messageId: 'm' })).toBe('s1')
    expect(
      eventSessiyasi({ type: 'chat.error', sessionId: 's1', messageId: 'm', error: 'e' }),
    ).toBe('s1')
  })
})

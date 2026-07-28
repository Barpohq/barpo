// WS hub testlari — obuna, broadcast filtri va client eventlarni qayta ishlash.

import { describe, expect, test } from 'bun:test'
import type { ClientEvent, ServerEvent } from '@platforma/shared'
import { WsHub, type PlatformaWS } from '../src/ws/hub.ts'

/** Soxta WS ulanishi — yuborilgan eventlarni massivga yig'adi */
function soxtaWs(channels: string[] = [], sessionId?: string) {
  const olingan: ServerEvent[] = []
  const ws = {
    data: { id: `soxta-${Math.random()}`, channels: new Set(channels), sessionId },
    send: (m: string) => olingan.push(JSON.parse(m) as ServerEvent),
  }
  return { ws: ws as unknown as PlatformaWS, olingan }
}

/** Chat eventi — sessiya filtri testlari uchun qisqartma */
function chatDelta(sessionId: string, delta = 'x'): ServerEvent {
  return { type: 'chat.delta', sessionId, messageId: 'm1', delta }
}

describe('WsHub', () => {
  test('ulanishda hello yuboriladi', () => {
    const hub = new WsHub()
    const { ws, olingan } = soxtaWs()
    hub.ulandi(ws)

    expect(hub.soni).toBe(1)
    expect(olingan[0]?.type).toBe('hello')
  })

  test('uzilganda registrdan chiqadi', () => {
    const hub = new WsHub()
    const { ws } = soxtaWs()
    hub.ulandi(ws)
    hub.uzildi(ws)
    expect(hub.soni).toBe(0)
  })

  test('broadcast faqat obuna bo\'lganlarga boradi', () => {
    const hub = new WsHub()
    const obuna = soxtaWs(['audit'])
    const begona = soxtaWs(['chat'])
    hub.ulandi(obuna.ws)
    hub.ulandi(begona.ws)
    obuna.olingan.length = 0
    begona.olingan.length = 0

    const soni = hub.broadcast({
      type: 'audit.entry',
      entry: { time: '10:00', actor: 'test', action: 'a', target: 't', level: "o'qish", result: 'OK' },
    })

    expect(soni).toBe(1)
    expect(obuna.olingan).toHaveLength(1)
    expect(begona.olingan).toHaveLength(0)
  })

  test('sub eventi obunani qo\'shadi va keyingi broadcast keladi', () => {
    const hub = new WsHub()
    const { ws, olingan } = soxtaWs()
    hub.ulandi(ws)
    olingan.length = 0

    // obunasiz — event kelmaydi
    hub.broadcast({ type: 'build.done', buildId: 'b1', appId: 'app1' })
    expect(olingan).toHaveLength(0)

    hub.xabarKeldi(ws, JSON.stringify({ type: 'sub', channels: ['build'] }))
    hub.broadcast({ type: 'build.done', buildId: 'b1', appId: 'app1' })

    expect(olingan).toHaveLength(1)
    expect(olingan[0]).toMatchObject({ type: 'build.done', buildId: 'b1' })
  })

  test('client eventlari handlerga uzatiladi', () => {
    const hub = new WsHub()
    const { ws } = soxtaWs()
    hub.ulandi(ws)

    const olingan: ClientEvent[] = []
    hub.handlerQosh((e) => olingan.push(e))

    hub.xabarKeldi(ws, JSON.stringify({ type: 'chat.send', sessionId: 's1', text: 'salom' }))

    expect(olingan).toHaveLength(1)
    expect(olingan[0]).toMatchObject({ type: 'chat.send', sessionId: 's1', text: 'salom' })
  })

  test("buzuq JSON va noma'lum event turi e'tiborsiz qoldiriladi", () => {
    const hub = new WsHub()
    const { ws } = soxtaWs()
    hub.ulandi(ws)

    const olingan: ClientEvent[] = []
    hub.handlerQosh((e) => olingan.push(e))

    expect(() => hub.xabarKeldi(ws, '{buzuq json')).not.toThrow()
    hub.xabarKeldi(ws, JSON.stringify({ type: 'nomalum.event' }))

    expect(olingan).toHaveLength(0)
  })

  test('handlerQosh qaytargan funksiya obunani bekor qiladi', () => {
    const hub = new WsHub()
    const { ws } = soxtaWs()
    hub.ulandi(ws)

    const olingan: ClientEvent[] = []
    const bekor = hub.handlerQosh((e) => olingan.push(e))

    hub.xabarKeldi(ws, JSON.stringify({ type: 'chat.send', sessionId: 's1', text: 'bir' }))
    bekor()
    hub.xabarKeldi(ws, JSON.stringify({ type: 'chat.send', sessionId: 's1', text: 'ikki' }))

    expect(olingan).toHaveLength(1)
  })
})

describe('sessiya izolyatsiyasi', () => {
  test('chat eventi faqat o\'z sessiyasini kuzatayotgan mijozga boradi', () => {
    // ASOSIY BUG: oldin ikkala oyna ham bir-birining javobini olardi
    const hub = new WsHub()
    const birinchi = soxtaWs(['chat'], 's1')
    const ikkinchi = soxtaWs(['chat'], 's2')
    hub.ulandi(birinchi.ws)
    hub.ulandi(ikkinchi.ws)
    birinchi.olingan.length = 0
    ikkinchi.olingan.length = 0

    const soni = hub.broadcast(chatDelta('s1', 'salom'))

    expect(soni).toBe(1)
    expect(birinchi.olingan).toHaveLength(1)
    expect(ikkinchi.olingan).toHaveLength(0)
  })

  test('ruxsat so\'rovi begona sessiyaga sizmaydi', () => {
    // chat.permission eng nozigi: boshqa oynada tasdiq tugmasi chiqib qolardi
    const hub = new WsHub()
    const egasi = soxtaWs(['chat'], 's1')
    const begona = soxtaWs(['chat'], 's2')
    hub.ulandi(egasi.ws)
    hub.ulandi(begona.ws)
    egasi.olingan.length = 0
    begona.olingan.length = 0

    hub.broadcast({
      type: 'chat.permission',
      sessionId: 's1',
      messageId: 'm1',
      sorov: {
        id: 'r1',
        sessionId: 's1',
        tur: 'buyruq',
        amal: 'bash',
        nishon: 'rm -rf x',
        sabab: 'test',
        naqsh: 'rm',
        vaqt: '2026-01-01T00:00:00.000Z',
      },
    })

    expect(egasi.olingan).toHaveLength(1)
    expect(begona.olingan).toHaveLength(0)
  })

  test('tool va xato eventlari ham filtrlanadi', () => {
    const hub = new WsHub()
    const egasi = soxtaWs(['chat'], 's1')
    const begona = soxtaWs(['chat'], 's2')
    hub.ulandi(egasi.ws)
    hub.ulandi(begona.ws)
    begona.olingan.length = 0

    hub.broadcast({
      type: 'chat.tool',
      sessionId: 's1',
      messageId: 'm1',
      tool: { id: 't1', nom: 'bash', args: 'ls', holat: 'tugadi' },
    })
    hub.broadcast({ type: 'chat.error', sessionId: 's1', messageId: 'm1', error: 'xato' })
    hub.broadcast({ type: 'chat.done', sessionId: 's1', messageId: 'm1' })

    expect(begona.olingan).toHaveLength(0)
  })

  test('sessiya ko\'rsatmagan mijoz hammasini oladi (orqaga moslik)', () => {
    const hub = new WsHub()
    const eski = soxtaWs(['chat']) // sessionId yo'q — eski mijoz
    hub.ulandi(eski.ws)
    eski.olingan.length = 0

    hub.broadcast(chatDelta('s1'))
    hub.broadcast(chatDelta('s2'))

    expect(eski.olingan).toHaveLength(2)
  })

  test('sessiyaga bog\'liq bo\'lmagan eventlar filtrlanmaydi', () => {
    // audit/build/app eventlari sessiyaga tegishli emas — hammaga ketishi kerak
    const hub = new WsHub()
    const mijoz = soxtaWs(['audit', 'build'], 's1')
    hub.ulandi(mijoz.ws)
    mijoz.olingan.length = 0

    hub.broadcast({
      type: 'audit.entry',
      entry: { time: '10:00', actor: 't', action: 'a', target: 't', level: "o'qish", result: 'OK' },
    })
    hub.broadcast({ type: 'build.done', buildId: 'b1', appId: 'app1' })

    expect(mijoz.olingan).toHaveLength(2)
  })

  test('sub eventi sessiyani o\'rnatadi', () => {
    const hub = new WsHub()
    const { ws, olingan } = soxtaWs()
    hub.ulandi(ws)
    olingan.length = 0

    hub.xabarKeldi(ws, JSON.stringify({ type: 'sub', channels: ['chat'], sessionId: 's1' }))

    hub.broadcast(chatDelta('s1'))
    hub.broadcast(chatDelta('s2'))

    expect(olingan).toHaveLength(1)
    expect(olingan[0]).toMatchObject({ sessionId: 's1' })
  })

  test('sessiyasiz sub oldingi tanlovni buzmaydi', () => {
    // Mijoz keyingi `sub` da faqat yangi kanal qo'shayotgan bo'lishi mumkin
    const hub = new WsHub()
    const { ws, olingan } = soxtaWs()
    hub.ulandi(ws)

    hub.xabarKeldi(ws, JSON.stringify({ type: 'sub', channels: ['chat'], sessionId: 's1' }))
    hub.xabarKeldi(ws, JSON.stringify({ type: 'sub', channels: ['audit'] }))
    olingan.length = 0

    hub.broadcast(chatDelta('s2'))
    expect(olingan).toHaveLength(0) // sessiya hali ham s1

    hub.broadcast(chatDelta('s1'))
    expect(olingan).toHaveLength(1)
  })

  test('sessionId: null filtrni olib tashlaydi', () => {
    const hub = new WsHub()
    const { ws, olingan } = soxtaWs()
    hub.ulandi(ws)

    hub.xabarKeldi(ws, JSON.stringify({ type: 'sub', channels: ['chat'], sessionId: 's1' }))
    hub.xabarKeldi(ws, JSON.stringify({ type: 'sub', channels: ['chat'], sessionId: null }))
    olingan.length = 0

    hub.broadcast(chatDelta('s1'))
    hub.broadcast(chatDelta('s2'))

    expect(olingan).toHaveLength(2)
  })

  test('sessiya almashtirilsa yangi sessiya kuzatiladi', () => {
    // "+ yangi suhbat" → boshqa sessiyaga o'tish
    const hub = new WsHub()
    const { ws, olingan } = soxtaWs()
    hub.ulandi(ws)

    hub.xabarKeldi(ws, JSON.stringify({ type: 'sub', channels: ['chat'], sessionId: 's1' }))
    hub.xabarKeldi(ws, JSON.stringify({ type: 'sub', channels: ['chat'], sessionId: 's2' }))
    olingan.length = 0

    hub.broadcast(chatDelta('s1'))
    expect(olingan).toHaveLength(0)

    hub.broadcast(chatDelta('s2'))
    expect(olingan).toHaveLength(1)
  })
})

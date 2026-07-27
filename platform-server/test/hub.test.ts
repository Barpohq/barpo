// WS hub testlari — obuna, broadcast filtri va client eventlarni qayta ishlash.

import { describe, expect, test } from 'bun:test'
import type { ClientEvent, ServerEvent } from '@platforma/shared'
import { WsHub, type PlatformaWS } from '../src/ws/hub.ts'

/** Soxta WS ulanishi — yuborilgan eventlarni massivga yig'adi */
function soxtaWs(channels: string[] = []) {
  const olingan: ServerEvent[] = []
  const ws = {
    data: { id: `soxta-${Math.random()}`, channels: new Set(channels) },
    send: (m: string) => olingan.push(JSON.parse(m) as ServerEvent),
  }
  return { ws: ws as unknown as PlatformaWS, olingan }
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

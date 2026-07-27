// WebSocket hub — ulangan mijozlar registri va event tarqatish.
//
// Har ulanish uchun `UlanishHolati` saqlanadi: obuna bo'lgan kanallar to'plami.
// Mijoz `sub` yuborgunga qadar hech qanday kanalga obuna emas, ya'ni faqat
// kanalsiz eventlarni (`hello`) oladi. Bu ataylab: UI o'ziga kerak kanallarni
// aniq so'raydi, ortiqcha trafik ketmaydi.
//
// Bu modul HTTP qatlamidan mustaqil — `Bun.serve` websocket handlerlari shu
// yerdagi funksiyalarni chaqiradi (src/index.ts da ulanadi).

import type { ServerWebSocket } from 'bun'
import {
  clientEventMi,
  eventKanali,
  PROTOCOL_VERSION,
  type ClientEvent,
  type ServerEvent,
} from '@platforma/shared'

/** Har bir WS ulanishiga biriktiriladigan ma'lumot */
export interface UlanishHolati {
  id: string
  channels: Set<string>
}

export type PlatformaWS = ServerWebSocket<UlanishHolati>

/** Mijozdan kelgan eventni qayta ishlovchi — orchestrator shu yerga ulanadi */
export type ClientEventHandler = (event: ClientEvent, ws: PlatformaWS) => void

export class WsHub {
  private ulanishlar = new Set<PlatformaWS>()
  private handlerlar: ClientEventHandler[] = []

  /** Hozir ulangan mijozlar soni */
  get soni(): number {
    return this.ulanishlar.size
  }

  /**
   * Yangi ulanish ochildi: registrga qo'shiladi va `hello` yuboriladi.
   */
  ulandi(ws: PlatformaWS): void {
    this.ulanishlar.add(ws)
    this.yubor(ws, { type: 'hello', version: PROTOCOL_VERSION })
  }

  /** Ulanish yopildi */
  uzildi(ws: PlatformaWS): void {
    this.ulanishlar.delete(ws)
  }

  /**
   * Mijozdan kelgan xom xabar. `sub` shu yerda qayta ishlanadi, qolgan
   * eventlar ro'yxatdan o'tgan handlerlarga uzatiladi.
   */
  xabarKeldi(ws: PlatformaWS, xom: string): void {
    let qiymat: unknown
    try {
      qiymat = JSON.parse(xom)
    } catch {
      return // buzuq JSON — jimgina tashlab yuboriladi
    }

    if (!clientEventMi(qiymat)) return
    const event = qiymat

    if (event.type === 'sub') {
      for (const kanal of event.channels) ws.data.channels.add(kanal)
      return
    }

    for (const h of this.handlerlar) h(event, ws)
  }

  /**
   * Mijoz eventlari uchun handler qo'shadi (orchestrator `chat.send` va
   * `chat.choice` ni shu orqali oladi). Bekor qiluvchi funksiya qaytaradi.
   */
  handlerQosh(h: ClientEventHandler): () => void {
    this.handlerlar.push(h)
    return () => {
      const i = this.handlerlar.indexOf(h)
      if (i >= 0) this.handlerlar.splice(i, 1)
    }
  }

  /**
   * Eventni tegishli kanalga obuna bo'lgan hamma mijozga yuboradi.
   * Kanalsiz eventlar (hello) hammaga ketadi.
   * Yuborilgan mijozlar sonini qaytaradi.
   */
  broadcast(event: ServerEvent): number {
    const kanal = eventKanali(event)
    const matn = JSON.stringify(event)
    let soni = 0

    for (const ws of this.ulanishlar) {
      if (kanal !== null && !ws.data.channels.has(kanal)) continue
      try {
        ws.send(matn)
        soni++
      } catch {
        // yopilib ulgurgan soket — registrdan chiqariladi
        this.ulanishlar.delete(ws)
      }
    }
    return soni
  }

  /** Bitta mijozga yo'naltirilgan yuborish (kanal filtri qo'llanmaydi) */
  yubor(ws: PlatformaWS, event: ServerEvent): void {
    try {
      ws.send(JSON.stringify(event))
    } catch {
      this.ulanishlar.delete(ws)
    }
  }

  /** Testlar uchun: hamma ulanishni tozalash */
  tozala(): void {
    this.ulanishlar.clear()
    this.handlerlar = []
  }
}

/** Butun jarayon uchun yagona hub */
export const hub = new WsHub()

let _idHisoblagich = 0

/** Yangi ulanish uchun holat obyekti */
export function yangiUlanishHolati(): UlanishHolati {
  _idHisoblagich += 1
  return { id: `ws-${_idHisoblagich}`, channels: new Set<string>() }
}

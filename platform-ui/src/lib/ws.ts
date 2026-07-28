// WebSocket klienti — server eventlarini tinglash uchun yagona ulanish.
//
// Butun ilova bitta soket ishlatadi (sahifalar almashganda uzilmaydi).
// Ulanish uzilsa avtomatik qayta ulanadi va obunalar tiklanadi — server
// obunani eslab qolmaydi, har yangi ulanishda `sub` qayta yuboriladi.
//
// Yangi event turi qo'shilganda bu yerda hech narsa o'zgarmaydi: `kuzat()`
// protokoldagi `ServerEvent` union'ini beradi, chaqiruvchi `type` bo'yicha
// ajratadi.

import type { ClientEvent, ServerEvent } from '@platforma/shared'

type Tinglovchi = (event: ServerEvent) => void

/** Qayta ulanish kechikishlari (ms) — oxirgisi takrorlanadi */
const KECHIKISHLAR = [500, 1000, 2000, 5000, 10000]

class WsKlient {
  private soket: WebSocket | null = null
  private tinglovchilar = new Set<Tinglovchi>()
  private kanallar = new Set<string>()
  private urinish = 0
  private taymer: ReturnType<typeof setTimeout> | null = null
  private yopilgan = false

  ulan(): void {
    if (this.soket || this.yopilgan) return

    const sxema = location.protocol === 'https:' ? 'wss' : 'ws'
    const soket = new WebSocket(`${sxema}://${location.host}/ws`)
    this.soket = soket

    soket.onopen = () => {
      this.urinish = 0
      // Obunalarni tiklaymiz — server eski ulanishning obunasini bilmaydi
      if (this.kanallar.size > 0) {
        this.yubor({ type: 'sub', channels: [...this.kanallar] })
      }
    }

    soket.onmessage = (xabar) => {
      let event: ServerEvent
      try {
        event = JSON.parse(String(xabar.data)) as ServerEvent
      } catch {
        return // buzuq JSON — e'tiborsiz
      }
      for (const t of this.tinglovchilar) {
        try {
          t(event)
        } catch (xato) {
          // Bitta tinglovchining xatosi qolganlarini to'xtatmasin
          console.error('[ws] tinglovchi xatosi', xato)
        }
      }
    }

    soket.onclose = () => {
      this.soket = null
      this.qaytaUlan()
    }

    soket.onerror = () => {
      // onclose baribir chaqiriladi — qayta ulanish o'sha yerda
      soket.close()
    }
  }

  private qaytaUlan(): void {
    if (this.yopilgan || this.taymer) return
    const kechikish = KECHIKISHLAR[Math.min(this.urinish, KECHIKISHLAR.length - 1)]
    this.urinish += 1
    this.taymer = setTimeout(() => {
      this.taymer = null
      this.ulan()
    }, kechikish)
  }

  /** Kanalga obuna bo'ladi. Bekor qiluvchi funksiya qaytaradi. */
  obuna(kanallar: string[]): () => void {
    const yangilar = kanallar.filter((k) => !this.kanallar.has(k))
    for (const k of kanallar) this.kanallar.add(k)
    if (yangilar.length > 0 && this.soket?.readyState === WebSocket.OPEN) {
      this.yubor({ type: 'sub', channels: yangilar })
    }
    return () => {
      for (const k of kanallar) this.kanallar.delete(k)
      // Serverda obunani bekor qilish eventi yo'q — keyingi ulanishda tiklanmaydi
    }
  }

  /** Server eventlarini tinglaydi. Bekor qiluvchi funksiya qaytaradi. */
  kuzat(tinglovchi: Tinglovchi): () => void {
    this.tinglovchilar.add(tinglovchi)
    return () => {
      this.tinglovchilar.delete(tinglovchi)
    }
  }

  yubor(event: ClientEvent): boolean {
    if (this.soket?.readyState !== WebSocket.OPEN) return false
    this.soket.send(JSON.stringify(event))
    return true
  }

  get ulanganmi(): boolean {
    return this.soket?.readyState === WebSocket.OPEN
  }
}

/** Butun ilova uchun yagona klient */
export const ws = new WsKlient()

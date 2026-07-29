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
  /**
   * Hozir kuzatilayotgan chat sessiyasi.
   *
   * Serverga `sub` bilan yuboriladi — shunda u chat eventlarini shu sessiya
   * bo'yicha filtrlaydi va boshqa oynadagi suhbat bu yerga oqib kelmaydi.
   * Qayta ulanishda tiklanishi uchun shu yerda saqlanadi (server obunani
   * eslab qolmaydi).
   */
  private sessionId: string | undefined
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
      // Obunalarni tiklaymiz — server eski ulanishning obunasini bilmaydi.
      // Sessiya ham qayta yuboriladi, aks holda yangi ulanish filtrsiz qolib
      // begona sessiyalarning eventlarini olib kelardi.
      if (this.kanallar.size > 0) {
        this.yubor({ type: 'sub', channels: [...this.kanallar], sessionId: this.sessionId })
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
      this.yubor({ type: 'sub', channels: yangilar, sessionId: this.sessionId })
    }
    return () => {
      for (const k of kanallar) this.kanallar.delete(k)
      // Serverda obunani bekor qilish eventi yo'q — keyingi ulanishda tiklanmaydi
    }
  }

  /**
   * Qaysi chat sessiyasi kuzatilayotganini serverga bildiradi.
   *
   * Sessiya yaratilgach (birinchi xabarda) chaqiriladi. Shundan keyin server
   * bu ulanishga faqat shu sessiyaning chat eventlarini yuboradi.
   *
   * `undefined` berilsa filtr olib tashlanadi — mijoz yana hamma sessiyani
   * ko'radi (masalan "yangi suhbat" bosilib, sessiya hali yaratilmagan payt).
   */
  sessiyaniKuzat(sessionId: string | undefined): void {
    if (this.sessionId === sessionId) return
    this.sessionId = sessionId
    // Kanallar ham qayta yuboriladi — server ularni `add` qiladi, takrorlanishi
    // zarar qilmaydi. Sessiyani tozalash uchun `null` yuboriladi: `undefined`
    // JSON'da maydonni butunlay yo'qotadi, server esa uni "o'zgarishsiz
    // qoldir" deb tushunadi.
    this.yuborYokiKut({
      type: 'sub',
      channels: [...this.kanallar],
      sessionId: sessionId ?? null,
    })
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

  /**
   * Soket ochiq bo'lmasa `onopen` gacha kutadigan yuborish.
   *
   * NEGA KERAK. `sub` — yagona event turi bo'lib, uning YETIB BORMASLIGI
   * jimgina ma'lumot yo'qotadi: server chat eventlarini sessiya bo'yicha
   * filtrlaydi, ya'ni `sub` tushmasa mijoz `chat.permission` ni UMUMAN
   * olmaydi va agent javob kutib turaveradi. Oddiy `yubor()` esa soket
   * ochiq bo'lmasa `false` qaytarib jimgina tashlab yuborardi.
   *
   * Bu poyga haqiqiy: birinchi xabar yuborilayotganda soket hali ulanayotgan
   * yoki qayta ulanayotgan bo'lishi mumkin. `onopen` obunalarni baribir
   * tiklaydi, lekin u paytgacha oraliq bor.
   */
  private yuborYokiKut(event: ClientEvent): void {
    if (this.yubor(event)) return
    this.ulan()
  }

  get ulanganmi(): boolean {
    return this.soket?.readyState === WebSocket.OPEN
  }
}

/** Butun ilova uchun yagona klient */
export const ws = new WsKlient()

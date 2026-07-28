// Fayl orqali saqlanadigan CredentialStore — pi-ai shu interfeys orqali
// providerlarning kalitlari va OAuth tokenlarini o'qiydi/yozadi.
//
// Nega o'z faylimiz? pi-ai OAuth tokenini muddati tugaganda avtomatik
// yangilaydi va natijani `modify` orqali qaytarib yozadi. Agar biz to'g'ridan
// to'g'ri ~/.claude yoki ~/.codex fayliga yozsak, boshqa dasturning holatini
// buzgan bo'lardik. Shuning uchun mahalliy fayllardan faqat O'QIYMIZ
// (mahalliy-auth.ts), yangilangan tokenni esa o'z faylimizga yozamiz.
//
// `modify` — yagona yozish yo'li va u serializatsiya qilinadi: bir vaqtda
// ikkita so'rov kelsa, ikkinchisi birinchisini kutadi. Aks holda ikkalasi ham
// eski refresh_token bilan yangilashga urinib, bittasi bekor qilingan token
// olardi.

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'

/** Fayldagi ko'rinish: provider id → credential */
type Fayl = Record<string, Credential>

export class FaylKredensialOmbori implements CredentialStore {
  private yol: string
  /** Ketma-ket bajarish navbati — modify/delete shu zanjirga ulanadi */
  private navbat: Promise<unknown> = Promise.resolve()

  constructor(yol: string) {
    this.yol = yol
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const fayl = await this.faylniOqi()
    return fayl[providerId]
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const fayl = await this.faylniOqi()
    return Object.entries(fayl).map(([providerId, c]) => ({ providerId, type: c.type }))
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.navbatda(async () => {
      const fayl = await this.faylniOqi()
      const yangi = await fn(fayl[providerId])
      if (yangi === undefined) return fayl[providerId] // o'zgarishsiz qoldirildi
      fayl[providerId] = yangi
      await this.faylniYoz(fayl)
      return yangi
    })
  }

  async delete(providerId: string): Promise<void> {
    await this.navbatda(async () => {
      const fayl = await this.faylniOqi()
      if (!(providerId in fayl)) return
      delete fayl[providerId]
      await this.faylniYoz(fayl)
    })
  }

  /** Amalni navbatga qo'yadi — xato bo'lsa ham zanjir uzilmaydi */
  private navbatda<T>(amal: () => Promise<T>): Promise<T> {
    const natija = this.navbat.then(amal, amal)
    this.navbat = natija.catch(() => undefined)
    return natija
  }

  private async faylniOqi(): Promise<Fayl> {
    try {
      const matn = await Bun.file(this.yol).text()
      const qiymat = JSON.parse(matn) as unknown
      if (typeof qiymat !== 'object' || qiymat === null || Array.isArray(qiymat)) return {}
      return qiymat as Fayl
    } catch {
      // fayl yo'q yoki buzuq — bo'sh ombordan boshlanadi
      return {}
    }
  }

  private async faylniYoz(fayl: Fayl): Promise<void> {
    mkdirSync(dirname(this.yol), { recursive: true })
    await Bun.write(this.yol, JSON.stringify(fayl, null, 2))
    // Kalitlar maxfiy: faqat egasi o'qiy olsin
    try {
      await Bun.$`chmod 600 ${this.yol}`.quiet()
    } catch {
      // chmod ishlamasa (masalan Windows) — kritik emas
    }
  }
}

/** Xotiradagi ombor — testlar uchun */
export class XotiraKredensialOmbori implements CredentialStore {
  private saqlangan = new Map<string, Credential>()
  private navbat: Promise<unknown> = Promise.resolve()

  async read(providerId: string): Promise<Credential | undefined> {
    return this.saqlangan.get(providerId)
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Array.from(this.saqlangan, ([providerId, c]) => ({ providerId, type: c.type }))
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const amal = async () => {
      const yangi = await fn(this.saqlangan.get(providerId))
      if (yangi === undefined) return this.saqlangan.get(providerId)
      this.saqlangan.set(providerId, yangi)
      return yangi
    }
    const natija = this.navbat.then(amal, amal)
    this.navbat = natija.catch(() => undefined)
    return natija
  }

  async delete(providerId: string): Promise<void> {
    this.saqlangan.delete(providerId)
  }
}

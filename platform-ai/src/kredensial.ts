// Fayl orqali saqlanadigan CredentialStore — pi-ai shu interfeys orqali
// providerlarning kalitlari va OAuth tokenlarini o'qiydi/yozadi.
//
// Nega o'z faylimiz? pi-ai OAuth tokenini muddati tugaganda avtomatik
// yangilaydi va natijani `modify` orqali qaytarib yozadi. Holatimizni o'z
// faylimizda saqlaymiz, mahalliy fayllardan esa boshlang'ich tokenni
// o'qiymiz (mahalliy-auth.ts).
//
// AMMO: OpenAI refresh tokenni rotatsiya qiladi — refresh'dan keyin eskisi
// bekor bo'ladi. Agar yangi tokenni faqat o'zimizda saqlasak, ~/.codex dagi
// token o'lib qoladi va terminaldagi `codex` ishlamay qoladi. Shuning uchun
// codex provideri uchun yangilangan tokenni manba fayliga ham qaytaramiz
// (manba-sinxron.ts). Bu ataylab qilingan istisno: ikkala dastur bitta
// obunani baham ko'rgani uchun ikkalasi ham eng so'nggi tokenni bilishi shart.
//
// `modify` — yagona yozish yo'li va u serializatsiya qilinadi: bir vaqtda
// ikkita so'rov kelsa, ikkinchisi birinchisini kutadi. Aks holda ikkalasi ham
// eski refresh_token bilan yangilashga urinib, bittasi bekor qilingan token
// olardi.

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import { codexGaYoz } from './manba-sinxron.ts'

/** Manba fayliga qaytariladigan providerlar */
const CODEX_ID = 'openai-codex'

/** Fayldagi ko'rinish: provider id → credential */
type Fayl = Record<string, Credential>

export class FaylKredensialOmbori implements CredentialStore {
  private yol: string
  /** Ketma-ket bajarish navbati — modify/delete shu zanjirga ulanadi */
  private navbat: Promise<unknown> = Promise.resolve()
  /** Manba fayliga sinxronlashni o'chirish (testlar uchun) */
  private manbagaSinxron: boolean
  /** Uy papkasi — testlarda vaqtinchalik papka beriladi */
  private uy: string | undefined

  constructor(yol: string, sozlama?: { manbagaSinxron?: boolean; uy?: string }) {
    this.yol = yol
    this.manbagaSinxron = sozlama?.manbagaSinxron ?? true
    this.uy = sozlama?.uy
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
      // Manba fayliga ham qaytaramiz — aks holda rotatsiyadan keyin
      // ~/.codex dagi refresh_token o'lik qoladi. Navbat ichida bo'lgani
      // uchun bir vaqtda ikkita yozuv urinmaydi.
      this.manbagaQaytar(providerId, yangi)
      return yangi
    })
  }

  /**
   * Yangilangan tokenni manba dasturning fayliga qaytaradi.
   * Hech qachon xato tashlamaydi — sinxronizatsiya muvaffaqiyatsiz bo'lsa ham
   * bizning omborimizda token saqlangan va platforma ishlayveradi.
   */
  private manbagaQaytar(providerId: string, credential: Credential): void {
    if (!this.manbagaSinxron) return
    if (providerId !== CODEX_ID || credential.type !== 'oauth') return
    try {
      codexGaYoz(credential, this.uy)
    } catch {
      // codexGaYoz o'zi ham xato tashlamaydi, bu qo'shimcha himoya qatlami
    }
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

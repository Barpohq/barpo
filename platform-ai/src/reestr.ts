// Sessiya bo'yicha boshqaruvchilar reestri — TTL va LRU bilan.
//
// MUAMMO. `ruxsat.ts` va `rejim.ts` har sessiya uchun bitta boshqaruvchi
// obyektini `Map` da saqlaydi. `...Yop()` funksiyalari eksport qilingan edi,
// lekin hech qayerdan chaqirilmasdi: har yangi suhbat Map'ga tushib ABADIY
// qolardi. Uzoq ishlaydigan serverda bu xotira sizmasi — sessiyalar soni
// faqat o'sadi, hech qachon kamaymaydi.
//
// NEGA "sessiya o'chirilganda tozalash" YETARLI EMAS.
// Chat sessiyalari SQLite'da doimiy saqlanadi (`chat_sessions` jadvali) va
// UI'da ularni o'chirish imkoni yo'q — foydalanuvchi eski suhbatga bir necha
// kundan keyin qaytishi mumkin. Ya'ni "o'chirildi" degan hodisaning O'ZI yo'q,
// unga ulanib bo'lmaydi.
//
// TANLANGAN YECHIM: TTL (faolsizlik bo'yicha) + LRU (soni bo'yicha chegara).
//
// Bu ikkisi turli xavflarni yopadi:
//   TTL — normal holat. Suhbat tugagach boshqaruvchi ~30 daqiqada o'zi
//         chiqib ketadi, xotira bo'shaydi.
//   LRU — anomaliya. Kimdir qisqa vaqtda juda ko'p sessiya ochsa (skript,
//         yuk testi, bot), TTL ulgurmaydi — chegara qat'iy ushlab turadi.
//
// NEGA BU XAVFSIZ. Boshqaruvchilar faqat SESSIYAGA TEGISHLI VAQTINCHALIK
// holatni saqlaydi:
//   - kutayotgan ruxsat so'rovlari (baribir 5 daqiqada o'zi rad etiladi),
//   - "har doim ruxsat" naqshlari (ruxsat.ts izohida: "sessiya tugasa
//     unutiladi", bazaga yozilmaydi),
//   - blok hisoblagichlari va ruxsat rejimi.
// Bularning hech biri doimiy ma'lumot emas. Boshqaruvchi tozalangach
// keyingi murojaatda YANGISI yaratiladi — foydalanuvchi uchun bu "yangi
// suhbatdagidek" standart holat (tasdiq rejimi, hardoimlar bo'sh).
//
// MUHIM: FAOL sessiya hech qachon tozalanmaydi. `ol()` har murojaatda
// "oxirgi tegilgan vaqt" ni yangilaydi, LRU esa eng eskisidan boshlaydi.
// Javob oqayotgan sessiyaga har tool chaqiruvida murojaat bo'ladi, shuning
// uchun u ro'yxatning boshida turadi.

/** Faolsizlik muddati — shundan keyin boshqaruvchi tozalanadi */
export const REESTR_TTL_MS = 30 * 60 * 1000

/**
 * Bir vaqtda saqlanadigan maksimal boshqaruvchi soni.
 *
 * 500 — mo'l qiymat: bitta odam ishlatadigan platformada bir vaqtda shuncha
 * faol suhbat bo'lmaydi. Chegaraga yetildi degani deyarli har doim
 * anomaliya (skript sessiya yaratmoqda), shuning uchun eng eskisini
 * chiqarib tashlash to'g'ri xulq.
 */
export const REESTR_CHEGARASI = 500

/** Reestrga tushadigan boshqaruvchi shu interfeysni qanoatlantirishi kerak */
export interface Yopiladigan {
  yop(): void
}

interface Yozuv<T> {
  qiymat: T
  /** Oxirgi murojaat vaqti (ms) — TTL va LRU shu bo'yicha hisoblanadi */
  tegilgan: number
}

/**
 * Sessiya bo'yicha boshqaruvchilar reestri.
 *
 * `ruxsat.ts` va `rejim.ts` ikkalasi ham shuni ishlatadi — mantiq bir xil,
 * takrorlanmasin.
 */
export class SessiyaReestri<T extends Yopiladigan> {
  private yozuvlar = new Map<string, Yozuv<T>>()

  constructor(
    private yarat: (sessionId: string) => T,
    private ttlMs: number = REESTR_TTL_MS,
    private chegara: number = REESTR_CHEGARASI,
  ) {}

  /** Hozir saqlanayotgan boshqaruvchilar soni (diagnostika va testlar uchun) */
  get soni(): number {
    return this.yozuvlar.size
  }

  /**
   * Sessiya boshqaruvchisini qaytaradi, kerak bo'lsa yaratadi.
   *
   * Har chaqiruv "oxirgi tegilgan vaqt" ni yangilaydi — shuning uchun faol
   * sessiya tozalanib ketmaydi.
   *
   * `hozir` — vaqtni tashqaridan berish imkoni (testlar soatni kutmasin).
   */
  ol(sessionId: string, hozir: number = Date.now()): T {
    // Avval eskirganlarni chiqaramiz: shunda TTL o'tgan sessiyaga murojaat
    // qilinsa u YANGI boshqaruvchi oladi, eskisining qoldig'ini emas.
    this.eskirganlarniTozala(hozir)

    const mavjud = this.yozuvlar.get(sessionId)
    if (mavjud) {
      mavjud.tegilgan = hozir
      // Map kirish tartibini saqlaydi — LRU uchun elementni oxiriga
      // ko'chiramiz, shunda `keys().next()` har doim eng eskisini beradi.
      this.yozuvlar.delete(sessionId)
      this.yozuvlar.set(sessionId, mavjud)
      return mavjud.qiymat
    }

    const qiymat = this.yarat(sessionId)
    this.yozuvlar.set(sessionId, { qiymat, tegilgan: hozir })
    this.chegaraniQolla()
    return qiymat
  }

  /** Sessiya boshqaruvchisini yopadi va reestrdan chiqaradi */
  yop(sessionId: string): void {
    const yozuv = this.yozuvlar.get(sessionId)
    if (!yozuv) return
    this.yozuvlar.delete(sessionId)
    this.xavfsizYop(yozuv.qiymat)
  }

  /**
   * TTL o'tgan yozuvlarni tozalaydi. Tozalanganlar sonini qaytaradi.
   *
   * `ol()` ichida avtomatik chaqiriladi — alohida taymer kerak emas.
   * Taymersiz yechim ataylab tanlandi: `setInterval` jarayonni ushlab
   * turadi va testlarda ham chalkashlik keltiradi. Reestr faqat murojaat
   * bo'lganda tozalanadi, bu esa yetarli — murojaat bo'lmasa xotira ham
   * o'smaydi.
   */
  eskirganlarniTozala(hozir: number = Date.now()): number {
    let soni = 0
    for (const [id, yozuv] of this.yozuvlar) {
      if (hozir - yozuv.tegilgan < this.ttlMs) continue
      this.yozuvlar.delete(id)
      this.xavfsizYop(yozuv.qiymat)
      soni += 1
    }
    return soni
  }

  /** Hamma boshqaruvchini yopadi (testlar va to'xtash uchun) */
  tozala(): void {
    for (const yozuv of this.yozuvlar.values()) this.xavfsizYop(yozuv.qiymat)
    this.yozuvlar.clear()
  }

  /**
   * Chegaradan oshgan bo'lsa eng eski (eng uzoq tegilmagan) yozuvlarni
   * chiqaradi. Map kirish tartibi LRU tartibiga teng — `ol()` har
   * murojaatda elementni oxiriga ko'chiradi.
   */
  private chegaraniQolla(): void {
    while (this.yozuvlar.size > this.chegara) {
      const engEski = this.yozuvlar.keys().next()
      if (engEski.done) return
      const id = engEski.value
      const yozuv = this.yozuvlar.get(id)
      this.yozuvlar.delete(id)
      if (yozuv) this.xavfsizYop(yozuv.qiymat)
    }
  }

  /**
   * `yop()` xatosi tozalashni to'xtatmasligi kerak — aks holda bitta buzuq
   * boshqaruvchi butun reestrni qulflab qo'yardi.
   */
  private xavfsizYop(qiymat: T): void {
    try {
      qiymat.yop()
    } catch {
      // Yopishdagi xato tozalashni buzmasin
    }
  }
}

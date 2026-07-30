// Ilova boshqaruvi uchun SSH qatlami — AI kodiga beriladigan `ssh` obyekti.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ NEGA ALOHIDA QATLAM. `ssh.ts` — platforma primitivlar (kalit joylash, │
// │ metrika o'qish): ularni PLATFORMA chaqiradi va argumentlarni o'zi     │
// │ yozadi. Bu fayldagi funksiyalarni esa AI KODI chaqiradi va            │
// │ argumentlarga FOYDALANUVCHI KIRISHI (token, konteyner nomi) tushadi.  │
// │                                                                      │
// │ Ya'ni bu — ishonchsiz chaqiruvchi va ishonchsiz ma'lumot uchrashadigan │
// │ joy. Shuning uchun himoya shu yerda to'planadi.                       │
// └──────────────────────────────────────────────────────────────────────┘
//
// INJECTION HIMOYASI — IKKI QATLAM (uchinchisi `manifest-tekshir.ts` dagi
// `naqsh` validatsiyasi):
//
//   1) `buyruq()` FAQAT argv massivi qabul qiladi. Satr berilsa xato
//      tashlaydi. Shell umuman ishtirok etmaydi, ya'ni `;`, `|`, `$(...)`
//      belgilarining ma'nosi yo'q — ular oddiy argument matni bo'lib qoladi.
//
//   2) `envYoz()` qiymatni STDIN orqali uzatadi. Argumentga tushsa token
//      serverdagi `ps` chiqishida va shell tarixida ko'rinardi.
//
// NEGA AI'GA `exec` BERILMAYDI. Jozibali variant: AI'ga to'liq shell berish
// va "o'zi hal qilsin" deyish. Lekin foydalanuvchi kiritgan token o'sha
// shellga tushadi — ya'ni har token kiritish potentsial buyruq bajarish
// bo'lardi. Shuning uchun chegara: AI NIMA qilishni aytadi, QANDAY
// bajarilishini platforma biladi.

import type { BuyruqNatija } from './ssh.ts'
import { boshqarilganConfigYoli, sshBajar } from './ssh.ts'

/** Amal ichidagi bitta SSH chaqiruvining vaqt chegarasi (ms) */
export const ILOVA_BUYRUQ_TIMEOUT_MS = 45_000

/**
 * `.env` fayliga bir marta yozilishi mumkin bo'lgan maksimal hajm.
 *
 * Konfiguratsiya fayli — o'nlab qator. Undan kattasi xato yoki suiiste'mol.
 */
export const ENV_HAJM_CHEGARASI = 64 * 1024

/**
 * AI kodiga beriladigan `ssh` obyekti.
 *
 * Bu — TOR interfeys: platformaning SSH imkoniyatlarining faqat bir qismi.
 * Kengaytirish ONGLI qadam bo'lishi kerak, shuning uchun `ssh.ts` ni butunlay
 * uzatmaymiz.
 */
export interface IlovaSshApi {
  /**
   * Serverda buyruq bajaradi.
   *
   * ┌──────────────────────────────────────────────────────────────────┐
   * │ MUVAFFAQIYATSIZ BO'LSA XATO TASHLAYDI (chiqish kodi ≠ 0).        │
   * │                                                                  │
   * │ Bu butun loyihadagi "xato tashlamaydi" qoidasidan ONGLI          │
   * │ CHEKINISH. Sabab: AI kodi natijani TEKSHIRMAYDI —                │
   * │     await ssh('h').buyruq(['docker','restart','bot'])             │
   * │     return { xabar: 'Bot restart qilindi' }                       │
   * │ shakli tabiiy ko'rinadi va model deyarli har doim shunday         │
   * │ yozadi. Natija qaytarsak, `ssh` yiqilganda ham foydalanuvchi      │
   * │ "Bot restart qilindi" ko'rardi — ya'ni JIMGINA yolg'on.           │
   * │                                                                  │
   * │ Tashlangan xato esa `amalniBajar` da ushlanadi va                 │
   * │ `{ ok: false, xato }` bo'lib qaytadi — foydalanuvchi haqiqatni    │
   * │ ko'radi, platforma yiqilmaydi.                                    │
   * │                                                                  │
   * │ Chiqish kodini O'ZI hal qilmoqchi bo'lgan kod uchun               │
   * │ `buyruqXom()` bor.                                                │
   * └──────────────────────────────────────────────────────────────────┘
   *
   * @param argv Buyruq va argumentlari — MASSIV bo'lishi SHART.
   *             Satr berilsa xato tashlanadi (shell injection oldini olish).
   */
  buyruq(argv: string[]): Promise<BuyruqNatija>
  /**
   * `buyruq` bilan bir xil, lekin chiqish kodi ≠ 0 da XATO TASHLAMAYDI.
   *
   * "Bu konteyner bormi?" kabi tekshiruvlar uchun: `docker inspect` yo'q
   * konteyner uchun 1 qaytaradi va bu XATO emas, JAVOB.
   */
  buyruqXom(argv: string[]): Promise<BuyruqNatija>
  /**
   * `.env` shaklidagi faylga kalitlarni yozadi (mavjudini almashtiradi,
   * yo'g'ini qo'shadi).
   *
   * Qiymatlar stdin orqali boradi — `ps` da ko'rinmaydi.
   */
  envYoz(yol: string, qiymatlar: Record<string, string>): Promise<void>
  /** Faylni o'qiydi. Yo'q bo'lsa `null` (xato tashlamaydi). */
  faylOqi(yol: string): Promise<string | null>
}

/**
 * `.env` kalitini tekshiradi.
 *
 * `manifest-tekshir.ts` allaqachon `SOZLAMA_KALITI_NAQSHI` bilan majburlagan,
 * lekin bu qatlam AI kodidan TO'G'RIDAN chaqiriladi — ya'ni kod manifestdagi
 * kalitlarni emas, o'zi yasagan nomni berishi mumkin. Ikkinchi tekshiruv shu
 * teshikni yopadi.
 */
const ENV_KALITI_NAQSHI = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * `.env` faylini yangi qiymatlar bilan qayta yig'adi.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ NEGA QO'SHIB QO'YMAYMIZ (`>>`).                                    │
 * │                                                                    │
 * │ Qo'shish eng oddiy yechim, lekin eski qiymat FAYLDA QOLADI. Ko'p    │
 * │ `.env` o'quvchilar oxirgi qiymatni oladi, ba'zilari BIRINCHISINI —  │
 * │ ya'ni token yangilangandan keyin bot eskisini ishlatishda davom     │
 * │ etishi mumkin. Bu jimgina buziladigan xato.                        │
 * │                                                                    │
 * │ Shuning uchun fayl QAYTA YIG'ILADI: mavjud kalit joyida             │
 * │ almashtiriladi (tartib va izohlar saqlanadi), yo'g'i oxiriga        │
 * │ qo'shiladi.                                                        │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Izohlar (`#`) va bo'sh qatorlar saqlanadi: fayl odam o'qiydigan
 * konfiguratsiya, uni tozalab tashlash foydalanuvchi ishini yo'qotardi.
 */
export function envQatorlariniYangila(
  mavjud: string,
  qiymatlar: Record<string, string>,
): string {
  const qolgan = new Map(Object.entries(qiymatlar))
  const qatorlar = mavjud.length > 0 ? mavjud.split('\n') : []
  const natija: string[] = []

  for (const qator of qatorlar) {
    const teng = qator.indexOf('=')
    // Izoh yoki `=` siz qator — o'z holicha qoladi
    if (teng <= 0 || qator.trimStart().startsWith('#')) {
      natija.push(qator)
      continue
    }

    const kalit = qator.slice(0, teng).trim()
    if (qolgan.has(kalit)) {
      natija.push(`${kalit}=${envQiymatiniQochir(qolgan.get(kalit)!)}`)
      qolgan.delete(kalit)
    } else {
      natija.push(qator)
    }
  }

  // Oxirgi bo'sh qatorni olib tashlaymiz — yangi kalitlar undan keyin
  // qo'shilsa fayl o'rtasida bo'shliq qolardi.
  while (natija.length > 0 && natija[natija.length - 1]!.trim() === '') natija.pop()

  for (const [kalit, qiymat] of qolgan) {
    natija.push(`${kalit}=${envQiymatiniQochir(qiymat)}`)
  }

  return natija.join('\n') + '\n'
}

/**
 * `.env` qiymatini xavfsiz shaklga keltiradi.
 *
 * `.env` fayllari shell tomonidan `source` qilinishi mumkin, ya'ni qiymat
 * ichidagi `$(...)` yoki backtick BUYRUQ bo'lib bajarilardi. Bir qavatli
 * qo'shtirnoq (`'...'`) ichida shell hech narsani izohlamaydi — bu eng
 * kuchli qochirish.
 *
 * Qiymat ichidagi `'` esa `'\''` ga aylanadi (qo'shtirnoqni yopib, qochirilgan
 * qo'shtirnoq qo'yib, qaytadan ochish) — POSIX'da yagona to'g'ri yo'l.
 */
export function envQiymatiniQochir(qiymat: string): string {
  // Yangi qator qiymatni ikki kalitga bo'lib yuborardi — ular olib tashlanadi.
  const tozalangan = qiymat.replace(/[\r\n]+/g, ' ')

  // Oddiy qiymat (harf, raqam, ba'zi belgilar) — qo'shtirnoq kerak emas,
  // fayl o'qishga qulay qoladi.
  if (/^[A-Za-z0-9_./:@+-]*$/.test(tozalangan)) return tozalangan

  return `'${tozalangan.replace(/'/g, "'\\''")}'`
}

/**
 * Ilova amallari uchun `ssh` obyektini yasaydi.
 *
 * `serverNomi` — boshqariladigan config'dagi host nomi. AI KODI uni
 * o'zgartira olmaydi: obyekt closure'da qulflangan, ya'ni kod boshqa
 * serverga o'tib keta olmaydi.
 */
export function ilovaSshYarat(serverNomi: string): IlovaSshApi {
  /** Ichki: boshqariladigan config bilan ssh chaqiruvi */
  async function ssh(qismlar: string[], stdin?: string): Promise<BuyruqNatija> {
    return sshBajar(
      [
        'ssh',
        '-F', boshqarilganConfigYoli(),
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=8',
        serverNomi,
        ...qismlar,
      ],
      { ...(stdin !== undefined ? { stdin } : {}), timeoutMs: ILOVA_BUYRUQ_TIMEOUT_MS },
    )
  }

  /**
   * argv ni tekshiradi va qochirib SSH ga uzatadi.
   *
   * ┌──────────────────────────────────────────────────────────────────┐
   * │ INJECTION HIMOYASINING BIRINCHI QATLAMI.                         │
   * │                                                                  │
   * │ Satr qabul qilsak, AI `\`docker restart ${nom}\`` yozardi va     │
   * │ foydalanuvchi kiritgan `nom` shellga tushardi. Massiv esa         │
   * │ shellsiz uzatiladi — `;` va `$(...)` oddiy matn bo'lib qoladi.    │
   * └──────────────────────────────────────────────────────────────────┘
   */
  async function xomBajar(argv: string[], nom: string): Promise<BuyruqNatija> {
    if (!Array.isArray(argv)) {
      throw new TypeError(
        `ssh.${nom}() argv MASSIVI kutadi, satr emas — masalan ` +
          "['docker', 'restart', 'bot']. Shell satri ataylab qabul qilinmaydi.",
      )
    }
    if (argv.length === 0) throw new TypeError(`ssh.${nom}(): argv bo'sh`)

    const tozalangan = argv.map((a) => {
      if (typeof a === 'string') return a
      if (typeof a === 'number' || typeof a === 'boolean') return String(a)
      throw new TypeError(`ssh.${nom}(): argument satr bo'lishi kerak, ${typeof a} keldi`)
    })

    // Argumentlar SSH orqali uzoq shellga boradi, ya'ni bir marta
    // qochirish kerak — aks holda bo'shliqli argument ikkiga bo'linardi.
    return ssh(tozalangan.map((a) => envQiymatiniQochir(a)))
  }

  return {
    async buyruq(argv) {
      const n = await xomBajar(argv, 'buyruq')

      // Yiqilgan buyruq XATO bo'lib chiqadi — yuqoridagi interfeys
      // izohiga q. (AI kodi chiqish kodini tekshirmaydi).
      if (n.kod !== 0) {
        const sabab =
          n.stderr.trim().split('\n').filter(Boolean).pop() ??
          n.stdout.trim().split('\n').filter(Boolean).pop() ??
          ''
        throw new Error(
          `Buyruq bajarilmadi (chiqish kodi ${n.kod})` + (sabab ? `: ${sabab}` : ''),
        )
      }

      return n
    },

    async buyruqXom(argv) {
      return xomBajar(argv, 'buyruqXom')
    },

    async faylOqi(yol) {
      const n = await ssh(['cat', '--', envQiymatiniQochir(yol)])
      // Fayl yo'q — bu XATO emas, birinchi sozlashda normal holat.
      if (n.kod !== 0) return null
      return n.stdout
    },

    async envYoz(yol, qiymatlar) {
      for (const kalit of Object.keys(qiymatlar)) {
        // `.env` kalitlari an'anaviy ravishda YUQORI registrda, lekin
        // manifest kaliti kichik harfda (`SOZLAMA_KALITI_NAQSHI`) —
        // aylantirish chaqiruvchi tomonda bo'ladi, bu yerda faqat shakl
        // tekshiriladi.
        if (!ENV_KALITI_NAQSHI.test(kalit)) {
          throw new TypeError(
            `ssh.envYoz(): "${kalit}" yaroqli env kaliti emas ` +
              '(faqat harf, raqam va `_`, harf yoki `_` bilan boshlanadi)',
          )
        }
      }

      const mavjud = (await this.faylOqi(yol)) ?? ''
      const yangi = envQatorlariniYangila(mavjud, qiymatlar)

      if (yangi.length > ENV_HAJM_CHEGARASI) {
        throw new Error(
          `Konfiguratsiya fayli juda katta bo'lib qoldi: ${yangi.length} belgi, ` +
            `chegara ${ENV_HAJM_CHEGARASI}`,
        )
      }

      // ┌──────────────────────────────────────────────────────────────┐
      // │ ATOMIK YOZISH — vaqtinchalik fayl + `mv`.                     │
      // │                                                              │
      // │ To'g'ridan yozganda jarayon yarim yo'lda uzilsa (tarmoq       │
      // │ tushdi, disk to'ldi) fayl YARIM qolardi va bot ko'tarilmasdi. │
      // │ `mv` esa bir fayl tizimida atomik: fayl yo eski, yo yangi.    │
      // │                                                              │
      // │ Huquqlar `.env` uchun 600: unda token turadi.                 │
      // └──────────────────────────────────────────────────────────────┘
      const qochirilganYol = envQiymatiniQochir(yol)
      const vaqtinchalik = envQiymatiniQochir(`${yol}.platforma-yangi`)

      const n = await ssh(
        [
          // `cat > fayl` — qiymatlar STDIN orqali keladi, argv'da ko'rinmaydi
          `umask 177 && cat > ${vaqtinchalik} && `+
            // Egalik va huquqni mavjud fayldan ko'chiramiz: bot boshqa
            // foydalanuvchi ostida ishlashi mumkin va `root:root 600` fayl
            // uni o'qiy olmasdi.
            `{ [ -f ${qochirilganYol} ] && chown --reference=${qochirilganYol} ${vaqtinchalik} 2>/dev/null; true; } && ` +
            `mv -f ${vaqtinchalik} ${qochirilganYol}`,
        ],
        yangi,
      )

      if (n.kod !== 0) {
        // Vaqtinchalik fayl qolib ketmasin
        await ssh([`rm -f ${vaqtinchalik}`]).catch(() => undefined)
        throw new Error(
          n.stderr.trim().split('\n').pop() ?? `Faylni yozib bo'lmadi (chiqish kodi ${n.kod})`,
        )
      }
    },
  }
}

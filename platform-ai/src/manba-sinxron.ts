// Yangilangan OAuth tokenni MANBA fayliga qaytarib yozish (~/.codex/auth.json).
//
// Nega kerak? OpenAI refresh tokenni ROTATSIYA qiladi: `grant_type=refresh_token`
// so'rovi yangi `refresh_token` qaytaradi va eskisini bekor qiladi (pi-ai ning
// `readTokenResponse` funksiyasi yangi refresh'ni majburiy deb talab qiladi).
//
// Agar biz mahalliy fayldan faqat O'QISAK, birinchi refresh'dan keyin
// ~/.codex/auth.json dagi refresh_token o'lik qoladi. Natijada terminalda
// `codex` ishga tushmaydi — foydalanuvchi qayta login qilishga majbur bo'ladi.
// Aynan shu muammo har hafta takrorlanib turgan edi.
//
// Shuning uchun tokenni yangilaganimizda manba fayliga ham qaytaramiz.
// Bu boshqa dasturning faylini o'zgartirish — ehtiyot choralari:
//   1. Faqat `tokens.*` ichidagi ma'lum maydonlar yangilanadi. Qolgan hamma
//      narsa (auth_mode, OPENAI_API_KEY, account_id, kelajakdagi maydonlar)
//      o'z holida qoladi.
//   2. Atomik yozish: vaqtinchalik faylga yozib, keyin rename. Codex yarim
//      yozilgan faylni hech qachon ko'rmaydi.
//   3. Fayl huquqi 600 saqlanadi.
//   4. Fayl yo'q bo'lsa — YARATILMAYDI. Codex o'rnatilmagan bo'lsa aralashmaymiz.
//   5. Hech qachon xato tashlamaydi: sinxronizatsiya muvaffaqiyatsiz bo'lsa
//      ham platformaning o'z ishi davom etaveradi.
//
// Tokenning o'zi hech qayerga loglanmaydi.

import { renameSync, writeFileSync, chmodSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OAuthCredential } from '@earendil-works/pi-ai'

/** Sinxronizatsiya natijasi — diagnostika uchun, sirsiz */
export interface SinxronNatija {
  yozildi: boolean
  /** Yozilmagan bo'lsa — nima uchun */
  sabab?: string
}

/**
 * Codex `auth.json` ni yangi token bilan yangilaydi.
 *
 * `id_token` ataylab tegilmaydi: refresh javobida u qaytmaydi (faqat
 * access_token / refresh_token / expires_in keladi), shuning uchun eskisini
 * saqlab qolamiz. U muddati o'tgan bo'lsa ham zarar qilmaydi — codex uni
 * kerak bo'lganda o'zi yangilaydi.
 */
export function codexGaYoz(credential: OAuthCredential, uy = homedir()): SinxronNatija {
  const yol = join(uy, '.codex', 'auth.json')

  if (!existsSync(yol)) {
    // Codex o'rnatilmagan — bizning ishimiz emas
    return { yozildi: false, sabab: 'fayl topilmadi' }
  }

  let hozirgi: Record<string, unknown>
  try {
    const qiymat = JSON.parse(readFileSync(yol, 'utf8')) as unknown
    if (typeof qiymat !== 'object' || qiymat === null || Array.isArray(qiymat)) {
      return { yozildi: false, sabab: 'kutilmagan shakl' }
    }
    hozirgi = qiymat as Record<string, unknown>
  } catch (xato) {
    return { yozildi: false, sabab: `o'qib bo'lmadi (${xatoQisqa(xato)})` }
  }

  const eskiTokens =
    typeof hozirgi.tokens === 'object' && hozirgi.tokens !== null && !Array.isArray(hozirgi.tokens)
      ? (hozirgi.tokens as Record<string, unknown>)
      : {}

  // Fayldagi token allaqachon o'sha bo'lsa — yozmaymiz. Keraksiz disk yozuvi
  // va codex'ning fayl kuzatuvchisini bezovta qilmaslik uchun.
  if (eskiTokens.access_token === credential.access && eskiTokens.refresh_token === credential.refresh) {
    return { yozildi: false, sabab: "o'zgarish yo'q" }
  }

  const yangi = {
    ...hozirgi,
    tokens: {
      ...eskiTokens,
      access_token: credential.access,
      refresh_token: credential.refresh,
    },
    // Codex bu maydonni ISO satr sifatida saqlaydi
    last_refresh: new Date().toISOString(),
  }

  return atomikYoz(yol, JSON.stringify(yangi, null, 2))
}

/**
 * Faylni atomik almashtiradi: yonidagi vaqtinchalik faylga yozib, rename qiladi.
 * `rename` bir xil fayl tizimida atomik — o'quvchi yo eski, yo yangi faylni
 * ko'radi, hech qachon yarmini emas.
 */
function atomikYoz(yol: string, mazmun: string): SinxronNatija {
  // Vaqtinchalik fayl AYNAN shu papkada bo'lishi shart — /tmp boshqa fayl
  // tizimida bo'lsa rename atomik bo'lmaydi (EXDEV bilan yiqiladi)
  const vaqtinchalik = `${yol}.${process.pid}.tmp`
  try {
    // Huquqni yozishdan OLDIN o'rnatamiz — token hech qachon, hatto bir lahza
    // ham, boshqalarga o'qiladigan faylda turmasin
    writeFileSync(vaqtinchalik, mazmun, { mode: 0o600 })
    chmodSync(vaqtinchalik, 0o600)
    renameSync(vaqtinchalik, yol)
    return { yozildi: true }
  } catch (xato) {
    try {
      unlinkSync(vaqtinchalik)
    } catch {
      // tozalab bo'lmadi — kritik emas
    }
    return { yozildi: false, sabab: `yozib bo'lmadi (${xatoQisqa(xato)})` }
  }
}

function xatoQisqa(xato: unknown): string {
  return (xato instanceof Error ? xato.message : String(xato)).slice(0, 80)
}

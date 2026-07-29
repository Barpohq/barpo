// PC'dagi boshqa dasturlarning OAuth tokenlarini O'QISH (yozish emas).
//
// Claude Code `~/.claude/.credentials.json` da, Codex CLI `~/.codex/auth.json`
// da subscription tokenini saqlaydi. pi-ai bu fayllarni bilmaydi — biz o'qib,
// uning CredentialStore'iga `{type:'oauth', access, refresh, expires}` shaklida
// beramiz, keyin pi-ai tokenni o'zi yangilab turadi.
//
// MUHIM: bu fayllar boshqa dasturlarniki va ularning formati kelishilmagan —
// istalgan versiyada o'zgarishi mumkin. Shuning uchun bu modul HECH QACHON
// xato tashlamaydi: kutilmagan shakl ko'rsa `undefined` qaytaradi va sabab
// `sabab` maydonida qaytadi. Provider oddiygina ro'yxatda ko'rinmaydi, qolgan
// hamma narsa ishlayveradi.
//
// Tokenning o'zi hech qayerga loglanmaydi.

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OAuthCredential } from '@earendil-works/pi-ai'

export interface MahalliyTopilma {
  /** pi-ai provider id: 'anthropic' yoki 'openai-codex' */
  providerId: string
  /** Foydalanuvchiga ko'rsatiladigan manba nomi */
  manba: string
  credential: OAuthCredential
}

export interface MahalliyNatija {
  topilma?: MahalliyTopilma
  /** Topilmasa — nima uchun (log va diagnostika uchun, sirsiz) */
  sabab?: string
}

/** Ixtiyoriy chuqurlikdagi obyektdan birinchi mos OAuth uchlikni izlaydi */
function tokenIzla(qiymat: unknown, chuqurlik = 0): OAuthCredential | undefined {
  if (chuqurlik > 3 || typeof qiymat !== 'object' || qiymat === null) return undefined
  const o = qiymat as Record<string, unknown>

  // Turli dasturlar turlicha nomlaydi — barcha ma'lum variantlarni sinaymiz
  const access = birinchiSatr(o, ['accessToken', 'access_token', 'access'])
  const refresh = birinchiSatr(o, ['refreshToken', 'refresh_token', 'refresh'])
  const muddat = birinchiRaqam(o, ['expiresAt', 'expires_at', 'expires', 'expiresIn', 'expires_in'])

  if (access && refresh) {
    // Codex `~/.codex/auth.json` da muddatni alohida maydonda saqlamaydi —
    // u faqat JWT ichida (`exp`) turadi. Ochiq maydon bo'lsa u ustun, bo'lmasa
    // access_token'ni ochib ko'ramiz. Aks holda muddat 0 bo'lib qolar edi va
    // pi-ai hali 10 kun yaroqli tokenni har ishga tushishda yangilardi —
    // OpenAI esa refresh'da tokenni rotatsiya qilib, eskisini bekor qiladi.
    const expires = muddat !== undefined ? muddatniNormalla(muddat) : jwtMuddati(access)

    return { type: 'oauth', access, refresh, expires }
  }

  // Yuqori qavatda topilmadi — ichki obyektlarni ko'ramiz
  // (masalan {"claudeAiOauth": {...}} yoki {"tokens": {...}})
  for (const ichki of Object.values(o)) {
    const topildi = tokenIzla(ichki, chuqurlik + 1)
    if (topildi) return topildi
  }
  return undefined
}

function birinchiSatr(o: Record<string, unknown>, kalitlar: string[]): string | undefined {
  for (const k of kalitlar) {
    const v = o[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

function birinchiRaqam(o: Record<string, unknown>, kalitlar: string[]): number | undefined {
  for (const k of kalitlar) {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
      // ISO sana ham bo'lishi mumkin
      const sana = Date.parse(v)
      if (!Number.isNaN(sana)) return sana
    }
  }
  return undefined
}

/**
 * JWT payload'idagi `exp` da'vosini millisekundli absolut vaqt sifatida
 * qaytaradi. Token JWT bo'lmasa yoki `exp` topilmasa — 0 (muddati noma'lum,
 * pi-ai yangilaydi).
 *
 * Imzo TEKSHIRILMAYDI: bu token bizga tegishli emas va biz uni faqat o'z
 * serverimizga uzatamiz. Bizga kerakli yagona narsa — qachon yangilash kerak
 * degan maslahat. Imzo yaroqsiz bo'lsa ham buni OpenAI o'zi rad etadi.
 */
function jwtMuddati(token: string): number {
  const qismlar = token.split('.')
  if (qismlar.length !== 3) return 0
  try {
    const payload = qismlar[1] ?? ''
    // JWT base64url ishlatadi; atob standart base64 kutadi
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const toldirilgan = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
    const dava = JSON.parse(atob(toldirilgan)) as unknown
    if (typeof dava !== 'object' || dava === null) return 0
    const exp = (dava as Record<string, unknown>).exp
    // `exp` — RFC 7519 bo'yicha doim sekundli Unix vaqti
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return 0
    return exp * 1000
  } catch {
    // Buzuq base64 yoki JSON — muddat noma'lum
    return 0
  }
}

/**
 * Muddatni millisekundli absolut vaqtga keltiradi.
 * Turli formatlar uchraydi: absolut ms, absolut sekund, yoki qolgan sekundlar.
 */
function muddatniNormalla(qiymat: number | undefined): number {
  if (qiymat === undefined) return 0

  const hozir = Date.now()
  // 10^12 dan katta — millisekundli absolut vaqt
  if (qiymat > 1e12) return qiymat
  // 10^9 dan katta — sekundli absolut vaqt (2001-yildan keyin)
  if (qiymat > 1e9) return qiymat * 1000
  // Kichik son — "necha sekunddan keyin tugaydi"; boshlanish vaqti noma'lum,
  // shuning uchun allaqachon tugagan deb hisoblaymiz (pi-ai yangilaydi)
  if (qiymat > 0) return hozir + qiymat * 1000
  return 0
}

async function jsonOqi(yol: string): Promise<{ qiymat?: unknown; sabab?: string }> {
  try {
    const fayl = Bun.file(yol)
    if (!(await fayl.exists())) return { sabab: 'fayl topilmadi' }
    return { qiymat: JSON.parse(await fayl.text()) as unknown }
  } catch (xato) {
    const xabar = xato instanceof Error ? xato.message : String(xato)
    // Faylning o'zi maxfiy — faqat xato turini qaytaramiz, mazmunini emas
    return { sabab: `o'qib bo'lmadi (${xabar.slice(0, 80)})` }
  }
}

/** Claude Code (Claude Pro/Max obunasi) tokenini o'qiydi */
export async function claudeCodeAuth(uy = homedir()): Promise<MahalliyNatija> {
  const yol = join(uy, '.claude', '.credentials.json')
  const { qiymat, sabab } = await jsonOqi(yol)
  if (sabab) return { sabab: `~/.claude/.credentials.json — ${sabab}` }

  const credential = tokenIzla(qiymat)
  if (!credential) return { sabab: "~/.claude/.credentials.json — OAuth token shakli tanilmadi" }

  return {
    topilma: { providerId: 'anthropic', manba: '~/.claude (Claude obunasi)', credential },
  }
}

/** Codex CLI (ChatGPT Plus/Pro obunasi) tokenini o'qiydi */
export async function codexAuth(uy = homedir()): Promise<MahalliyNatija> {
  const yol = join(uy, '.codex', 'auth.json')
  const { qiymat, sabab } = await jsonOqi(yol)
  if (sabab) return { sabab: `~/.codex/auth.json — ${sabab}` }

  const credential = tokenIzla(qiymat)
  if (!credential) return { sabab: "~/.codex/auth.json — OAuth token shakli tanilmadi" }

  return {
    topilma: { providerId: 'openai-codex', manba: '~/.codex (ChatGPT obunasi)', credential },
  }
}

/** Ikkala manbani ham tekshiradi */
export async function mahalliyAuthlar(uy = homedir()): Promise<MahalliyNatija[]> {
  return Promise.all([claudeCodeAuth(uy), codexAuth(uy)])
}

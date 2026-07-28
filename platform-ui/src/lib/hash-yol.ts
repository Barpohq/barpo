// URL hash ↔ ilova holati.
//
// Hash formatlari:
//   (bo'sh)               — oddiy rejim, yangi suhbat
//   #chat/<uuid>          — oddiy rejim, ochiq suhbat
//   #pro/chat             — pro rejim, chat sahifasi
//   #pro/chat/<uuid>      — pro rejim, ochiq suhbat
//   #pro/servers          — pro rejim, boshqa sahifa
//   #pro/app:<id>         — pro rejim, o'rnatilgan ilova
//
// Sessiya id oxirgi bo'lakda turadi va FAQAT UUID shakli qabul qilinadi —
// aks holda "chat/xyz" kabi tasodifiy matn sessiya deb talqin qilinardi va
// UI mavjud bo'lmagan suhbatni yuklashga urinardi.
//
// Sof funksiyalar (DOM'ga tegmaydi) — shuning uchun test qilinadi.

/** UUID v4 — `crypto.randomUUID()` shu shaklda id beradi */
const UUID_SHAKLI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function uuidmi(qiymat: string): boolean {
  return UUID_SHAKLI.test(qiymat)
}

export interface HashHolati {
  pro: boolean
  /** Sahifa yo'li: 'chat', 'servers', 'app:xyz' ... */
  yol: string
  sessionId: string | null
}

/** Hash satrini holatga aylantiradi. Kirish '#' bilan ham, usiz ham bo'ladi. */
export function hashTahlil(xom: string): HashHolati {
  const boklar = xom.replace(/^#/, '').split('/').filter(Boolean)
  const pro = boklar[0] === 'pro'
  const qolgan = pro ? boklar.slice(1) : boklar

  const oxirgi = qolgan[qolgan.length - 1]
  const sessionId = oxirgi && uuidmi(oxirgi) ? oxirgi : null
  const yol = (sessionId ? qolgan.slice(0, -1) : qolgan).join('/')

  return { pro, yol, sessionId }
}

/**
 * Holatdan hash satrini quradi (# belgisisiz).
 *
 * Sessiya id faqat chat sahifasida qo'shiladi: boshqa sahifada u ma'nosiz
 * va URL'ni chalkashtirardi.
 */
export function hashQur(pro: boolean, yol: string, sessionId: string | null): string {
  const boklar: string[] = []
  if (pro) boklar.push('pro')

  const sessiyaBor = Boolean(sessionId) && yol === 'chat'
  // Oddiy rejimda 'chat' so'zi ortiqcha (boshqa sahifa yo'q) — LEKIN sessiya
  // bo'lsa yoziladi, aks holda URL '#<uuid>' ko'rinishida chalkash bo'lardi
  if (pro || yol !== 'chat' || sessiyaBor) boklar.push(yol)
  if (sessiyaBor) boklar.push(sessionId as string)

  return boklar.filter(Boolean).join('/')
}

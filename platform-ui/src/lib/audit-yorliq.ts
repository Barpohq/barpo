// Audit daraja va natija qiymatlarining ko'rinadigan yorliqlari.
//
// QIYMATLAR BAZADAN KELADI va o'zbekcha: `migrations/001-boshlangich.ts`
// dagi `CHECK (level IN ('o''qish', 'o''zgartirish', 'xavfli'))` ularni
// qulflab turadi, `seed.ts` esa `result` ustuniga xuddi shunday yozadi.
// UI ingliz tiliga o'tganda qiymatni almashtirish migratsiya talab qilardi
// va eski yozuvlar mos kelmay qolardi — shuning uchun tarjima FAQAT
// ko'rsatish paytida, shu xaritalar orqali bo'ladi.
//
// `ui.tsx` da emas, alohida faylda: u fayl faqat komponent eksport qilishi
// kerak (Vite fast refresh).

import type { AuditLevel } from '@platforma/shared'

export const LEVEL_LABEL: Record<AuditLevel, string> = {
  "o'qish": 'read',
  "o'zgartirish": 'write',
  xavfli: 'dangerous',
}

/**
 * `result` ustuni erkin matn — bazada boshqa qiymat ham uchrashi mumkin,
 * shuning uchun chaqiruvchi topilmaganda xom qiymatga qaytadi.
 */
export const RESULT_LABEL: Record<string, string> = {
  OK: 'OK',
  tasdiqlandi: 'approved',
  'rad etildi': 'denied',
  kutmoqda: 'pending',
}

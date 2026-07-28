import type { Migratsiya } from './index.ts'

// Chat sessiyasiga tanlangan provider va model qo'shiladi.
//
// Nega sessiyaga bog'lanadi? Suhbat o'rtasida providerni almashtirish
// kontekstni buzadi — har provider xabar tarixini o'z formatida saqlaydi
// (thinking bloklari, tool chaqiruv id'lari, imzo maydonlari). Shuning uchun
// provider bir marta, birinchi xabarda qulflanadi.
//
// Ikkalasi ham NULL bo'lishi mumkin: sessiya yaratildi, lekin hali birorta
// xabar yuborilmadi.

export const migratsiya: Migratsiya = {
  raqam: 2,
  nom: 'chat-sessiya-model',
  sql: `
    ALTER TABLE chat_sessions ADD COLUMN provider TEXT;
    ALTER TABLE chat_sessions ADD COLUMN model    TEXT;
  `,
}

import type { Migration } from './index.ts'

// Chat sessiyasiga tanlangan provider va model qo'shiladi.
//
// Nega sessiyaga bog'lanadi? Suhbat o'rtasida providerni almashtirish
// kontekstni buzadi — har provider xabar tarixini o'z formatida saqlaydi
// (thinking bloklari, tool chaqiruv id'lari, imzo maydonlari). Shuning uchun
// provider bir marta, birinchi xabarda qulflanadi.
//
// Ikkalasi ham NULL bo'lishi mumkin: sessiya yaratildi, lekin hali birorta
// xabar yuborilmadi.

export const migration: Migration = {
  number: 2,
  name: 'chat-sessiya-model',
  sql: `
    ALTER TABLE chat_sessions ADD COLUMN provider TEXT;
    ALTER TABLE chat_sessions ADD COLUMN model    TEXT;
  `,
}

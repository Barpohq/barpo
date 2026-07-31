import type { Migration } from './index.ts'

// Agent tool chaqiruvlari xabar bilan birga saqlanadi.
//
// Nega alohida ustun? Mavjud `tool_card` bitta kartani saqlaydi (eski demo
// oqimi). Agent bitta javobda bir necha tool ishlatishi mumkin — read, keyin
// edit, keyin bash. Ularning tartibi va holati muhim, shuning uchun JSON
// massiv sifatida yoziladi.
//
// `tool_card` tegilmaydi — eski xabarlar buzilmasin.

export const migration: Migration = {
  number: 3,
  name: 'chat-tool-cards',
  sql: `
    ALTER TABLE chat_messages ADD COLUMN tool_cards TEXT;
  `,
}

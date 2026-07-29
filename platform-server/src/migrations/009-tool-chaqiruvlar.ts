import type { Migratsiya } from './index.ts'

// Tool chaqiruvlari — ALOHIDA jadval, xabar ichidagi JSON emas.
//
// NEGA KERAK. Ilgari tool chaqiruvlari faqat `chat_messages.tool_cards`
// ustunida, javob OQIMI TUGAGACH, bir marta yozilardi. Oraliqda ular faqat
// WS orqali UI'ga ketardi. Natijada:
//   - oqim uzilsa (provider xatosi, server qayta ishga tushsa, bo'sh javob)
//     bajarilgan buyruqlar HECH QAYERDA qolmasdi — foydalanuvchi nima
//     bajarilganini bilmasdi;
//   - ruxsat qanday berilgani (auto / foydalanuvchi / "har doim" / rad /
//     muddat) umuman saqlanmasdi, ya'ni "bu buyruq nega bajarildi?" degan
//     savolga javob yo'q edi.
// Endi har chaqiruv AVVAL shu jadvalga yoziladi, KEYIN UI'ga tarqatiladi.
//
// NEGA 8 EMAS, 9. Ba'zi mahalliy bazalarda 8-raqam ostida tashlab yuborilgan
// tajriba (`command_runs`) yozib qo'yilgan. Migratsiya tizimi raqam bo'yicha
// ishlaydi, ya'ni yangi 8-migratsiya o'sha bazalarda JIMGINA o'tkazib
// yuborilardi va jadval yaratilmasdi. 9-raqam ikkala holatda ham qo'llanadi;
// quyidagi DROP esa o'sha yetim jadvalni tozalaydi (yangi bazada u yo'q,
// `IF EXISTS` shuning uchun).
//
// `message_id` ga FOREIGN KEY QO'YILMAYDI. Sabab: chaqiruvlar oqim
// DAVOMIDA yoziladi, assistant xabari esa oqim oxirida — FK bo'lsa har
// yozuv "yo'q xabar" xatosi bilan yiqilardi. Sessiya bo'yicha CASCADE
// yetarli: suhbat o'chirilsa chaqiruvlari ham ketadi.

export const migratsiya: Migratsiya = {
  raqam: 9,
  nom: 'tool-chaqiruvlar',
  sql: `
    DROP TABLE IF EXISTS command_runs;

    CREATE TABLE tool_chaqiruvlar (
      id           TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
      message_id   TEXT NOT NULL,
      nom          TEXT NOT NULL,
      args         TEXT NOT NULL,
      holat        TEXT NOT NULL,
      natija       TEXT,
      tafsilot     TEXT,
      ruxsat       TEXT,
      klassifikator TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );

    -- Bitta javobning kartalari tartib bilan o'qiladi (UI shu tartibda chizadi)
    CREATE INDEX tool_chaqiruvlar_message ON tool_chaqiruvlar (message_id, created_at);
    -- Sessiya bo'yicha tozalash va tarix ko'rish uchun
    CREATE INDEX tool_chaqiruvlar_session ON tool_chaqiruvlar (session_id, created_at);
  `,
}

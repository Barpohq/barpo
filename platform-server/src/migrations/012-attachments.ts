import type { Migration } from './index.ts'

// Chatga biriktirilgan fayl va rasmlar.
//
// NEGA ALOHIDA JADVAL, XABAR ICHIDAGI JSON EMAS. Biriktirma xabardan OLDIN
// yaratiladi: foydalanuvchi faylni tanlaydi (yoki rasmni paste qiladi),
// matnni keyin yozadi, "Yuborish" ni esa umuman bosmasligi ham mumkin.
// O'sha payt `chat_messages` da yopishadigan qator hali YO'Q.
// `009-tool-chaqiruvlar.ts` dagi bilan bir xil vaziyat va bir xil yechim.
//
// `message_id` NULL BO'LISHI MUMKIN va unga FOREIGN KEY QO'YILMAYDI:
//   NULL  — yuklandi, lekin hali hech qaysi xabarga biriktirilmagan;
//   to'la — xabar yuborilgan, biriktirma o'sha xabarga tegishli.
// FK bo'lsa yuklash paytida "yo'q xabar" xatosi bilan yiqilardi. Sessiya
// bo'yicha CASCADE yetarli.
//
// `yol` — ish papkasiga NISBATAN yo'l (`.platforma/sessiyalar/<sid>/fayllar/x.png`),
// absolut emas. Ikki sabab: (1) loyiha papkasi ko'chirilsa yozuvlar
// buzilmaydi, (2) mijozga absolut yo'l hech qachon ko'rinmaydi.
//
// `tur` — 'rasm' | 'fayl', MAGIC BYTES bo'yicha aniqlanadi (`biriktirma.ts`),
// kengaytmaga yoki mijoz bergan `content-type` ga ishonilmaydi. Rasm ham
// oddiy fayl kabi diskda yotadi — agent uni `read` bilan o'qiydi. Tur faqat
// uchta joyda kerak: UI ko'rinishi, `GET` javobining `content-type` i va
// vision qorovuli.
//
// DISK va BAZA — ikki manba, tranzaksiya ikkalasini qamramaydi. Kelishmovchilik
// TARTIB bilan yumshatiladi: avval diskka yoziladi, keyin bazaga
// (`routes/projects.ts` dagi papka→yozuv tartibi bilan bir xil sabab).
// Qolgan holatlar ataylab toleran: bazada bor-yu diskda yo'q bo'lsa o'qish
// xato beradi, lekin sessiya yashaydi.

export const migration: Migration = {
  number: 12,
  name: 'biriktirmalar',
  sql: `
    CREATE TABLE chat_biriktirmalar (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
      message_id  TEXT,
      tur         TEXT NOT NULL,
      nom         TEXT NOT NULL,
      asl_nom     TEXT NOT NULL,
      yol         TEXT NOT NULL,
      mime        TEXT NOT NULL,
      hajm        INTEGER NOT NULL,
      created_at  TEXT NOT NULL
    );

    -- Xabar tarixi o'qilganda biriktirmalar shu bo'yicha guruhlanadi
    CREATE INDEX chat_biriktirmalar_message ON chat_biriktirmalar (message_id, created_at);
    -- Yetimlarni tozalash va sessiya papkasini o'chirish uchun
    CREATE INDEX chat_biriktirmalar_session ON chat_biriktirmalar (session_id, created_at);
  `,
}

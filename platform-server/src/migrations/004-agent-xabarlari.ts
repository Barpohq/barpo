import type { Migratsiya } from './index.ts'

// LLM kontekstining to'liq nusxasi xabar bilan birga saqlanadi.
//
// MUAMMO: `text` va `tool_cards` UI uchun yetarli, lekin LLM uchun EMAS.
// Tool natijalari (`read` o'qigan fayl mazmuni, `bash` chiqishi) hech qayerda
// saqlanmasdi, shuning uchun keyingi turn'da agent ularni ko'rmasdi:
//
//   1-xabar: "package.json ni o'qi" → agent read qiladi, javob beradi
//   2-xabar: "versiyani ayt"        → agent faylni QAYTA o'qishga majbur
//
// Har turn agent xotirasini yo'qotardi — tool'li agent uchun asosiy nuqson.
//
// YECHIM: pi-agent-core ning `AgentMessage[]` massivi xom JSON sifatida
// saqlanadi. Unda tool call'lar, tool natijalari, thinking bloklari va
// provider metadatasi — hammasi bor.
//
// Nega alohida ustun, `text` ni almashtirmasdan? Ikkalasi turli maqsad
// uchun: `text` — UI ko'rsatadigan toza matn (va eski xabarlar uchun yagona
// manba), `agent_messages` — LLM ko'radigan to'liq kontekst. Eski xabarlarda
// bu ustun NULL bo'ladi va tarix qurishda `text` dan zaxira sifatida
// foydalaniladi, ya'ni mavjud suhbatlar buzilmaydi.
//
// `context_tokens` — oxirgi javobda provider aytgan kontekst hajmi.
// Compaction qarori shu songa tayanadi: har safar butun tarixni qayta
// hisoblash o'rniga provider bergan aniq raqamdan foydalanamiz.

export const migratsiya: Migratsiya = {
  raqam: 4,
  nom: 'agent-xabarlari',
  sql: `
    ALTER TABLE chat_messages ADD COLUMN agent_messages TEXT;
    ALTER TABLE chat_messages ADD COLUMN context_tokens INTEGER;
  `,
}

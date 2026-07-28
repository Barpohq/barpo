// Suhbatda aytilgan chegaralarni ajratib olish.
//
// Foydalanuvchi "push qilma" yoki "men ko'rmagunimcha deploy qilma" desa, bu
// klassifikator uchun BLOK SIGNALI bo'ladi — standart qoidalar ruxsat bergan
// bo'lsa ham.
//
// Claude Code'dagi ikki muhim xususiyat takrorlanadi:
//   1) chegara qoida sifatida saqlanmaydi — har tekshiruvda suhbatdan qayta
//      o'qiladi (shuning uchun eski xabar kontekstdan chiqib ketsa yo'qoladi);
//   2) AGENT O'ZI chegarani bekor qila olmaydi — "shart bajarildi" degan
//      xulosasi hisobga olinmaydi, faqat foydalanuvchining yangi xabari.
//
// Bu yerda LLM ishlatilmaydi: chegaralar klassifikator promptiga xom holda
// qo'shiladi, qaror LLM'ning o'ziga qoladi. Bu modul faqat "qaysi xabarlar
// chegaraga o'xshaydi" degan savolga javob beradi — qo'pol, lekin arzon
// filtr. Adashsa ham zarari yo'q: ortiqcha jumla promptga tushadi, xolos.

/** Chegaraga ishora qiluvchi o'zbekcha va inglizcha naqshlar */
const CHEGARA_NAQSHLARI: RegExp[] = [
  // O'zbekcha inkor: "...ma", "...manglar", "kerak emas", "to'xta"
  /\b\w+ma\b(?!\w)/i,
  /kerak\s+emas/i,
  /shart\s+emas/i,
  /\bto['’]?xta/i,
  /\brad\s+et/i,
  /\bqilma\b/i,
  /\btegma\b/i,
  /\bo['’]?chirma\b/i,
  /\bmen\s+ko['’]?r(gunim|maguncha)/i,
  /\bavval\s+(so['’]?ra|menga)/i,
  /\bfaqat\s+.*\bkeyin\b/i,
  // Inglizcha
  /\bdon['’]?t\b/i,
  /\bdo not\b/i,
  /\bnever\b/i,
  /\bavoid\b/i,
  /\bwait until\b/i,
  /\bbefore you\b/i,
  /\bask (me )?first\b/i,
  /\bwithout (my )?(permission|approval)\b/i,
]

/** Bitta xabar chegara aytayotganga o'xshaydimi */
export function chegaraMi(matn: string): boolean {
  return CHEGARA_NAQSHLARI.some((n) => n.test(matn))
}

/**
 * Suhbatdan chegara aytayotgan FOYDALANUVCHI xabarlarini ajratadi.
 *
 * Faqat `user` roli olinadi: agentning o'z xabari chegara qo'ya ham olmaydi,
 * bekor ham qila olmaydi.
 */
export function chegaralarniAjrat(
  xabarlar: { role: 'user' | 'assistant'; text: string }[],
): string[] {
  return xabarlar
    .filter((x) => x.role === 'user')
    .map((x) => x.text.trim())
    .filter((t) => t.length > 0 && chegaraMi(t))
}

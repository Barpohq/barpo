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
// filtr.
//
// ---------------------------------------------------------------------------
// NEGA "har qanday -ma bilan tugagan so'z" EMAS
// ---------------------------------------------------------------------------
// Oldin bu yerda `/\b\w+ma\b/i` naqshi bor edi: "ma" bilan tugagan HAR QANDAY
// so'z chegara deb qabul qilinardi. O'zbek tilida (va ayniqsa dasturlash
// suhbatida) `-ma` bilan tugaydigan o'zlashma otlar juda ko'p, shuning uchun
// naqsh mana bularni noto'g'ri ushlardi:
//
//   sxema, tema, forma, sistema, problema, diagramma, norma, reklama,
//   dasturlama, juma, tizma
//
// Ya'ni "sxema chizib ber" yoki "bu forma komponentini tuzat" degan mutlaqo
// oddiy so'rov ham "foydalanuvchi chegara qo'ydi" deb klassifikator promptiga
// tushardi. Zarari faqat "ortiqcha jumla" emas: prompt chegaralar bo'limiga
// "Bu chegaralarni buzadigan amalni BLOK qil" ko'rsatmasi bilan kiradi, ya'ni
// LLM aynan shu jumlani chegara deb qarashga undaladi va so'ralgan ishning
// o'zini bloklab qo'yishi mumkin.
//
// Yechim: "so'z -ma bilan tugadimi" emas, "FE'L + inkor qo'shimchasi" mi.
// Buning uchun ikkita ro'yxat ishlatiladi:
//   1) INKOR_FELLAR — chegara ma'nosida real uchraydigan fe'l o'zaklari
//      (qil, o'chir, teg, yubor, push qil, deploy qil ...);
//   2) INKOR_QOSHIMCHASI — inkor imperativning to'liq shakllari
//      (-ma, -mang, -masin, -maslik, -may, -masdan ...).
//
// Ro'yxat ataylab yopiq: noto'g'ri ushlash (false positive) chegara
// o'tkazib yuborishdan (false negative) qimmatroq, chunki o'tkazib
// yuborilgan chegarani klassifikatorning o'zi suhbat matnidan ham ko'rishi
// mumkin — suhbat baribir to'liq promptga tushadi. Ro'yxatga kirmagan
// fe'l uchrasa, uni shu yerga qo'shish kifoya.

/**
 * Inkor qo'shimchasi bilan chegara ma'nosini beradigan fe'l o'zaklari.
 *
 * Bir necha so'zli ("push qil", "ishga tushir") variantlar ham bor — o'zbek
 * tilida ko'p ingliz atamasi `qil` yordamchi fe'li bilan yasaladi.
 */
const INKOR_FELLAR = [
  // umumiy amal
  'qil', 'et', 'bajar', 'ishlat', 'urin', 'harakat qil',
  // yaratish / o'zgartirish
  'yoz', 'yarat', "qo'sh", "o'zgartir", 'tahrirla', 'tuzat', 'almashtir',
  "ko'chir", 'nusxala', 'formatla',
  // o'chirish
  "o'chir", 'tashla', 'tozala', "yo'q qil", 'olib tashla',
  // tegish
  'teg',
  // tashqariga chiqarish
  'yubor', "jo'nat", 'chiqar', 'yukla', "o'rnat",
  'push qil', 'deploy qil', 'commit qil', 'merge qil', 'publish qil',
  // jarayon boshqaruvi
  'ishga tushir', "to'xtat", 'qayta yukla', 'ulan', 'och', 'yop',
  // muloqot / harakat
  "so'ra", 'ber', 'ol', 'ket', 'bor', 'kir', 'chiq', 'boshla', 'davom ettir',
]

/**
 * Inkor imperativning shakllari.
 *
 * `-ma` (qilma), `-mang`/`-mangiz` (hurmat), `-masin` (uchinchi shaxs),
 * `-maslik` (harakat nomi: "o'chirmaslikni so'rayman"), `-may`/`-masdan`
 * (ravishdosh: "o'zgartirmasdan tekshir"), `-magin` (so'zlashuv).
 */
const INKOR_QOSHIMCHASI = "(?:ma|mang|mangiz|manglar|masin|masinlar|masangiz|maslik|maslikni|may|masdan|magin)"

/** RegExp maxsus belgilarini ekranlaydi — fe'llar ro'yxatida `'` bor */
function ekranla(matn: string): string {
  return matn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * "FE'L + inkor" naqshi.
 *
 * Chegarasi sifatida `\b` emas, `[^\p{L}]` ishlatiladi: o'zbekcha
 * apostroflar (`'`, `'`) `\w` ga kirmaydi, shuning uchun `\b` "o'chirma" ni
 * noto'g'ri bo'laklaydi.
 */
const INKOR_NAQSHI = new RegExp(
  `(?:^|[^\\p{L}])(?:${INKOR_FELLAR.map(ekranla).join('|')})${INKOR_QOSHIMCHASI}(?![\\p{L}])`,
  'iu',
)

/** Chegaraga ishora qiluvchi o'zbekcha va inglizcha naqshlar */
const CHEGARA_NAQSHLARI: RegExp[] = [
  // O'zbekcha inkor: fe'l + inkor qo'shimchasi (qilma, o'chirmang, tegmasin)
  INKOR_NAQSHI,
  // Boshqa o'zbekcha chegara iboralari
  /kerak\s+emas/i,
  /shart\s+emas/i,
  /\bto['’]?xta/i,
  /\brad\s+et/i,
  /\bmen\s+ko['’]?r(gunim|maguncha)/i,
  /\bavval\s+(so['’]?ra|menga)/i,
  /\bfaqat\s+.*\bkeyin\b/i,
  /\bruxsatsiz\b/i,
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

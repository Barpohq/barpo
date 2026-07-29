// Config sxemasi — yagona haqiqat manbai.
//
// Bu fayl uch narsani BIR JOYDA belgilaydi:
//   1) TypeScript tiplari (kod uchun),
//   2) standart qiymatlar (fayl bo'lmasa nima ishlaydi),
//   3) maydon tavsiflari va chegaralari (web UI formasini qurish uchun).
//
// Nega uchalasi birga? Ular ajralib ketsa muqarrar ravishda bir-biriga mos
// kelmay qoladi: tip o'zgaradi, standart eskiligicha qoladi, UI uchinchi
// narsani ko'rsatadi. Bu yerda esa maydon qo'shish = bitta joyga yozish.
//
// `MAYDONLAR` dan JSON Schema (`schema.json`) generatsiya qilinadi —
// tahrirlagichlar (VS Code) foydalanuvchiga avtomatik to'ldirish beradi.
// Generatsiya: `bun run platform-config/src/schema-yoz.ts`.

/** Maydonning turi — validatsiya va UI vidjeti shunga qarab tanlanadi */
export type MaydonTuri = 'son' | 'matn' | 'mantiq' | 'tanlov' | 'matnRoyxati'

/**
 * Bitta sozlama maydonining ta'rifi.
 *
 * `yol` — nuqta bilan ajratilgan yo'l (`agent.tarix.maksXabar`). Web UI
 * shu yo'l bo'yicha qiymatni o'qiydi va yozadi, ya'ni forma tuzilishi
 * config tuzilishini takrorlaydi.
 */
export interface MaydonTarifi {
  yol: string
  tur: MaydonTuri
  /** Fayl bo'lmaganda yoki maydon ko'rsatilmaganda ishlatiladigan qiymat */
  standart: unknown
  /** Foydalanuvchiga ko'rsatiladigan tushuntirish (UI'da va JSON Schema'da) */
  izoh: string
  /** `son` uchun chegaralar — validatsiya va UI slider/input uchun */
  eng?: { kam?: number; kop?: number }
  /** `tanlov` uchun mumkin qiymatlar */
  variantlar?: readonly string[]
  /**
   * Maydon qiymati `null` bo'lishi mumkinmi.
   * `null` odatda "avtomatik / cheklovsiz" ma'nosini beradi (masalan
   * compaction modeli `null` bo'lsa asosiy chat modeli ishlatiladi).
   */
  nullBolishiMumkin?: boolean
}

/**
 * Barcha sozlamalar. Tartib UI'da ko'rinadigan tartib.
 *
 * Yangi sozlama qo'shish: shu ro'yxatga bitta qator + `Config` tipiga
 * mos maydon. Boshqa hech qayerni o'zgartirish shart emas — o'qish,
 * validatsiya, standart qiymat va JSON Schema o'zi ishlaydi.
 */
export const MAYDONLAR = [
  // --- Agent: kontekst va tarix ---
  {
    yol: 'agent.tarix.maksXabar',
    tur: 'son',
    standart: 200,
    izoh: "LLM'ga yuboriladigan eng ko'p xabar soni. Bundan eskilari tashlanadi (compaction yoqilgan bo'lsa avval siqiladi).",
    eng: { kam: 10, kop: 5000 },
  },
  {
    yol: 'agent.tarix.toolNatijasiChegarasi',
    tur: 'son',
    standart: 4000,
    izoh: "Tarixga saqlanadigan bitta tool natijasining eng katta uzunligi (belgi). Uzun `read`/`bash` chiqishlari kontekstni bosib ketmasin.",
    eng: { kam: 200, kop: 100_000 },
  },

  // --- Agent: kontekst siqish (compaction) ---
  {
    yol: 'agent.siqish.yoqilgan',
    tur: 'mantiq',
    standart: true,
    izoh: "Kontekst to'lganda tarixni avtomatik siqish. O'chirilsa uzun suhbat context window'ga sig'may qoladi.",
  },
  {
    yol: 'agent.siqish.zaxiraTokenlar',
    tur: 'son',
    standart: 16_384,
    izoh: "Context window'ning summary prompti va javob uchun ajratilgan qismi. Kontekst (window - zaxira) dan oshsa siqish boshlanadi.",
    eng: { kam: 1000, kop: 200_000 },
  },
  {
    yol: 'agent.siqish.saqlanadiganTokenlar',
    tur: 'son',
    standart: 20_000,
    izoh: "Siqishdan keyin o'zgarishsiz saqlanadigan eng yangi kontekst hajmi. Kattaroq qiymat — yaqin tarix aniqroq, lekin siqish kamroq foyda beradi.",
    eng: { kam: 1000, kop: 200_000 },
  },
  {
    yol: 'agent.siqish.modeli',
    tur: 'matn',
    standart: null,
    nullBolishiMumkin: true,
    izoh: "Siqish uchun model, `provider/model` shaklida. `null` bo'lsa asosiy chat modeli ishlatiladi (summary sifati muhim, shuning uchun standart shunday).",
  },

  // --- Agent: tool'lar ---
  {
    yol: 'agent.toollar.yoqilgan',
    tur: 'matnRoyxati',
    standart: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'serverList', 'appPublish'],
    izoh: "Agentga beriladigan tool'lar. Ro'yxatdan olib tashlangan tool umuman ko'rinmaydi — agent uning borligini bilmaydi.",
  },
  {
    yol: 'agent.toollar.bashTimeoutSekund',
    tur: 'son',
    standart: 120,
    izoh: "Bitta `bash` buyrug'i uchun eng uzun bajarilish vaqti. Cheksiz kutish web sessiyasini qotiradi.",
    eng: { kam: 1, kop: 3600 },
  },
  {
    yol: 'agent.toollar.natijaChegarasi',
    tur: 'son',
    standart: 2000,
    izoh: "UI'ga yuboriladigan tool natijasining eng katta uzunligi (belgi). Tarixga saqlanadigan chegara alohida sozlanadi.",
    eng: { kam: 200, kop: 50_000 },
  },

  // --- Ruxsat va xavfsizlik ---
  {
    yol: 'ruxsat.rejim',
    tur: 'tanlov',
    standart: 'tasdiq',
    variantlar: ['tasdiq', 'auto'],
    izoh: "Yangi sessiyaning boshlang'ich ruxsat rejimi. `tasdiq` — har xavfli amal so'raladi; `auto` — klassifikator hal qiladi.",
  },
  {
    yol: 'ruxsat.kutishSoniya',
    tur: 'son',
    standart: 300,
    izoh: "Ruxsat so'roviga javob kutish muddati. Muddat tugasa so'rov RAD etiladi — agent abadiy osilib qolmasin.",
    eng: { kam: 10, kop: 3600 },
  },
  {
    yol: 'ruxsat.klassifikatorModeli',
    tur: 'matn',
    standart: null,
    nullBolishiMumkin: true,
    izoh: "Auto rejim klassifikatori uchun model, `provider/model` shaklida. `null` bo'lsa avtomatik tanlanadi (tez va sinalgan modellar ustuvor).",
  },
  {
    yol: 'ruxsat.ketmaKetBlokChegarasi',
    tur: 'son',
    standart: 3,
    izoh: "Klassifikator ketma-ket shuncha marta bloklasa auto rejim o'chadi — agent so'ralganidan chetga chiqayotgan bo'lishi mumkin.",
    eng: { kam: 1, kop: 100 },
  },
  {
    yol: 'ruxsat.jamiBlokChegarasi',
    tur: 'son',
    standart: 20,
    izoh: "Sessiya davomida jami shuncha blokdan keyin auto rejim o'chadi.",
    eng: { kam: 1, kop: 1000 },
  },
  {
    yol: 'ruxsat.qoshimchaTaqiqlar',
    tur: 'matnRoyxati',
    standart: [],
    izoh: "Qo'shimcha taqiqlangan buyruq nomlari. O'rnatilgan qat'iy taqiq ro'yxatiga QO'SHILADI, uni almashtirmaydi — xavfsizlik chegarasini pasaytirib bo'lmaydi.",
  },

  // --- Sessiya ---
  {
    yol: 'sessiya.ishPapkasi',
    tur: 'matn',
    standart: null,
    nullBolishiMumkin: true,
    izoh: "Agent tool'lari ishlaydigan papkalar ildizi. `null` bo'lsa `~/.platforma/ishlar/` ishlatiladi.",
  },
  {
    yol: 'sessiya.faolsizlikDaqiqa',
    tur: 'son',
    standart: 60,
    izoh: "Shuncha vaqt faolsiz sessiyaning xotiradagi resurslari (ruxsat holati, rejim) tozalanadi. Suhbat tarixi bazada qoladi.",
    eng: { kam: 1, kop: 10_080 },
  },
] as const satisfies readonly MaydonTarifi[]

// ---------------------------------------------------------------------------
// Config tipi
// ---------------------------------------------------------------------------

/**
 * Platformaning to'liq sozlamalari.
 *
 * `MAYDONLAR` bilan qo'lda sinxron saqlanadi — `sxema.test.ts` ikkalasi mos
 * kelishini tekshiradi, ya'ni birini o'zgartirib ikkinchisini unutib bo'lmaydi.
 */
export interface Config {
  agent: {
    tarix: {
      maksXabar: number
      toolNatijasiChegarasi: number
    }
    siqish: {
      yoqilgan: boolean
      zaxiraTokenlar: number
      saqlanadiganTokenlar: number
      /** `provider/model` yoki null (asosiy chat modeli) */
      modeli: string | null
    }
    toollar: {
      yoqilgan: string[]
      bashTimeoutSekund: number
      natijaChegarasi: number
    }
  }
  ruxsat: {
    rejim: 'tasdiq' | 'auto'
    kutishSoniya: number
    /** `provider/model` yoki null (avtomatik tanlash) */
    klassifikatorModeli: string | null
    ketmaKetBlokChegarasi: number
    jamiBlokChegarasi: number
    qoshimchaTaqiqlar: string[]
  }
  sessiya: {
    /** Papka yo'li yoki null (`~/.platforma/ishlar/`) */
    ishPapkasi: string | null
    faolsizlikDaqiqa: number
  }
}

/** Qisman config — fayllarda va birlashtirishda ishlatiladi */
export type QismanConfig = {
  [K in keyof Config]?: {
    [P in keyof Config[K]]?: Config[K][P]
  }
}

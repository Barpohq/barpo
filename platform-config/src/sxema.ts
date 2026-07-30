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
    izoh: 'Maximum number of messages sent to the LLM. Older ones are dropped (compacted first if compaction is enabled).',
    eng: { kam: 10, kop: 5000 },
  },
  {
    yol: 'agent.tarix.toolNatijasiChegarasi',
    tur: 'son',
    standart: 4000,
    izoh: 'Maximum length (characters) of a single tool result stored in history, so long `read`/`bash` output does not swamp the context.',
    eng: { kam: 200, kop: 100_000 },
  },

  // --- Agent: kontekst siqish (compaction) ---
  {
    yol: 'agent.siqish.yoqilgan',
    tur: 'mantiq',
    standart: true,
    izoh: 'Automatically compact history when the context fills up. If disabled, a long conversation stops fitting in the context window.',
  },
  {
    yol: 'agent.siqish.zaxiraTokenlar',
    tur: 'son',
    standart: 16_384,
    izoh: 'Part of the context window reserved for the summary prompt and the response. Compaction starts once the context exceeds (window - reserve).',
    eng: { kam: 1000, kop: 200_000 },
  },
  {
    yol: 'agent.siqish.saqlanadiganTokenlar',
    tur: 'son',
    standart: 20_000,
    izoh: 'How much of the most recent context is kept verbatim after compaction. A larger value keeps recent history more precise but makes compaction less effective.',
    eng: { kam: 1000, kop: 200_000 },
  },
  {
    yol: 'agent.siqish.modeli',
    tur: 'matn',
    standart: null,
    nullBolishiMumkin: true,
    izoh: 'Model used for compaction, as `provider/model`. When `null` the main chat model is used (summary quality matters, hence the default).',
  },

  // --- Agent: tool'lar ---
  {
    yol: 'agent.toollar.yoqilgan',
    tur: 'matnRoyxati',
    standart: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'serverList', 'appPublish'],
    izoh: 'Tools given to the agent. A tool removed from the list is invisible — the agent does not know it exists.',
  },
  {
    yol: 'agent.toollar.bashTimeoutSekund',
    tur: 'son',
    standart: 120,
    izoh: 'Maximum run time for a single `bash` command. Waiting forever would freeze the web session.',
    eng: { kam: 1, kop: 3600 },
  },
  {
    yol: 'agent.toollar.natijaChegarasi',
    tur: 'son',
    standart: 2000,
    izoh: 'Maximum length (characters) of a tool result sent to the UI. The limit for what is stored in history is configured separately.',
    eng: { kam: 200, kop: 50_000 },
  },

  // --- Ruxsat va xavfsizlik ---
  {
    yol: 'ruxsat.rejim',
    tur: 'tanlov',
    standart: 'tasdiq',
    variantlar: ['tasdiq', 'auto'],
    izoh: 'Initial permission mode for a new session. `tasdiq` asks about every dangerous action; `auto` lets the classifier decide.',
  },
  {
    yol: 'ruxsat.kutishSoniya',
    tur: 'son',
    standart: 300,
    izoh: 'How long to wait for an answer to a permission request. On timeout the request is DENIED, so the agent does not hang forever.',
    eng: { kam: 10, kop: 3600 },
  },
  {
    yol: 'ruxsat.klassifikatorModeli',
    tur: 'matn',
    standart: null,
    nullBolishiMumkin: true,
    izoh: 'Model for the auto-mode classifier, as `provider/model`. When `null` it is chosen automatically (fast, proven models first).',
  },
  {
    yol: 'ruxsat.ketmaKetBlokChegarasi',
    tur: 'son',
    standart: 3,
    izoh: 'Auto mode turns off after the classifier blocks this many actions in a row — the agent may be going beyond what was asked.',
    eng: { kam: 1, kop: 100 },
  },
  {
    yol: 'ruxsat.jamiBlokChegarasi',
    tur: 'son',
    standart: 20,
    izoh: 'Auto mode turns off after this many blocks in total during a session.',
    eng: { kam: 1, kop: 1000 },
  },
  {
    yol: 'ruxsat.qoshimchaTaqiqlar',
    tur: 'matnRoyxati',
    standart: [],
    izoh: 'Additional forbidden command names. They are ADDED to the built-in hard block list, never replace it — the security boundary cannot be lowered.',
  },

  // --- Sessiya ---
  {
    yol: 'sessiya.ishPapkasi',
    tur: 'matn',
    standart: null,
    nullBolishiMumkin: true,
    izoh: 'Root directory the agent tools work in. When `null`, `~/.platforma/ishlar/` is used.',
  },
  {
    yol: 'sessiya.faolsizlikDaqiqa',
    tur: 'son',
    standart: 60,
    izoh: 'In-memory resources of a session idle for this long (permission state, mode) are cleaned up. The conversation history stays in the database.',
    eng: { kam: 1, kop: 10_080 },
  },

  // --- MCP serverlar ---
  //
  // "MCP yoqilgan/o'chirilgan" degan bayroq ATAYLAB YO'Q: nazorat
  // o'rnatishda. Server o'rnatilmagan bo'lsa MCP qatlami umuman ishga
  // tushmaydi — tool e'lon qilinmaydi va prompt uni tilga olmaydi
  // (`platform-ai/src/mcp-toollari.ts` izohiga q.). Bayroq qo'yilsa
  // foydalanuvchi serverni o'rnatib, keyin "nega ishlamayapti" holatiga
  // tushardi.
  {
    yol: 'mcp.ulanishTimeoutSekund',
    tur: 'son',
    standart: 10,
    izoh: 'Maximum wait for the MCP server handshake. If the server does not respond the session continues — only that server is unavailable.',
    eng: { kam: 1, kop: 60 },
  },
  {
    yol: 'mcp.chaqiruvTimeoutSekund',
    tur: 'son',
    standart: 30,
    izoh: 'Maximum wait for a single MCP tool call.',
    eng: { kam: 1, kop: 300 },
  },

  // --- Chatga biriktirilgan fayllar ---
  //
  // Rasm uchun ALOHIDA chegara yo'q: rasm ham oddiy fayl kabi diskda yotadi
  // va LLM'ga base64 bo'lib uzatilmaydi — agent uni `read` bilan o'zi
  // o'qiydi. Ya'ni katta rasm kontekstni to'g'ridan-to'g'ri bosmaydi;
  // `agent.tarix.toolNatijasiChegarasi` esa uni o'qilgandan keyin tiyadi.
  {
    yol: 'chat.biriktirma.maksFaylMb',
    tur: 'son',
    standart: 20,
    izoh: 'Maximum size (MB) of a single file attached to a chat.',
    eng: { kam: 1, kop: 200 },
  },
  {
    yol: 'chat.biriktirma.maksSoni',
    tur: 'son',
    standart: 10,
    izoh: 'Maximum number of files attached to a single message.',
    eng: { kam: 1, kop: 50 },
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
  mcp: {
    ulanishTimeoutSekund: number
    chaqiruvTimeoutSekund: number
  }
  chat: {
    biriktirma: {
      maksFaylMb: number
      maksSoni: number
    }
  }
}

/** Qisman config — fayllarda va birlashtirishda ishlatiladi */
export type QismanConfig = {
  [K in keyof Config]?: {
    [P in keyof Config[K]]?: Config[K][P]
  }
}

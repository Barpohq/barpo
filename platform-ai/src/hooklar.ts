// Tool hook'lari — tool chaqiruvidan oldin va keyin aralashish nuqtasi.
//
// pi'da bu `beforeToolCall` / `afterToolCall` (agent-core) va extension
// `tool_call` / `tool_result` hook'lari. Bizda ular platformaga chiqariladi:
// bir nechta hook ro'yxatga olinadi, ular KETMA-KET ishlaydi va har biri
// natijani o'zgartirishi mumkin.
//
// Nega kerak:
//   - tool natijasidagi maxfiy ma'lumotni yashirish (API kalitlar, tokenlar);
//   - juda uzun natijani qisqartirish (kontekstni tejash);
//   - qo'shimcha siyosat: "bu papkaga yozish taqiqlangan";
//   - kuzatuv va audit (bloklamasdan).
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ MUHIM: hook XAVFSIZLIK QATLAMINI ALMASHTIRMAYDI.                     │
// │                                                                      │
// │ Qat'iy taqiq (`buyruq-tahlil.ts`), ish papkasi chegarasi             │
// │ (`muhit.ts`) va klassifikator hook'lardan OLDIN ishlaydi va ular     │
// │ hook orqali bekor qilinmaydi. Hook faqat QO'SHIMCHA cheklov qo'ya    │
// │ oladi — ruxsatni kengaytira olmaydi.                                 │
// │                                                                      │
// │ Sabab: hook konfiguratsiyadan keladi, konfiguratsiya esa loyiha      │
// │ fayli orqali begona odam yozgan bo'lishi mumkin.                     │
// └──────────────────────────────────────────────────────────────────────┘
//
// Hook xatosi TOOLNI BLOKLAYDI (fail-closed). Sabab: hook maxfiy ma'lumotni
// yashirish uchun qo'yilgan bo'lishi mumkin — u ishlamasa, natijani filtrsiz
// o'tkazish xavfliroq. pi ham shunday qiladi ("Extension failed, blocking
// execution").

/** Tool chaqiruvi haqida hook ko'radigan ma'lumot */
export interface ToolChaqiruvKonteksti {
  nom: string
  args: unknown
  /** Tool qaysi papkada ishlayapti */
  ishPapkasi: string
  sessionId: string
}

/** Tool natijasi haqida hook ko'radigan ma'lumot */
export interface ToolNatijaKonteksti extends ToolChaqiruvKonteksti {
  /** Natija matni (bir nechta bo'lak bo'lsa birlashtirilgan) */
  natija: string
  xatomi: boolean
}

/** `oldin` hook'ining javobi. `undefined` — aralashmaslik. */
export interface OldinNatijasi {
  /** Toolni bloklash */
  blokla?: boolean
  /** Bloklash sababi — agentga xato matni sifatida ko'rsatiladi */
  sabab?: string
}

/** `keyin` hook'ining javobi. `undefined` — aralashmaslik. */
export interface KeyinNatijasi {
  /** Natija matnini almashtirish */
  natija?: string
  /** Xato bayrog'ini o'zgartirish */
  xatomi?: boolean
}

export interface ToolHooki {
  /** Diagnostika va xato xabarlari uchun */
  nom: string
  /** Tool bajarilishidan oldin. Bloklashi mumkin. */
  oldin?: (k: ToolChaqiruvKonteksti) => OldinNatijasi | undefined | Promise<OldinNatijasi | undefined>
  /** Tool bajarilgandan keyin. Natijani o'zgartirishi mumkin. */
  keyin?: (k: ToolNatijaKonteksti) => KeyinNatijasi | undefined | Promise<KeyinNatijasi | undefined>
}

// ---------------------------------------------------------------------------
// Hook zanjiri
// ---------------------------------------------------------------------------

/**
 * Hook'larni ketma-ket ishga tushiradi.
 *
 * `oldin`: BIRINCHI bloklagan hook g'olib — qolganlari chaqirilmaydi.
 * Sabab: qaror allaqachon qabul qilingan, qolgan hook'lar uni bekor qila
 * olmaydi (aks holda hook tartibi xavfsizlikka ta'sir qilardi).
 */
export async function oldinZanjiri(
  hooklar: readonly ToolHooki[],
  kontekst: ToolChaqiruvKonteksti,
): Promise<OldinNatijasi | undefined> {
  for (const hook of hooklar) {
    if (!hook.oldin) continue
    let natija: OldinNatijasi | undefined
    try {
      natija = await hook.oldin(kontekst)
    } catch (xato) {
      // Fail-closed: hook ishlamasa toolni bloklaymiz
      return {
        blokla: true,
        sabab: `hook "${hook.nom}" xato berdi: ${xatoMatni(xato)}`,
      }
    }
    if (natija?.blokla) {
      return { blokla: true, sabab: natija.sabab ?? `hook "${hook.nom}" blokladi` }
    }
  }
  return undefined
}

/**
 * `keyin` hook'larini ketma-ket ishga tushiradi.
 *
 * Har hook oldingisining natijasini ko'radi — zanjir bo'lib o'zgartiriladi
 * (masalan avval maxfiy ma'lumot yashiriladi, keyin uzunlik qisqartiriladi).
 *
 * Hook xatosi bu yerda toolni bloklamaydi — natija allaqachon olingan, uni
 * tashlab yuborish foydasiz. Lekin natija O'ZGARTIRILMAGAN holda qaytadi va
 * xato natijaga qo'shiladi, ya'ni jimgina o'tib ketmaydi.
 */
export async function keyinZanjiri(
  hooklar: readonly ToolHooki[],
  kontekst: ToolNatijaKonteksti,
): Promise<{ natija: string; xatomi: boolean }> {
  let joriy = { natija: kontekst.natija, xatomi: kontekst.xatomi }

  for (const hook of hooklar) {
    if (!hook.keyin) continue
    try {
      const javob = await hook.keyin({ ...kontekst, ...joriy })
      if (!javob) continue
      joriy = {
        natija: javob.natija ?? joriy.natija,
        xatomi: javob.xatomi ?? joriy.xatomi,
      }
    } catch (xato) {
      joriy = {
        natija: `${joriy.natija}\n\n⚠︎ hook "${hook.nom}" xato berdi: ${xatoMatni(xato)}`,
        xatomi: joriy.xatomi,
      }
    }
  }

  return joriy
}

// ---------------------------------------------------------------------------
// Tayyor hook'lar
// ---------------------------------------------------------------------------

/**
 * Maxfiy ko'rinishdagi qatorlarni yashiradi.
 *
 * `read` yoki `bash` `.env` faylini yoki `env` chiqishini qaytarsa, kalitlar
 * LLM kontekstiga tushadi va providerga yuboriladi. Bu hook ularni almashtiradi.
 *
 * CHEKLOV: bu naqsh asosidagi filtr, kafolat emas. Kalit boshqa shaklda
 * yozilgan bo'lsa (masalan bo'laklab) o'tib ketadi. Haqiqiy himoya — maxfiy
 * fayllarni umuman o'qitmaslik.
 */
export function maxfiyniYashirHooki(): ToolHooki {
  // `KALIT=qiymat` va `"kalit": "qiymat"` shakllari. Kalit nomida
  // key/token/secret/password bo'lsa qiymat yashiriladi.
  const naqshlar: RegExp[] = [
    /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*=\s*(\S+)/gi,
    /(["']?[\w.-]*(?:key|token|secret|password|credential)[\w.-]*["']?\s*:\s*)(["'])([^"']{4,})\2/gi,
    // Tanilgan kalit shakllari — nomidan qat'i nazar
    /\b(sk-[A-Za-z0-9_-]{16,})/g,
    /\b(ghp_[A-Za-z0-9]{20,})/g,
    /\b(xox[baprs]-[A-Za-z0-9-]{10,})/g,
  ]

  return {
    nom: 'maxfiyni-yashir',
    keyin: ({ natija }) => {
      let yangi = natija
      yangi = yangi.replace(naqshlar[0]!, (_m, kalit: string) => `${kalit}=‹yashirildi›`)
      yangi = yangi.replace(naqshlar[1]!, (_m, oldi: string, tirnoq: string) => `${oldi}${tirnoq}‹yashirildi›${tirnoq}`)
      for (const naqsh of naqshlar.slice(2)) {
        yangi = yangi.replace(naqsh, '‹yashirildi›')
      }
      return yangi === natija ? undefined : { natija: yangi }
    },
  }
}

/**
 * Natijani belgilangan uzunlikda kesadi.
 *
 * `agent.ts` dagi UI chegarasidan farqi: bu LLM ko'radigan natijaga
 * qo'llanadi va configdan boshqariladi.
 */
export function uzunlikHooki(chegara: number): ToolHooki {
  return {
    nom: 'uzunlik',
    keyin: ({ natija }) => {
      if (natija.length <= chegara) return undefined
      const qolgan = natija.length - chegara
      return {
        natija: `${natija.slice(0, chegara)}\n… (${qolgan} belgi qisqartirildi)`,
      }
    },
  }
}

/**
 * Configdagi qo'shimcha taqiqlangan buyruqlarni tekshiradi.
 *
 * O'rnatilgan qat'iy taqiq ro'yxatiga QO'SHIMCHA — uni almashtirmaydi.
 * Foydalanuvchi "bu mashinada `docker` umuman ishlamasin" desa shu yerda
 * hal bo'ladi.
 */
export function qoshimchaTaqiqHooki(taqiqlar: readonly string[]): ToolHooki {
  const toplam = new Set(taqiqlar.map((t) => t.trim().toLowerCase()).filter(Boolean))

  return {
    nom: 'qoshimcha-taqiq',
    oldin: ({ nom, args }) => {
      if (toplam.size === 0) return undefined
      if (nom !== 'bash') return undefined
      const buyruq = (args as { command?: unknown })?.command
      if (typeof buyruq !== 'string') return undefined

      // Buyruq nomini qo'pol ajratamiz — aniq tahlil `buyruq-tahlil.ts` da,
      // bu yerda faqat qo'shimcha filtr
      const sozlar = buyruq.toLowerCase().split(/[\s;|&()]+/).filter(Boolean)
      for (const soz of sozlar) {
        const nomi = soz.split('/').pop() ?? soz
        if (toplam.has(nomi)) {
          return { blokla: true, sabab: `\`${nomi}\` sozlamalarda taqiqlangan` }
        }
      }
      return undefined
    },
  }
}

/**
 * Kuzatuv hook'i — bloklamaydi, faqat xabar beradi.
 * Audit yozish uchun orchestrator shu orqali ulanadi.
 */
export function kuzatuvHooki(
  kuzatuvchi: (k: ToolChaqiruvKonteksti) => void,
): ToolHooki {
  return {
    nom: 'kuzatuv',
    oldin: (k) => {
      try {
        kuzatuvchi(k)
      } catch {
        // Kuzatuv xatosi toolni bloklamasin — u audit uchun, siyosat uchun emas
      }
      return undefined
    },
  }
}

function xatoMatni(xato: unknown): string {
  return xato instanceof Error ? xato.message : String(xato)
}

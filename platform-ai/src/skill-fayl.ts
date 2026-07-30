// `SKILL.md` tahlili — frontmatter + validatsiya.
//
// Format (Agent Skills spec, pi ham shuni ishlatadi):
//
//   ---
//   name: pdf-fill
//   description: PDF formani to'ldiradi
//   allowed-tools: [read, bash]
//   ---
//
//   # Ko'rsatmalar
//   ...
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ NEGA O'Z PARSER: frontmatter'dan bizga atigi 4 ta maydon kerak       │
// │ (name, description, license, allowed-tools) va ularning hammasi —    │
// │ satr yoki satrlar ro'yxati. To'liq YAML (anchor, ko'p qatorli blok,  │
// │ ichma-ich obyekt) bu yerda ishlatilmaydi.                            │
// │                                                                      │
// │ `yaml` paketi node_modules'da bor, lekin u pi'ning TRANSITIV         │
// │ bog'liqligi — biz uni package.json'ga yozmaganmiz, ya'ni pi          │
// │ versiyasi o'zgarsa jimgina yo'qolishi mumkin. 60 qator kod uchun     │
// │ to'g'ridan-to'g'ri bog'liqlik qo'shishdan ko'ra o'zimiz yozganimiz   │
// │ tuzukroq: xatti-harakat aniq va o'zgarmaydi.                         │
// └──────────────────────────────────────────────────────────────────────┘
//
// VALIDATSIYA — ATAYLAB YUMSHOQ (pi'dagi kabi). Faqat `description` yo'qligi
// skillni rad etadi; qolgan hamma buzilish OGOHLANTIRISH bo'lib qaytadi va
// skill baribir yuklanadi. Sabab: `anthropics/skills` va uchinchi tomon
// repo'lari spec'ga aynan mos kelmasligi mumkin (nom uzunligi, katta harf),
// bitta mayda nomuvofiqlik uchun butun repo'ni yo'qotish foydalanuvchiga
// zarar qiladi.

/** Spec chegarasi — nom */
export const NOM_CHEGARASI = 64
/** Spec chegarasi — tavsif. Promptga tushadi, shuning uchun qat'iy. */
export const TAVSIF_CHEGARASI = 1024

export interface SkillFayl {
  nom: string
  tavsif: string
  litsenziya?: string
  allowedTools?: string[]
  /** Frontmatter'dan keyingi matn — hozircha saqlanmaydi, model o'zi o'qiydi */
  matn: string
  /** Spec buzilishlari. Skill baribir yuklangan. */
  ogohlantirishlar: string[]
}

/**
 * Frontmatter'ning MINIMAL YAML tahlili.
 *
 * Qo'llab-quvvatlanadi: `kalit: qiymat`, `[a, b]` inline ro'yxat, `- element`
 * blok ro'yxati, `|` / `>` blok skalarlari (`-`/`+` chomping bilan),
 * `"` va `'` qo'shtirnoq, `#` izoh.
 * Qo'llab-quvvatlanmaydi: ichma-ich obyekt, anchor. Bular uchraganda qiymat
 * xom satr bo'lib qoladi — yiqilmaydi.
 *
 * Blok skalari ALOHIDA MUHIM: `anthropics/skills` dagi `claude-api`
 * aynan shu shaklni ishlatadi (`description: |-`). Usiz tavsif `|-` degan
 * ikki belgi bo'lib qolardi — skill yuklanardi, lekin model uni qachon
 * ishlatishni bilmasdi.
 */
function frontmatterTahlil(xom: string): Record<string, string | string[]> {
  const natija: Record<string, string | string[]> = {}
  const qatorlar = xom.split('\n')

  for (let i = 0; i < qatorlar.length; i++) {
    const qator = qatorlar[i] ?? ''
    // Izoh va bo'sh qator. Ichma-ich maydon (bo'shliq bilan boshlanadi) ham
    // tashlanadi — biz kutgan maydonlarning hammasi yuqori darajada.
    if (!qator.trim() || qator.trimStart().startsWith('#') || /^\s/.test(qator)) continue

    const ikkiNuqta = qator.indexOf(':')
    if (ikkiNuqta === -1) continue

    const kalit = qator.slice(0, ikkiNuqta).trim()
    let qiymat = qator.slice(ikkiNuqta + 1).trim()
    if (!kalit) continue

    // Blok skalari: `|`, `|-`, `|+`, `>`, `>-`, `>+`
    //
    // `|` — qatorlar saqlanadi, `>` — bitta satrga qo'shiladi (folded).
    // Bizga tavsif kerak, u promptga bitta abzas bo'lib tushadi, shuning
    // uchun ikkalasi ham bo'sh qator chegarasida birlashtiriladi.
    const blok = /^([|>])([-+]?)(\d*)$/.exec(qiymat)
    if (blok) {
      const buklangan = blok[1] === '>'
      const qatorlarBloki: string[] = []

      // Blok tanasi — YUQORI DARAJADAGI keyingi kalitgacha bo'lgan
      // chekinishli qatorlar. Bo'sh qator ham blokka tegishli.
      while (i + 1 < qatorlar.length) {
        const keyingi = qatorlar[i + 1] ?? ''
        if (keyingi.trim() && !/^\s/.test(keyingi)) break
        qatorlarBloki.push(keyingi)
        i++
      }

      // Eng kichik chekinishni topib olib tashlaymiz. Blok bo'sh bo'lsa
      // `Math.min()` → Infinity, shuning uchun 0 ga tushiramiz.
      const chekinishlar = qatorlarBloki
        .filter((q) => q.trim())
        .map((q) => q.length - q.trimStart().length)
      const chekinish = chekinishlar.length > 0 ? Math.min(...chekinishlar) : 0
      const toza = qatorlarBloki.map((q) => (q.trim() ? q.slice(chekinish) : ''))

      natija[kalit] = buklangan
        ? // Folded: qo'shni qatorlar bo'shliq bilan qo'shiladi, bo'sh qator
          // abzas chegarasi bo'ladi
          toza
            .join('\n')
            .split(/\n\s*\n/)
            .map((abzas) => abzas.split('\n').join(' ').trim())
            .filter(Boolean)
            .join('\n')
            .trim()
        : toza.join('\n').trim()
      continue
    }

    // Qiymat bo'sh → keyingi qatorlarda blok ro'yxati bo'lishi mumkin
    if (!qiymat) {
      const royxat: string[] = []
      while (i + 1 < qatorlar.length && /^\s*-\s+/.test(qatorlar[i + 1] ?? '')) {
        royxat.push(tirnoqniOl((qatorlar[++i] ?? '').replace(/^\s*-\s+/, '').trim()))
      }
      if (royxat.length > 0) natija[kalit] = royxat
      continue
    }

    // Inline ro'yxat: [a, b, c]
    if (qiymat.startsWith('[') && qiymat.endsWith(']')) {
      natija[kalit] = qiymat
        .slice(1, -1)
        .split(',')
        .map((x) => tirnoqniOl(x.trim()))
        .filter((x) => x.length > 0)
      continue
    }

    // Qo'shtirnoqsiz qiymatda `#` izoh boshlaydi — lekin faqat oldida
    // bo'shliq bo'lsa (aks holda `C#` kabi qiymat buzilardi)
    if (!qiymat.startsWith('"') && !qiymat.startsWith("'")) {
      const izoh = qiymat.search(/\s#/)
      if (izoh !== -1) qiymat = qiymat.slice(0, izoh).trim()
    }

    natija[kalit] = tirnoqniOl(qiymat)
  }

  return natija
}

function tirnoqniOl(x: string): string {
  if (x.length >= 2 && ((x.startsWith('"') && x.endsWith('"')) || (x.startsWith("'") && x.endsWith("'")))) {
    return x.slice(1, -1)
  }
  return x
}

function satr(q: string | string[] | undefined): string | undefined {
  if (typeof q === 'string') return q
  return undefined
}

/**
 * `SKILL.md` matnini tahlil qiladi.
 *
 * `papkaNomi` — `name` maydoni yo'q bo'lganda zaxira (spec shunday aytadi).
 *
 * `null` FAQAT bitta holatda: `description` yo'q yoki bo'sh. Usiz skill
 * promptda ma'nosiz bo'ladi — model uni qachon ishlatishni bilmaydi.
 */
export function skillFayliniTahlil(xomMatn: string, papkaNomi: string): SkillFayl | null {
  const ogohlantirishlar: string[] = []

  // Frontmatter fence'i. BOM va boshlang'ich bo'sh qatorlarga chidamli.
  const matn = xomMatn.replace(/^﻿/, '')
  const moslik = /^\s*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(matn)
  if (!moslik) return null

  const maydonlar = frontmatterTahlil(moslik[1] ?? '')
  const tana = matn.slice(moslik[0].length).trim()

  const tavsif = satr(maydonlar.description)?.trim()
  if (!tavsif) return null

  let nom = satr(maydonlar.name)?.trim() || papkaNomi

  // --- Nomni tekshirish (spec: [a-z0-9-]+, ≤64, chetida/ketma-ket `-` yo'q) ---
  if (nom.length > NOM_CHEGARASI) {
    ogohlantirishlar.push(`name longer than ${NOM_CHEGARASI} characters — truncated`)
    nom = nom.slice(0, NOM_CHEGARASI)
  }
  if (!/^[a-z0-9-]+$/.test(nom)) {
    ogohlantirishlar.push('name does not match the spec: only lowercase letters, digits and `-` are allowed')
  }
  if (nom.startsWith('-') || nom.endsWith('-') || nom.includes('--')) {
    ogohlantirishlar.push('name has a leading, trailing or repeated `-` — does not match the spec')
  }

  // Nom papka nomidan farq qilsa — spec buni taqiqlaydi, lekin pi ataylab
  // yumshoq qaraydi (bir papka bir necha vosita bilan bo'lishilganda halal
  // beradi). Biz ham ogohlantirish bilan cheklanamiz.
  if (satr(maydonlar.name) && satr(maydonlar.name)?.trim() !== papkaNomi) {
    ogohlantirishlar.push(`name does not match the folder name (${papkaNomi})`)
  }

  let toliqTavsif = tavsif
  if (toliqTavsif.length > TAVSIF_CHEGARASI) {
    ogohlantirishlar.push(`description longer than ${TAVSIF_CHEGARASI} characters — truncated`)
    toliqTavsif = `${toliqTavsif.slice(0, TAVSIF_CHEGARASI)}…`
  }

  const allowedXom = maydonlar['allowed-tools']
  const allowedTools = Array.isArray(allowedXom)
    ? allowedXom
    : typeof allowedXom === 'string' && allowedXom.trim()
      ? allowedXom.split(',').map((x) => x.trim()).filter(Boolean)
      : undefined

  return {
    nom,
    tavsif: toliqTavsif,
    litsenziya: satr(maydonlar.license)?.trim() || undefined,
    allowedTools,
    matn: tana,
    ogohlantirishlar,
  }
}

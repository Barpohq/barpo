// Platforma bilan birga keladigan standart skilllar.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ BULAR ODDIY SKILLLAR KABI ISHLAYDI.                                  │
// │                                                                      │
// │ Ular katalogdan (`skilllar` jadvali) o'tadi, "Skill do'koni" da      │
// │ ko'rinadi va foydalanuvchi ularni xohlagancha o'rnatadi/o'chiradi.   │
// │ Yagona farq — MANBA: GitHub emas, repo ichidagi `skills/` papkasi.   │
// │                                                                      │
// │ NEGA HOZIRCHA LOKAL: platforma repo'si hozir yopiq, ya'ni GitHub     │
// │ API orqali o'qib bo'lmaydi. Repo ochilganda manba GitHub'ga ko'chadi │
// │ va FAQAT shu fayl o'zgaradi — katalog, o'rnatish, ombor va UI        │
// │ oqimlari o'z holicha qoladi, chunki ular manba turini bilmaydi.      │
// │                                                                      │
// │ Aynan shu sabab standart skilllar boshidanoq katalogdan o'tkaziladi: │
// │ keyinchalik "alohida mexanizmdan katalogga ko'chirish" degan og'riq  │
// │ bo'lmasin.                                                           │
// └──────────────────────────────────────────────────────────────────────┘

import { skillFayliniTahlil } from '@platforma/ai'
import type { Skill } from '@platforma/shared'
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Katalogdagi manba `url` maydoni — UI'da shu ko'rsatiladi */
export const STANDART_MANBA_URL = 'platforma://standart'

/**
 * Manba yozuvining `owner`/`repo` qiymatlari.
 *
 * `manbaYarat` takrorlanishni aynan shu uchlik (`owner`+`repo`+`ref`)
 * bo'yicha aniqlaydi, shuning uchun ular BARQAROR bo'lishi shart —
 * aks holda har ishga tushishda yangi manba yaratilardi.
 */
export const STANDART_OWNER = 'platforma'
export const STANDART_REPO = 'standart-skilllar'

/**
 * Standart skilllar turadigan papka (repo ichida).
 *
 * `platform-server/src/...` → ikki qavat yuqori → monorepo ildizi.
 */
export function standartSkillPapkasi(): string {
  return join(dirname(dirname(import.meta.dir)), 'skills')
}

export interface StandartSkanerNatija {
  skilllar: Omit<Skill, 'id' | 'manbaId' | 'ornatilgan'>[]
  ogohlantirishlar: string[]
}

/**
 * Lokal `skills/` papkasini skanerlaydi.
 *
 * `manbaniSkanerla` (GitHub) bilan BIR XIL shaklda natija qaytaradi —
 * chaqiruvchi ikkalasini farqlamaydi. Repo ochilganda bu funksiya
 * o'rniga GitHub varianti qo'yiladi, xolos.
 *
 * XATO TASHLAMAYDI: papka yo'q yoki fayl o'qilmasa bo'sh ro'yxat qaytadi.
 * Standart skilllarsiz ham platforma to'liq ishlaydi.
 */
export function standartlarniSkanerla(): StandartSkanerNatija {
  const ildiz = standartSkillPapkasi()
  const ogohlantirishlar: string[] = []
  const skilllar: StandartSkanerNatija['skilllar'] = []

  let papkalar: string[]
  try {
    papkalar = readdirSync(ildiz)
  } catch {
    return { skilllar, ogohlantirishlar }
  }

  for (const papka of papkalar.sort()) {
    const skillMd = join(ildiz, papka, 'SKILL.md')
    try {
      if (!statSync(join(ildiz, papka)).isDirectory() || !existsSync(skillMd)) continue
    } catch {
      continue
    }

    let xom: string
    try {
      xom = readFileSync(skillMd, 'utf8')
    } catch {
      // Bitta fayl o'qilmasa qolganini yo'qotmaymiz (GitHub skanerida ham
      // shunday qoida).
      continue
    }

    const tahlil = skillFayliniTahlil(xom, papka)
    if (!tahlil) {
      ogohlantirishlar.push(`${papka}: no description — skipped`)
      continue
    }

    skilllar.push({
      // Yo'l GitHub varianti bilan bir xil shaklda: `<papka>/SKILL.md`.
      // Manba GitHub'ga ko'chganda yo'llar mos tushadi va katalogdagi
      // yozuvlar (demak o'rnatishlar ham) saqlanib qoladi.
      yol: `${papka}/SKILL.md`,
      nom: tahlil.nom,
      tavsif: tahlil.tavsif,
      litsenziya: tahlil.litsenziya,
      allowedTools: tahlil.allowedTools,
      ogohlantirishlar: tahlil.ogohlantirishlar,
    })
  }

  return { skilllar, ogohlantirishlar }
}

/**
 * Standart manbani katalogga yozadi/yangilaydi.
 *
 * HAR ISHGA TUSHISHDA chaqiriladi (seed'dan farqli — u faqat bo'sh
 * bazaga yozadi). Sabab: platforma yangilanganda standart skilllar ham
 * yangilanadi — yangisi qo'shilishi, tavsifi o'zgarishi mumkin.
 *
 * `manbaYarat` va `skilllarniSinxronla` ikkalasi ham idempotent:
 * manba `owner`+`repo`+`ref` bo'yicha topiladi, skilllar esa
 * `manba_id`+`yol` bo'yicha UPSERT qilinadi. Ya'ni takroriy chaqiruv
 * dublikat yaratmaydi va MAVJUD O'RNATISHLARNI saqlaydi.
 *
 * XATO TASHLAMAYDI: katalogga yozib bo'lmasa platforma baribir ishga
 * tushadi, faqat standart skilllar do'konda ko'rinmaydi.
 */
export function standartManbaniTaminla(
  manbaYarat: (m: {
    tur: 'platforma'
    url: string
    owner: string
    repo: string
    ref: string
  }) => { id: string },
  skilllarniSinxronla: (
    manbaId: string,
    topilgan: Omit<Skill, 'id' | 'manbaId' | 'ornatilgan'>[],
    commitSha: string | null,
  ) => unknown,
): { manbaId: string; soni: number } | null {
  try {
    const skaner = standartlarniSkanerla()
    if (skaner.skilllar.length === 0) return null

    const manba = manbaYarat({
      tur: 'platforma',
      url: STANDART_MANBA_URL,
      owner: STANDART_OWNER,
      repo: STANDART_REPO,
      ref: '',
    })

    // `commitSha: null` — lokal papkada commit tushunchasi yo'q. Repo
    // GitHub'ga ko'chganda bu yerga haqiqiy SHA tushadi va "yangilanish
    // bormi?" tekshiruvi o'z-o'zidan ishlay boshlaydi.
    skilllarniSinxronla(manba.id, skaner.skilllar, null)

    return { manbaId: manba.id, soni: skaner.skilllar.length }
  } catch {
    return null
  }
}

/**
 * Standart skillni ombor papkasiga nusxalaydi.
 *
 * GitHub varianti tarball yuklab ochadi (`skillniOmborga`), bu esa
 * shunchaki papkani ko'chiradi — natija bir xil: ombordagi skill papkasi.
 *
 * `yol` — katalogdagi qiymat (`<papka>/SKILL.md`), undan papka nomi olinadi.
 */
export function standartniOmborga(yol: string, nishon: string): boolean {
  const papka = yol.includes('/') ? yol.split('/')[0]! : yol
  const manba = join(standartSkillPapkasi(), papka)

  try {
    if (!existsSync(manba)) return false
    cpSync(manba, nishon, { recursive: true, dereference: true })
    return true
  } catch {
    return false
  }
}

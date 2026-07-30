// Dashboard state'larini polling qiluvchi hook.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ HAR STATE O'Z INTERVALI BILAN.                                       │
// │                                                                      │
// │ Dashboarddagi qiymatlar bir xil tezlikda eskirmaydi: CPU 5 soniyada  │
// │ o'zgaradi, disk hajmi 60 soniyada ham deyarli o'zgarmaydi. Hammasini │
// │ bitta taymerga bog'lasak, eng tez yangilanadigani butun to'plamni    │
// │ qayta hisoblatardi — disk uchun `df` har 5 soniyada bejiz ishlardi.  │
// │                                                                      │
// │ Shuning uchun har state uchun ALOHIDA taymer quriladi.               │
// └──────────────────────────────────────────────────────────────────────┘
//
// TAB FONDA BO'LSA POLLING TO'XTAYDI (`visibilitychange`): foydalanuvchi
// boshqa oynada ishlayotganda `ssh` so'rovlarini davom ettirish isrof.
// Tab qaytganda darhol bir marta yangilanadi — eskirgan qiymat
// ko'rinmasin.
//
// YANGI ENDPOINT YO'Q: server allaqachon `/api/apps/:id/state/:nom` ni
// beradi, AI faqat uning ichidagi kodni yozadi.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppState } from '@platforma/shared'

/** Bitta state'ning mijozdagi holati */
export interface StateHolati {
  /** Oxirgi muvaffaqiyatli qiymat. Xato bo'lsa ESKISI saqlanadi. */
  qiymat?: unknown
  /** Oxirgi xato — qiymat baribir ko'rsatiladi, bu faqat belgi */
  xato?: string
  /** Hozir so'rov ketayaptimi */
  yuklanmoqda: boolean
  /** Oxirgi muvaffaqiyatli yangilanish (ISO) */
  vaqt?: string
}

export type StatelarXaritasi = Record<string, StateHolati>

/** Bitta state so'rovining natijasi — server shu shaklda qaytaradi */
export interface StateNatijaJavobi {
  ok: boolean
  qiymat?: unknown
  xato?: string
  vaqt: string
}

/**
 * Statelarni polling qiladi va qiymatlarni qaytaradi.
 *
 * `statelar` — manifestdagi ta'riflar. Har biri uchun alohida taymer
 * quriladi (`interval` soniyada).
 */
export interface IlovaStatelari {
  qiymatlar: Record<string, unknown>
  holatlar: StatelarXaritasi
  /** Hamma stateni majburan qayta o'qiydi */
  yangila: () => void
  /** Tashqaridan kelgan natijalarni qo'yadi — qayta so'rovsiz */
  natijalarniQoy: (natijalar: Record<string, StateNatijaJavobi>) => void
}

export function useIlovaStatelari(
  appId: string,
  statelar: AppState[] | undefined,
): IlovaStatelari {
  const [holatlar, setHolatlar] = useState<StatelarXaritasi>({})

  // Statelar ro'yxatini barqaror kalitga aylantiramiz: manifest har
  // renderda yangi obyekt bo'lsa ham, MAZMUNI o'zgarmaguncha taymerlar
  // qayta qurilmasin.
  const kalit = JSON.stringify(
    (statelar ?? []).map((s) => [s.nom, s.interval ?? 0]),
  )

  // `statelar` ni ref'da saqlaymiz — effekt uni bog'liqlik sifatida
  // olmasin (yuqoridagi `kalit` yetarli).
  const statelarRef = useRef(statelar)
  statelarRef.current = statelar

  const oqi = useCallback(
    async (nom: string, majburiy = false) => {
      setHolatlar((o) => ({ ...o, [nom]: { ...o[nom], yuklanmoqda: true } }))
      try {
        const javob = await fetch(
          `/api/apps/${encodeURIComponent(appId)}/state/${encodeURIComponent(nom)}` +
            (majburiy ? '?majburiy=1' : ''),
        )
        if (!javob.ok) throw new Error(`HTTP ${javob.status}`)
        const n = (await javob.json()) as StateNatijaJavobi

        setHolatlar((o) => ({
          ...o,
          [nom]: n.ok
            ? { qiymat: n.qiymat, yuklanmoqda: false, vaqt: n.vaqt }
            : // XATO BO'LSA ESKI QIYMAT SAQLANADI: bir marta yiqilgan
              // `ssh` uchun dashboardni bo'shatib qo'yish noto'g'ri —
              // eskirgan qiymat hech qanday qiymatdan yaxshiroq.
              { ...o[nom], xato: n.xato, yuklanmoqda: false },
        }))
      } catch (xato) {
        setHolatlar((o) => ({
          ...o,
          [nom]: {
            ...o[nom],
            xato: xato instanceof Error ? xato.message : String(xato),
            yuklanmoqda: false,
          },
        }))
      }
    },
    [appId],
  )

  useEffect(() => {
    const royxat = statelarRef.current ?? []
    if (royxat.length === 0) return

    let tirik = true
    const taymerlar: ReturnType<typeof setInterval>[] = []

    // Birinchi o'qish darhol — sahifa bo'sh turmasin.
    for (const s of royxat) void oqi(s.nom)

    function taymerlarniQur() {
      for (const s of royxat) {
        const soniya = s.interval ?? 0
        // `interval` yo'q — qiymat o'zgarmaydi, taymer ham kerak emas.
        if (soniya <= 0) continue
        taymerlar.push(
          setInterval(() => {
            if (tirik) void oqi(s.nom)
          }, soniya * 1000),
        )
      }
    }

    function taymerlarniTozala() {
      while (taymerlar.length) clearInterval(taymerlar.pop()!)
    }

    if (document.visibilityState === 'visible') taymerlarniQur()

    // Tab fonda bo'lsa polling to'xtaydi, qaytganda darhol yangilanadi.
    function korinishOzgardi() {
      if (document.visibilityState === 'visible') {
        for (const s of royxat) void oqi(s.nom)
        taymerlarniQur()
      } else {
        taymerlarniTozala()
      }
    }

    document.addEventListener('visibilitychange', korinishOzgardi)

    return () => {
      tirik = false
      taymerlarniTozala()
      document.removeEventListener('visibilitychange', korinishOzgardi)
    }
  }, [appId, kalit, oqi])

  /** Hamma stateni majburan yangilaydi ("yangilash" tugmasi uchun) */
  const yangila = useCallback(() => {
    for (const s of statelarRef.current ?? []) void oqi(s.nom, true)
  }, [oqi])

  /**
   * Tashqaridan kelgan natijalarni qo'yadi — QAYTA SO'ROVSIZ.
   *
   * Amal bajarilganda server `yangila` da ko'rsatilgan statelarni allaqachon
   * qayta hisoblab javobda qaytaradi (`routes/apps.ts`). Ularni shu yerga
   * berish ikkinchi HTTP so'rovni butunlay chetlab o'tadi — ya'ni restart
   * bosilgandan keyin status DARHOL yangilanadi va `ssh` ikki marta
   * chaqirilmaydi.
   */
  const natijalarniQoy = useCallback(
    (natijalar: Record<string, StateNatijaJavobi>) => {
      setHolatlar((o) => {
        const yangi = { ...o }
        for (const [nom, n] of Object.entries(natijalar)) {
          yangi[nom] = n.ok
            ? { qiymat: n.qiymat, yuklanmoqda: false, vaqt: n.vaqt }
            : // Polling bilan bir xil qoida: xatoda eski qiymat saqlanadi.
              { ...o[nom], xato: n.xato, yuklanmoqda: false }
        }
        return yangi
      })
    },
    [],
  )

  const qiymatlar: Record<string, unknown> = {}
  for (const [nom, h] of Object.entries(holatlar)) {
    if (h.qiymat !== undefined) qiymatlar[nom] = h.qiymat
  }

  return { qiymatlar, holatlar, yangila, natijalarniQoy }
}

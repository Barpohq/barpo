// Fonda ishlayotgan agent oqimlarini kuzatuvchi hook.
//
// Ikki manbadan yig'iladi va ikkalasi ham kerak:
//   1) GET /api/chat/running — sahifa ochilgandagi boshlang'ich holat.
//      Faqat WS'ga tayansak, sahifa oqim O'RTASIDA ochilganda hech narsa
//      ko'rinmasdi: boshlanish eventi allaqachon o'tib ketgan bo'lardi.
//   2) `chat.status` eventlari — keyingi o'zgarishlar jonli keladi.
//
// `chat.status` ataylab sessiya bo'yicha filtrlanmaydi (protocol.ts dagi
// `eventSessiyasi()` ga q.), shuning uchun bitta suhbatni ochgan mijoz ham
// hamma sessiyalarning holatini oladi — sidebar aynan shunga tayanadi.

import { useEffect, useState } from 'react'
import type { OqimHolati } from '@platforma/shared'
import { ishlayotganlarniOl } from './api'
import { ws } from './ws'

/** Sessiya id → hozirgi holati. Tugagan sessiya map'dan chiqariladi. */
export type IshlayotganlarXaritasi = Record<string, 'ishlayapti' | 'ruxsat-kutmoqda'>

/** Sessiya sarlavhalari — boshlang'ich ro'yxatdan keladi */
export type SarlavhalarXaritasi = Record<string, string>

export interface IshlayotganlarHolati {
  /** Hozir oqim ketayotgan sessiyalar */
  ishlayotganlar: IshlayotganlarXaritasi
  /** Ma'lum sarlavhalar — Agentlar sahifasi id o'rniga shuni ko'rsatadi */
  sarlavhalar: SarlavhalarXaritasi
  /** Boshlang'ich ro'yxat hali yuklanmoqdami */
  yuklanmoqda: boolean
}

/**
 * Faol holatmi — ya'ni sessiya ro'yxatda qolishi kerakmi.
 *
 * Tip guard sifatida yozilgan: `tugadi`/`xato` da sessiya ro'yxatdan
 * chiqariladi, shuning uchun xaritaga faqat qolgan ikki qiymat tushadi.
 */
function faolmi(holat: OqimHolati): holat is 'ishlayapti' | 'ruxsat-kutmoqda' {
  return holat === 'ishlayapti' || holat === 'ruxsat-kutmoqda'
}

export function useIshlayotganlar(): IshlayotganlarHolati {
  const [ishlayotganlar, setIshlayotganlar] = useState<IshlayotganlarXaritasi>({})
  const [sarlavhalar, setSarlavhalar] = useState<SarlavhalarXaritasi>({})
  const [yuklanmoqda, setYuklanmoqda] = useState(true)

  useEffect(() => {
    let bekor = false

    ws.ulan()
    const obunaBekor = ws.obuna(['chat'])
    const kuzatBekor = ws.kuzat((event) => {
      if (event.type !== 'chat.status') return
      const holat = event.holat
      const sessionId = event.sessionId
      setIshlayotganlar((oldingi) => {
        if (!faolmi(holat)) {
          if (!(sessionId in oldingi)) return oldingi
          const { [sessionId]: _olib, ...qolgan } = oldingi
          return qolgan
        }
        if (oldingi[sessionId] === holat) return oldingi
        return { ...oldingi, [sessionId]: holat }
      })
    })

    // Boshlang'ich ro'yxat WS obunasidan KEYIN so'raladi: teskarisi bo'lsa
    // so'rov va obuna orasida kelgan event yo'qolib, sessiya "ishlayapti"
    // holatida qotib qolardi.
    ishlayotganlarniOl()
      .then((royxat) => {
        if (bekor) return
        setIshlayotganlar((oldingi) => {
          // WS'dan kelgan yangiroq ma'lumot ustun: boshlang'ich ro'yxat
          // so'rov yuborilgan paytdagi holat, u eskirgan bo'lishi mumkin.
          const boshlangich: IshlayotganlarXaritasi = {}
          for (const s of royxat) boshlangich[s.sessionId] = s.holat
          return { ...boshlangich, ...oldingi }
        })
        setSarlavhalar((oldingi) => {
          const yangi = { ...oldingi }
          for (const s of royxat) if (s.title) yangi[s.sessionId] = s.title
          return yangi
        })
      })
      .catch(() => {
        // Server yetib bo'lmasa indikatorlar shunchaki ko'rinmaydi —
        // bu qo'shimcha ko'rsatkich, uning uchun xato ko'rsatish ortiqcha
      })
      .finally(() => {
        if (!bekor) setYuklanmoqda(false)
      })

    return () => {
      bekor = true
      obunaBekor()
      kuzatBekor()
    }
  }, [])

  return { ishlayotganlar, sarlavhalar, yuklanmoqda }
}

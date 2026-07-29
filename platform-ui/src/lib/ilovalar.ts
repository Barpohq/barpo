// Sidebar'dagi ilovalar (dinamik dashboardlar) ro'yxatini kuzatuvchi hook.
//
// Ikki manbadan yig'iladi va ikkalasi ham kerak (`ishlayotganlar.ts` dagi
// bilan bir xil sabab):
//   1) GET /api/apps — sahifa ochilgandagi holat. Faqat WS'ga tayansak,
//      refresh'dan keyin ro'yxat BO'SH bo'lardi: `app.installed` eventi
//      allaqachon o'tib ketgan.
//   2) `app.installed` / `app.updated` — agent yangi dashboard chiqarganda
//      sidebar darhol yangilanadi, foydalanuvchi refresh qilmasin.
//
// AVVAL BU YO'Q EDI: sidebar mock ro'yxatdan (`installedApps`) qurilardi va
// serverdan umuman o'qimasdi. Natijada `appPublish` bazaga yozsa ham
// dashboard hech qachon ko'rinmasdi — refresh ham yordam bermasdi.

import { useEffect, useState } from 'react'
import { CHANNELS, type AppManifest } from '@platforma/shared'
import { ilovalarOl } from './api'
import { ws } from './ws'

export interface IlovalarHolati {
  ilovalar: AppManifest[]
  /** Boshlang'ich ro'yxat hali yuklanmoqdami */
  yuklanmoqda: boolean
}

/** Manifestni ro'yxatga qo'shadi yoki mavjudini almashtiradi */
function birlashtir(royxat: AppManifest[], yangi: AppManifest): AppManifest[] {
  const indeks = royxat.findIndex((a) => a.id === yangi.id)
  if (indeks === -1) return [...royxat, yangi]
  const nusxa = [...royxat]
  nusxa[indeks] = yangi
  return nusxa
}

export function useIlovalar(): IlovalarHolati {
  const [ilovalar, setIlovalar] = useState<AppManifest[]>([])
  const [yuklanmoqda, setYuklanmoqda] = useState(true)

  useEffect(() => {
    let bekor = false

    ws.ulan()
    const obunaBekor = ws.obuna([CHANNELS.apps])
    const kuzatBekor = ws.kuzat((event) => {
      if (event.type !== 'app.installed' && event.type !== 'app.updated') return
      setIlovalar((oldingi) => birlashtir(oldingi, event.manifest))
    })

    // Boshlang'ich ro'yxat WS obunasidan KEYIN so'raladi: teskarisi bo'lsa
    // so'rov va obuna orasida chiqarilgan dashboard yo'qolib ketardi.
    ilovalarOl()
      .then((royxat) => {
        if (bekor) return
        setIlovalar((oldingi) => {
          // WS'dan kelgan yangiroq manifest USTUN: so'rov ketayotganda
          // yangilangan bo'lishi mumkin, uni eski nusxa bilan bosmaymiz.
          const yangilar = new Set(oldingi.map((a) => a.id))
          return [...oldingi, ...royxat.filter((a) => !yangilar.has(a.id))]
        })
      })
      .catch(() => {
        // Ro'yxat kelmasa sidebar bo'sh qoladi — bu platformani
        // yiqitadigan holat emas, WS orqali keyin to'lishi mumkin.
      })
      .finally(() => {
        if (!bekor) setYuklanmoqda(false)
      })

    return () => {
      bekor = true
      kuzatBekor()
      obunaBekor()
    }
  }, [])

  return { ilovalar, yuklanmoqda }
}

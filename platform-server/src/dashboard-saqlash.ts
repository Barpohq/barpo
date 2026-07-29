// `appPublish` tool'i bilan baza o'rtasidagi halqa.
//
// `platform-ai` bazani BILMAYDI (inversiya — `dashboard-toollari.ts` ga q.),
// shuning uchun agent tool'iga shu moduldagi funksiya beriladi. Bu yerda
// uch narsa ketma-ket bajariladi:
//
//   1. TEKSHIRUV   — manifest shakli (`manifestniTekshir`)
//   2. KOMPILYATSIYA — JSX bo'lsa (`viewniQur`)
//   3. SAQLASH     — bazaga upsert (`ilovaSaqla`)
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ XATO IZOLYATSIYASINING ASOSIY QARORI SHU YERDA.                      │
// │                                                                      │
// │ Kod kompilyatsiya qilinmasa, manifest RAD ETILMAYDI — u `view`SIZ    │
// │ saqlanadi va vidjetlar avvalgidek ishlaydi. Ya'ni AI kodidagi xato   │
// │ dashboardni butunlay yo'qotmaydi, faqat maxsus ko'rinishni o'chiradi.│
// │                                                                      │
// │ Buning sharti bor: vidjetlar bo'lishi kerak. Vidjetsiz manifestda    │
// │ kod yiqilsa ko'rsatadigan hech narsa qolmaydi — u holda rad etamiz   │
// │ va AI xatoni ko'rib tuzatadi.                                        │
// └──────────────────────────────────────────────────────────────────────┘

import type { DashboardNatijasi } from '@platforma/ai'
import { manifestniTekshir } from '@platforma/shared'
import type { Database } from 'bun:sqlite'
import { ilovaSaqla } from './repo.ts'
import { kodniTekshir } from './state-bajar.ts'
import { ilovaKeshiniTozala } from './state-kesh.ts'
import { viewniQur } from './view-qurish.ts'
import { hub } from './ws/hub.ts'

/**
 * Manifestni tekshiradi, kodni quradi va saqlaydi.
 *
 * XATO TASHLAMAYDI — natija `DashboardNatijasi` bo'lib qaytadi va
 * `appPublish` uni model o'qiydigan matnga aylantiradi.
 */
export async function dashboardniSaqla(
  xom: unknown,
  baza?: Database,
): Promise<DashboardNatijasi> {
  const tekshiruv = manifestniTekshir(xom)
  if (!tekshiruv.ok || !tekshiruv.qiymat) {
    return { ok: false, xatolar: tekshiruv.xatolar }
  }

  const manifest = tekshiruv.qiymat
  const ogohlantirishlar = [...tekshiruv.ogohlantirishlar]

  // State kodlari SINTAKSIS bo'yicha shu yerda tekshiriladi — xato
  // birinchi pollingda emas, publish paytida bilinsin va AI o'zi
  // tuzatsin. Yaroqsizi TASHLANADI, qolgani ishlayveradi.
  //
  // KEYINGI BOSQICH: shu yerga prompt injection klassifikatori ulanadi
  // (`state-bajar.ts` dagi `kodniTekshir()` ga q.).
  if (manifest.states?.length) {
    const yaroqli = manifest.states.filter((s) => {
      const xatolar = kodniTekshir(s.kod)
      if (xatolar.length === 0) return true
      ogohlantirishlar.push(`State "${s.nom}" tashlandi: ${xatolar.join('; ')}`)
      return false
    })
    if (yaroqli.length > 0) manifest.states = yaroqli
    else delete manifest.states
  }

  if (manifest.view) {
    const qurish = await viewniQur(manifest.view.kod)

    if (qurish.ok && qurish.kod) {
      // Manifestda KOMPILYATSIYA QILINGAN kod saqlanadi: brauzerga
      // transform yuki tushmasin va har ochilishda qayta qurilmasin.
      manifest.view = { kod: qurish.kod, xash: qurish.xash ?? '' }
    } else if (manifest.widgets.length > 0) {
      // Ko'rsatadigan boshqa narsa BOR — ilovani yo'qotmaymiz.
      delete manifest.view
      ogohlantirishlar.push(
        'Ko\'rinish kodi kompilyatsiya qilinmadi va TASHLANDI (vidjetlar saqlandi): ' +
          qurish.xatolar.join('; '),
      )
    } else {
      // Ko'rsatadigan hech narsa qolmaydi — rad etamiz, aks holda
      // foydalanuvchi bo'sh sahifa ko'rardi.
      return {
        ok: false,
        xatolar: [
          ...qurish.xatolar,
          'Vidjet ham berilmagan, shuning uchun ko\'rsatadigan narsa qolmadi.',
        ],
      }
    }
  }

  try {
    const { yangi } = ilovaSaqla(manifest, baza)

    // Kod o'zgargan bo'lishi mumkin — eski natijalar ishlatilmasin.
    // (Kesh kod xashini ham tekshiradi, lekin bu yerda tozalash
    // qayta publish'dan keyin BIRINCHI so'rovni ham yangilaydi.)
    ilovaKeshiniTozala(manifest.id)

    // UI'ga darhol xabar beramiz — foydalanuvchi sahifani yangilamasin.
    // Xato bo'lsa YUTILADI: dashboard baribir saqlangan va refresh'da
    // ko'rinadi, shuning uchun WS muammosi uchun tool'ni yiqitish
    // noto'g'ri bo'lardi.
    try {
      hub.broadcast({ type: yangi ? 'app.installed' : 'app.updated', manifest })
    } catch {
      // WS xatosi saqlashni bekor qilmaydi
    }

    return {
      ok: true,
      yangi,
      ...(ogohlantirishlar.length > 0 ? { ogohlantirishlar } : {}),
    }
  } catch (xato) {
    // Baza xatosi (disk to'lgan, qulflangan) — agentga aytamiz, lekin
    // jarayonni yiqitmaymiz.
    return { ok: false, xatolar: [`Bazaga saqlab bo'lmadi: ${String(xato)}`] }
  }
}

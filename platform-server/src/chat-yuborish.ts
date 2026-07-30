// Xabar yuborishning UMUMIY mantiqi — REST va WS ikkalasi ham shu yerdan
// o'tadi.
//
// NEGA AJRATILGAN. Ilgari `routes/chat.ts` (`POST /chat/send`) va
// `ws/chat-handler.ts` bir xil ishni MUSTAQIL bajarardi: model qulfini
// tekshirish, provider almashtirishni rad etish, oqim borligini ko'rish.
// Ikki nusxa bir-biridan uzoqlashishga mahkum — biri tuzatilib ikkinchisi
// unutiladi, natijada bir yo'l bilan yuborilgan xabar boshqasi rad etadigan
// holatga tushardi. Biriktirmalar bilan uchinchi tekshiruv qo'shildi va
// takrorlashni davom ettirish ma'nosiz bo'ldi.
//
// Bu modul HTTP ni ham, WS ni ham bilmaydi: natija sifatida `status` beradi,
// chaqiruvchi uni o'z tilida ifodalaydi (REST — HTTP kodi, WS — `chat.error`).

import { keshdagiNatija } from '@platforma/ai'
import type { ChatBiriktirma, ModelTanlovi } from '@platforma/shared'
import { config } from '@platforma/config'
import { sessiyaIshPapkasi } from './ish-papkasi.ts'
import { oqimBormi } from './orchestrator.ts'
import {
  biriktirmalarniOl,
  biriktirmalarniXabargaBogla,
  sessiyaLoyihaPapkasi,
  sessiyaModelniOzgart,
  sessiyaModelQulfla,
  sessiyaOqi,
  xabarYoz,
} from './repo.ts'

export interface YuborishSorovi {
  sessionId: string
  matn: string
  /** Tanlangan model — birinchi xabarda majburiy */
  tanlangan?: ModelTanlovi
  /** Biriktirma id'lari (obyekt emas — yo'lni mijoz bermaydi) */
  biriktirmalar?: string[]
}

export type YuborishNatijasi =
  | {
      ok: true
      messageId: string
      tanlov: ModelTanlovi
      biriktirmalar: ChatBiriktirma[]
    }
  | { ok: false; status: 400 | 404 | 409 | 500; xato: string; tafsilot?: string }

/**
 * Xabarni qabul qiladi: tekshiradi, modelni qulflaydi, bazaga yozadi va
 * biriktirmalarni xabarga bog'laydi.
 *
 * OQIMNI O'ZI BOSHLAMAYDI — chaqiruvchi `javobOqizi` ni chaqiradi. Sabab:
 * REST fonda boshlab 202 qaytaradi, WS esa kutadi. Bu farq shu modulga
 * kirmasligi kerak.
 *
 * TARTIB MUHIM: hamma tekshiruv `xabarYoz` dan OLDIN. Xabar yozilib keyin
 * rad etilsa, bazada javob kutmaydigan yetim user xabari qolardi.
 */
export function xabarniQabulQil(sorov: YuborishSorovi): YuborishNatijasi {
  const matn = sorov.matn.trim()
  const biriktirmaIdlari = sorov.biriktirmalar ?? []

  // Matnsiz xabar FAQAT biriktirma bo'lsa ruxsat etiladi: foydalanuvchi
  // rasm tashlab, hech narsa yozmasligi tabiiy holat ("bu nima?" degani
  // rasmning o'zidan ham tushunarli).
  if (!matn && biriktirmaIdlari.length === 0) {
    return { ok: false, status: 400, xato: "Xabar matni bo'sh bo'lmasligi kerak" }
  }

  const sessiya = sessiyaOqi(sorov.sessionId)
  if (!sessiya) return { ok: false, status: 404, xato: 'Sessiya topilmadi' }

  if (oqimBormi(sorov.sessionId)) {
    return {
      ok: false,
      status: 409,
      xato: 'Bu sessiyada javob hali oqmoqda',
      tafsilot: "Avval kutib turing yoki to'xtating",
    }
  }

  // --- Model tanlovi va provider qulfi ---
  if (!sessiya.provider) {
    if (!sorov.tanlangan?.provider || !sorov.tanlangan.model) {
      return {
        ok: false,
        status: 400,
        xato: 'Model tanlanmagan',
        tafsilot: "Sessiyaning birinchi xabarida model: { provider, model } yuborilishi kerak",
      }
    }
    sessiyaModelQulfla(sorov.sessionId, sorov.tanlangan.provider, sorov.tanlangan.model)
  } else if (sorov.tanlangan?.provider && sorov.tanlangan.provider !== sessiya.provider) {
    return {
      ok: false,
      status: 409,
      xato: "Sessiya provideri o'zgartirib bo'lmaydi",
      tafsilot: `Sessiya "${sessiya.provider}" provideriga bog'langan. Boshqa provider uchun yangi suhbat boshlang.`,
    }
  } else if (sorov.tanlangan?.model && sorov.tanlangan.model !== sessiya.model) {
    // Bir provider ichida modelni almashtirish mumkin
    sessiyaModelniOzgart(sorov.sessionId, sorov.tanlangan.model)
  }

  const yangilangan = sessiyaOqi(sorov.sessionId)
  if (!yangilangan?.provider || !yangilangan.model) {
    return { ok: false, status: 500, xato: 'Sessiya modeli aniqlanmadi' }
  }

  // --- Biriktirmalar ---
  const biriktirmalar = biriktirmalarniOl(sorov.sessionId, biriktirmaIdlari)
  if (biriktirmalar.length !== biriktirmaIdlari.length) {
    // Yetmasligi ikki sababdan bo'ladi va ikkalasi ham mijoz xatosi:
    // id yo'q (o'chirilgan / muddati o'tgan) yoki boshqa sessiyaga tegishli.
    // Ikkalasini ajratmaymiz — "boshqa sessiyada bor" javobi o'zi ma'lumot
    // sizishi bo'lardi.
    return {
      ok: false,
      status: 404,
      xato: 'Biriktirma topilmadi',
      tafsilot: "Yuklama o'chirilgan yoki boshqa suhbatga tegishli",
    }
  }

  const chegara = biriktirmaChegarasi(sorov.sessionId)
  if (biriktirmalar.length > chegara) {
    return {
      ok: false,
      status: 400,
      xato: 'Biriktirmalar soni chegarasidan oshdi',
      tafsilot: `Eng ko'pi ${chegara} ta`,
    }
  }

  // VISION QOROVULI. Bu yagona to'g'ri nuqta: model AYNAN shu yerda
  // qulflanadi/almashtiriladi, ya'ni faqat hozir aniq ma'lum. Yuklash
  // paytida foydalanuvchi hali modelni o'zgartirishi mumkin edi.
  //
  // Nega 400, jimgina o'tkazib yuborish emas: agent rasmni `read` bilan
  // o'qiydi, provider esa rasm blokini tashlab ketadi (yoki xato beradi) va
  // agent "rasmda hech narsa yo'q" degan XATO XULOSAGA keladi. Foydalanuvchi
  // buni sezmaydi — eng yomon nosozlik turi.
  if (biriktirmalar.some((b) => b.tur === 'rasm')) {
    const model = modelniTop(yangilangan.provider, yangilangan.model)
    if (model && !model.vision) {
      return {
        ok: false,
        status: 400,
        xato: "Bu model rasmni qo'llamaydi",
        tafsilot: `${model.name} faqat matn bilan ishlaydi. Vision qo'llaydigan model tanlang yoki rasmni olib tashlang.`,
      }
    }
  }

  // --- Yozish ---
  const xabar = xabarYoz({ sessionId: sorov.sessionId, role: 'user', text: matn })
  if (biriktirmaIdlari.length > 0) {
    biriktirmalarniXabargaBogla(sorov.sessionId, xabar.id, biriktirmaIdlari)
  }

  return {
    ok: true,
    messageId: crypto.randomUUID(),
    tanlov: { provider: yangilangan.provider, model: yangilangan.model },
    biriktirmalar,
  }
}

/**
 * Model keshidan `vision` bayrog'ini oladi.
 *
 * Kesh bo'sh bo'lsa (server endi ko'tarilgan, hech kim `/api/models` ni
 * so'ramagan) `undefined` qaytadi va qorovul O'TKAZIB YUBORADI. Ataylab:
 * `await modellarniAniqla()` bu yo'lni sekinlashtirardi (u tarmoqqa chiqadi),
 * noaniqlikda esa taqiqlash foydalanuvchini ishlaydigan holatda ham
 * to'sib qo'yardi. Provider baribir o'z xatosini beradi va u `chat.error`
 * bo'lib ko'rinadi.
 */
function modelniTop(provider: string, model: string) {
  return keshdagiNatija()?.models.find((m) => m.provider === provider && m.id === model)
}

/** Sessiya config'idagi biriktirma soni chegarasi */
function biriktirmaChegarasi(sessionId: string): number {
  const papka = sessiyaIshPapkasi(sessionId, sessiyaLoyihaPapkasi(sessionId))
  return config({ ishPapkasi: papka }).config.chat.biriktirma.maksSoni
}

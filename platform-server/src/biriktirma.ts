// Biriktirilgan faylning turini MAZMUNIGA qarab aniqlaydi.
//
// NEGA KENGAYTMAGA ISHONMAYMIZ. Mijoz `File.type` ni ham, nomni ham o'zi
// beradi — ikkalasi soxtalashtirilishi mumkin. Tur esa ikki joyda ishlatiladi
// va ikkalasida ham xato qimmatga tushadi:
//
//   1) `GET /api/chat/biriktirma/:id` javobining `content-type` i. Fayl
//      `text/html` deb e'lon qilinsa brauzer uni SAHIFA sifatida ochadi —
//      ya'ni saqlangan XSS. Shu sababli faqat MAZMUNDAN aniqlangan rasm
//      haqiqiy mime bilan beriladi, qolgani `application/octet-stream`.
//
//   2) Promptdagi eslatma ("rasm biriktirdi" / "fayl biriktirdi") va vision
//      qorovuli. `.png` deb atalgan ZIP rasm deb hisoblansa, vision'siz
//      model bilan xabar bekordan-bekor 400 bo'lardi.
//
// pi ham aynan shunday qiladi (`pi-coding-agent/dist/utils/mime.js`): faqat
// signatura, faqat boshidagi bir necha kilobayt. Bu yerda ham butun fayl
// tekshirilmaydi — signatura eng ko'pi 12 baytda tugaydi.
//
// SVG ATAYLAB YO'Q. U XML, ya'ni `<script>` tashish vositasi bo'la oladi va
// providerlar ham uni inline rasm sifatida qabul qilmaydi. SVG biriktirilsa
// oddiy fayl bo'lib tushadi — agent uni `read` bilan matn sifatida o'qiy
// oladi, brauzer esa `attachment` bilan yuklab beradi, ochmaydi.

/** LLM ham, brauzer ham qo'llaydigan rasm turlari */
export type RasmMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

/** Signatura tekshiruvi uchun yetarli bayt — undan ko'pi o'qilmaydi */
export const SIGNATURA_BAYTLARI = 16

/**
 * Baytlar rasm bo'lsa uning mime turini, aks holda `null` qaytaradi.
 *
 * `null` — "bu rasm emas", "buzuq fayl" degani EMAS: chaqiruvchi uni oddiy
 * fayl deb qabul qiladi va hech narsa rad etilmaydi.
 */
export function rasmTuri(bayt: Uint8Array): RasmMime | null {
  if (boshlanadimi(bayt, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'

  // JPEG: `FF D8 FF` + to'rtinchi bayt marker. `FF D8 FF F7` — JPEG-LS,
  // providerlar uni qo'llamaydi, shuning uchun rasm deb hisoblanmaydi.
  if (boshlanadimi(bayt, [0xff, 0xd8, 0xff])) {
    return bayt[3] === 0xf7 ? null : 'image/jpeg'
  }

  // GIF87a va GIF89a — ikkalasi ham `GIF8` bilan boshlanadi
  if (boshlanadimi(bayt, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'

  // WEBP: RIFF konteyneri, tur 8-11 baytda. Faqat `RIFF` ni tekshirish
  // yetarli emas — WAV va AVI ham RIFF.
  if (
    boshlanadimi(bayt, [0x52, 0x49, 0x46, 0x46]) &&
    boshlanadimi(bayt, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'image/webp'
  }

  return null
}

/** Rasm mime turidan fayl kengaytmasi — nomi bo'sh kelgan paste uchun */
export function rasmKengaytmasi(mime: RasmMime): string {
  switch (mime) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
  }
}

function boshlanadimi(bayt: Uint8Array, imzo: number[], offset = 0): boolean {
  if (bayt.length < offset + imzo.length) return false
  for (let i = 0; i < imzo.length; i += 1) {
    if (bayt[offset + i] !== imzo[i]) return false
  }
  return true
}

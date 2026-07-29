// AI yozgan JSX ko'rinishini brauzer tushunadigan JS'ga aylantiradi.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ NEGA KOMPILYATSIYA SERVERDA. Ikki sabab:                             │
// │                                                                      │
// │  1) XATONI ERTA USHLASH. AI sintaksis xatosi bilan kod yozsa, u      │
// │     `appPublish` javobida DARHOL bilinadi va model o'zi tuzatadi.    │
// │     Brauzerda kompilyatsiya qilinsa, xato foydalanuvchi sahifani     │
// │     ochganda — ancha kech — chiqardi.                                │
// │                                                                      │
// │  2) BRAUZERGA TRANSFORM YUKI TUSHMASIN. Aks holda har ochilishda     │
// │     Babel/SWC yuklab, JSX'ni qayta-qayta aylantirish kerak bo'lardi. │
// └──────────────────────────────────────────────────────────────────────┘
//
// KLASSIK JSX TRANSFORM (`React.createElement`) ATAYLAB TANLANGAN.
// Zamonaviy `automatic` runtime `react/jsx-runtime` dan IMPORT qo'shadi —
// sandbox ichida esa modul yuklovchi ham, tarmoq ham yo'q, ya'ni o'sha
// import hech qachon hal bo'lmasdi. Klassik transform faqat `React`
// globaliga tayanadi, uni sandbox HTML'i o'zi beradi.
//
// IMPORT UMUMAN TAQIQLANGAN. Har qanday `import`/`require` kompilyatsiya
// bosqichida XATO beradi — ya'ni AI tashqi paketga bog'lanolmaydi.
// Sabab: sandbox'da tarmoq yo'q, demak import qilingan modul baribir
// yuklanmasdi; xatoni shu yerda berish AI'ga aniq signal beradi.
//
// XATO IZOLYATSIYASI (foydalanuvchi talabi): kompilyatsiya muvaffaqiyatsiz
// bo'lsa manifest RAD ETILMAYDI — u `view`SIZ saqlanadi va vidjetlar
// avvalgidek ishlaydi. Ya'ni AI kodidagi xato butun dashboardni emas,
// faqat maxsus ko'rinishni o'chiradi.

/** Kompilyatsiya natijasi */
export interface QurishNatijasi {
  ok: boolean
  /** Muvaffaqiyatli bo'lsa — brauzerga beriladigan JS */
  kod?: string
  /** Manba kodining xashi — kesh va audit uchun */
  xash?: string
  /** Xato bo'lsa — AI o'qiydigan tushuntirish */
  xatolar: string[]
}

/**
 * Kompilyatsiya vaqti chegarasi (ms).
 *
 * `Bun.build` odatda millisekundlarda tugaydi. Chegara patologik holat
 * uchun: juda katta yoki g'alati tuzilgan kod qurilish jarayonini uzoq
 * ushlab, chat javobini qotirib qo'ymasin.
 */
export const QURISH_TIMEOUT_MS = 10_000

/**
 * Inline `<script>` ichiga joylashtiriladigan JS'ni xavfsiz qiladi.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ NEGA SHART. HTML tahlilchisi `<script>` blokini BIRINCHI uchragan  │
 * │ `</script` da yopadi — u JS satri ichida bo'lsa ham. Sandbox esa   │
 * │ butun kodni `srcdoc` ichiga inline joylashtiradi.                  │
 * │                                                                    │
 * │ Bu nazariy xavf emas: React'ning O'Z kodida shunday satr bor       │
 * │     Z.innerHTML = "<script></script>"                              │
 * │ va u tufayli brauzerda bundle yarmida uzilib, qolgani sahifa       │
 * │ MATNI bo'lib ko'ringan — `window.React` umuman aniqlanmagan.       │
 * │                                                                    │
 * │ AI kodida ham xuddi shunday satr bo'lishi mumkin, shuning uchun    │
 * │ himoya kod QURILAYOTGAN joyda turadi.                              │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * `<\/script` JS satrida `</script` bilan AYNAN bir xil qiymat beradi,
 * lekin HTML tahlilchisi uni yopilish deb hisoblamaydi.
 */
export function skriptgaXavfsiz(js: string): string {
  return js.replace(/<\/(script)/gi, '<\\/$1')
}

/**
 * Manba kodining qisqa xashi.
 *
 * Kriptografik maqsad YO'Q — bu faqat "kod o'zgardimi?" degan savolga
 * javob (brauzer keshini yangilash va auditda versiyani ajratish uchun).
 */
export function kodXashi(manba: string): string {
  return Bun.hash(manba).toString(16)
}

/**
 * Kodda taqiqlangan konstruksiyalar bor-yo'qligini tekshiradi.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ BU HIMOYA EMAS, ARXITEKTURA QOIDASI.                               │
 * │                                                                    │
 * │ Ko'rinish kodi HOST SAHIFADA ishlaydi (sandbox olib tashlangan —   │
 * │ `AiKorinish.tsx` ga q.), ya'ni `fetch` texnik jihatdan MUMKIN.     │
 * │ Lekin u ishlatilmasligi kerak: ma'lumot `states` orqali keladi     │
 * │ (`state-bajar.ts`), ko'rinish esa faqat CHIZADI.                   │
 * │                                                                    │
 * │ Sabab — bashoratlilik: `fetch` bilan yozilgan ko'rinishda          │
 * │ yangilanish oralig'ini platforma boshqara olmasdi, kesh ishlamasdi │
 * │ va bir nechta ochiq tab bir xil so'rovni takrorlardi. `states`     │
 * │ esa keshlanadi va interval bo'yicha aniq bir marta bajariladi.     │
 * │                                                                    │
 * │ Shuning uchun tekshiruv AI'ga TO'G'RI YO'LNI ko'rsatadi, xavfni    │
 * │ to'sib qo'ymaydi. Xavf qatlami — kelajakdagi klassifikator         │
 * │ (`state-bajar.ts` dagi `kodniTekshir()` bilan bir xil issue).      │
 * └────────────────────────────────────────────────────────────────────┘
 */
export function taqiqlanganlarniTop(manba: string): string[] {
  const xatolar: string[] = []

  const naqshlar: { naqsh: RegExp; xabar: string }[] = [
    {
      // Import shu yerda ushlanadi, bundlerga tashlab qo'yilmaydi.
      //
      // NEGA: Bun'ning plugin API'sida `onLoad` faqat `contents` qaytara
      // oladi — o'z xato matnimizni u orqali berib bo'lmaydi. Import'ni
      // bundlerga qoldirsak, model "onLoad plugins must return..." degan
      // ichki xabar olardi va nima qilishni tushunmasdi.
      //
      // `import` so'zi qator boshida qidiriladi: shunda matn ichidagi
      // ("bu importni ishlatmang" kabi) tasodifiy so'z ushlanmaydi.
      //
      // DINAMIK `import(...)` ALOHIDA ko'rsatilgan: bundler uni tashqi
      // bog'liqlik deb hisoblab, xatosiz o'tkazib yuboradi. U holda kod
      // brauzerda JIM yiqilardi va AI sababni bilmasdi.
      naqsh: /^\s*import\s|^\s*export\s+.*\bfrom\s|[^\w.]require\s*\(|[^\w.]import\s*\(/m,
      xabar:
        'Kodda `import`/`require` bor — ko\'rinish kodida ular ISHLAMAYDI ' +
        '(kod bundle qilinmaydi, paket yuklovchi yo\'q). React, hooklar va ' +
        'platforma komponentlari GLOBAL sifatida beriladi: useState, useEffect, ' +
        'Card, StatTile va h.k.',
    },
    {
      naqsh: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/,
      xabar:
        'Ko\'rinish kodi TARMOQQA CHIQMAYDI — u faqat chizadi. ' +
        'O\'zgarib turadigan qiymat kerak bo\'lsa `states` qo\'shing ' +
        '(serverda bajariladi, o\'z intervali bilan yangilanadi), natija ' +
        '`data` ichiga o\'zi tushadi.',
    },
    {
      naqsh: /\b(localStorage|sessionStorage|indexedDB)\b|\bdocument\s*\.\s*cookie\b/,
      xabar:
        'Brauzer xotirasiga (localStorage, cookie) yozmang — ko\'rinish holatsiz ' +
        'bo\'lishi kerak. Vaqtinchalik holat uchun `useState` ishlating.',
    },
  ]

  for (const { naqsh, xabar } of naqshlar) {
    if (naqsh.test(manba)) xatolar.push(xabar)
  }

  return xatolar
}

/**
 * `Bun.build` xato jurnalini AI o'qiydigan matnga aylantiradi.
 *
 * Xabarlar QISQARTIRILADI: to'liq bundler chiqishi uzun va ichida vaqtinchalik
 * yo'llar bo'ladi — model uchun foydasiz shovqin.
 */
function loglarniMatnga(xato: unknown): string[] {
  // Bun `AggregateError` tashlaydi va haqiqiy sabablar `errors` ichida
  // bo'ladi. Shakl versiyaga bog'liq bo'lgani uchun ehtiyotkorlik bilan
  // ochiladi — bu yerda yiqilish mutlaqo mumkin emas.
  const yigilgan: string[] = []

  const qoshimcha = (q: unknown) => {
    const matn = typeof q === 'string' ? q : q instanceof Error ? q.message : String(q)
    const tozalangan = matn.trim()
    if (tozalangan && !yigilgan.includes(tozalangan)) yigilgan.push(tozalangan)
  }

  if (xato && typeof xato === 'object' && 'errors' in xato) {
    const ichki = (xato as { errors?: unknown }).errors
    if (Array.isArray(ichki)) ichki.slice(0, 10).forEach(qoshimcha)
  }

  if (yigilgan.length === 0) qoshimcha(xato)

  return yigilgan.length > 0 ? yigilgan : ['Kod kompilyatsiya qilinmadi (sabab aniqlanmadi)']
}

/**
 * JSX manbasini brauzer uchun JS'ga aylantiradi.
 *
 * XATO TASHLAMAYDI — natija `{ ok, xatolar }` bo'lib qaytadi
 * (`manifest-tekshir.ts` bilan bir xil falsafa). Chaqiruvchi buzuq kodni
 * tashlab, manifestni `view`siz saqlaydi.
 */
export async function viewniQur(manba: string): Promise<QurishNatijasi> {
  // Bo'sh manba bundler uchun XATO EMAS — u bo'sh modul qurib beradi.
  // Lekin dashboard uchun bu foydasiz: ko'rinish hech narsa chizmasdi.
  // Shuning uchun buni shu yerda to'xtatamiz va AI'ga aniq aytamiz.
  if (manba.trim().length === 0) {
    return { ok: false, xatolar: ['Ko\'rinish kodi bo\'sh'] }
  }

  const taqiqlar = taqiqlanganlarniTop(manba)
  if (taqiqlar.length > 0) return { ok: false, xatolar: taqiqlar }

  const KIRISH = 'view.jsx'
  // Foydalanuvchi kodi shu nom ostida import qilinadi (quyidagi izohga q.)
  const KOMPONENT = 'komponent.jsx'

  try {
    const qurish = await Promise.race([
      Bun.build({
        entrypoints: [KIRISH],
        target: 'browser',
        // ┌──────────────────────────────────────────────────────────┐
        // │ IIFE, ESM EMAS. Kod brauzerga `new Function(...)` orqali  │
        // │ beriladi (`AiKorinish.tsx`), ya'ni modul konteksti yo'q:  │
        // │ ESM chiqishidagi `export {}` "Unexpected token 'export'"  │
        // │ berardi.                                                  │
        // │                                                          │
        // │ IIFE o'z-o'zidan bajariladi va natijani `__natija__` ga   │
        // │ yozadi — o'ram uni `return` qiladi.                       │
        // └──────────────────────────────────────────────────────────┘
        format: 'iife',
        // Minify ATAYLAB o'chirilgan: xato bo'lsa brauzer konsolidagi
        // qatorlar AI yozgan kodga mos tushsin (audit va tuzatish uchun).
        minify: false,
        jsx: {
          runtime: 'classic',
          factory: 'React.createElement',
          fragment: 'React.Fragment',
          development: false,
        },
        plugins: [
          {
            name: 'xotiradagi-manba',
            setup(build) {
              // Kod diskda emas, xotirada. Ikki "fayl" bor:
              //   KIRISH     — bizning o'ramimiz (globalga yozadi)
              //   KOMPONENT  — AI yozgan manba
              build.onResolve({ filter: /.*/ }, (arg) => {
                if (arg.path === KIRISH) return { path: KIRISH, namespace: 'view' }
                if (arg.path === KOMPONENT || arg.path === `./${KOMPONENT}`) {
                  return { path: KOMPONENT, namespace: 'view' }
                }
                // Boshqa har qanday yo'l — import urinishi.
                //
                // Odatda bu yerga YETIB KELINMAYDI: `taqiqlanganlarniTop`
                // import'ni oldinroq, tushunarli xabar bilan to'xtatadi
                // (Bun'ning `onLoad` API'si o'z xato matnimizni qaytarishga
                // imkon bermaydi, shuning uchun tekshiruv u yerda).
                //
                // Bu shox — ZAXIRA: naqsh o'tkazib yuborgan biror shakl
                // (masalan dinamik `import()`) bundlergacha yetsa, u
                // yiqilmasin, balki xato bo'lib qaytsin.
                return { path: arg.path, namespace: 'taqiq', external: true }
              })
              build.onLoad({ filter: /.*/, namespace: 'view' }, (arg) => {
                if (arg.path === KIRISH) {
                  // O'RAM: AI kodini import qilib, komponentni `__natija__`
                  // ga yozadi. Brauzer tomoni kodni `new Function` ichida
                  // bajaradi va shu o'zgaruvchini qaytaradi
                  // (`AiKorinish.tsx`).
                  //
                  // `globalThis` ATAYLAB ISHLATILMAYDI: bir sahifada bir
                  // nechta dashboard bo'lishi mumkin va ular bir-birining
                  // globalini bosib ketardi.
                  return {
                    contents: [
                      `import * as modul from './${KOMPONENT}'`,
                      '__natija__ = modul.default || modul.View',
                    ].join('\n'),
                    loader: 'js',
                  }
                }
                return { contents: manba, loader: 'jsx' }
              })
            },
          },
        ],
      }),
      new Promise<never>((_, rad) =>
        setTimeout(() => rad(new Error('Kompilyatsiya juda uzoq davom etdi')), QURISH_TIMEOUT_MS),
      ),
    ])

    // Bun odatda xatoda TASHLAYDI, lekin `success: false` ham bo'lishi
    // mumkin — ikkala yo'l ham yopiladi.
    if (!qurish.success) {
      return { ok: false, xatolar: qurish.logs.map((l) => String(l).trim()).filter(Boolean) }
    }

    const chiqish = qurish.outputs[0]
    if (!chiqish) return { ok: false, xatolar: ['Kompilyatsiya natija bermadi'] }

    // Chiqishni `new Function` bajaradigan shaklga o'raymiz: IIFE
    // `__natija__` ga yozadi, biz uni qaytaramiz.
    //
    // `</script` baribir qochiriladi: kod hozir inline joylashtirilmasa
    // ham, u JSON javobda uzatiladi va kelajakda HTML'ga tushishi mumkin —
    // bir marta tozalab qo'ygan xavfsizroq (bu bug brauzerda amalda
    // uchragan, `skriptgaXavfsiz` izohiga q.).
    const xom = skriptgaXavfsiz(await chiqish.text())
    const kod = ['let __natija__;', xom, 'return __natija__;'].join('\n')
    return { ok: true, kod, xash: kodXashi(manba), xatolar: [] }
  } catch (xato) {
    return { ok: false, xatolar: loglarniMatnga(xato) }
  }
}

// Boshqaruv qatlami validatori — sozlamalar (forma) va amallar (tugma).
//
// `manifest-tekshir.test.ts` bilan bir xil maqsad: AI yozgan buzuq manifest
// platformani yiqitmasin. Lekin bu qatlamda YANGI xavf bor — foydalanuvchi
// KIRISHI. Shuning uchun alohida e'tibor kalit/nom naqshlariga: ular
// serverdagi `.env` kaliti va URL yo'li bo'lib chiqadi.

import { describe, expect, test } from 'bun:test'
import {
  AMAL_NOMI_NAQSHI,
  AMAL_SONI_CHEGARASI,
  SOZLAMA_KALITI_NAQSHI,
  SOZLAMA_SONI_CHEGARASI,
  amallarniTekshir,
  manifestniTekshir,
  sozlamalarniTekshir,
} from '@platforma/shared'

/** Eng kichik yaroqli sozlama bloki */
const sozlamaAsosi = {
  maydonlar: [{ kalit: 'token', turi: 'sir', yorliq: 'Bot tokeni' }],
  yoz: 'module.exports = async () => {}',
}

/** Eng kichik yaroqli amal */
const amalAsosi = { nom: 'restart', yorliq: 'Restart', kod: 'module.exports = async () => {}' }

describe('sozlamalarniTekshir — asosiy shakl', () => {
  test('yaroqli blok o\'tadi', () => {
    const xatolar: string[] = []
    const ogoh: string[] = []
    const n = sozlamalarniTekshir(sozlamaAsosi, xatolar, ogoh)

    expect(xatolar).toEqual([])
    expect(n?.maydonlar).toHaveLength(1)
    expect(n?.maydonlar[0]?.kalit).toBe('token')
    expect(n?.maydonlar[0]?.turi).toBe('sir')
  })

  test('berilmagan blok `null` — xato emas', () => {
    const xatolar: string[] = []
    for (const xom of [undefined, null]) {
      expect(sozlamalarniTekshir(xom, xatolar, [])).toBeNull()
    }
    expect(xatolar).toEqual([])
  })

  test('obyekt bo\'lmagan blok RAD etiladi', () => {
    const xatolar: string[] = []
    expect(sozlamalarniTekshir([1, 2], xatolar, [])).toBeNull()
    expect(xatolar.length).toBeGreaterThan(0)
  })

  // `yoz` kodi — formaning MA'NOSI. Sxema bo'lib kodi yo'q forma
  // foydalanuvchini aldaydi: kiritadi, saqlaydi, hech narsa bo'lmaydi.
  test('`yoz` kodi yo\'q bo\'lsa RAD etiladi', () => {
    for (const yoz of [undefined, null, '', '   ', 42]) {
      const xatolar: string[] = []
      const n = sozlamalarniTekshir({ ...sozlamaAsosi, yoz }, xatolar, [])
      expect(n).toBeNull()
      expect(xatolar.some((x) => x.includes('yoz'))).toBe(true)
    }
  })

  test('`oqi` yaroqsiz bo\'lsa TASHLANADI, blok qoladi', () => {
    const ogoh: string[] = []
    const n = sozlamalarniTekshir({ ...sozlamaAsosi, oqi: 42 }, [], ogoh)

    // Blok saqlanadi: `oqi` bo'lmasa forma bo'sh ochiladi — ishlaydigan holat.
    expect(n).not.toBeNull()
    expect(n?.oqi).toBeUndefined()
    expect(ogoh.some((o) => o.includes('oqi'))).toBe(true)
  })
})

describe('sozlama kaliti — u konfiguratsiya kaliti bo\'ladi', () => {
  test('naqsh kichik harf bilan boshlanishni majburlaydi', () => {
    expect(SOZLAMA_KALITI_NAQSHI.test('token')).toBe(true)
    expect(SOZLAMA_KALITI_NAQSHI.test('admin_id')).toBe(true)
    expect(SOZLAMA_KALITI_NAQSHI.test('a1_b2')).toBe(true)

    expect(SOZLAMA_KALITI_NAQSHI.test('Token')).toBe(false)
    expect(SOZLAMA_KALITI_NAQSHI.test('1token')).toBe(false)
    expect(SOZLAMA_KALITI_NAQSHI.test('_token')).toBe(false)
  })

  // ENG MUHIM TEST. Kalit `.env` fayliga KALIT bo'lib tushadi — `=`,
  // yangi qator yoki bo'shliq fayl strukturasini buzardi.
  test('fayl strukturasini buzadigan kalitlar RAD etiladi', () => {
    const xavflilar = [
      'to=ken',
      'to ken',
      'to\nken',
      'to\rken',
      'token#izoh',
      'token"',
      "token'",
      'token$',
      'token`',
      '../token',
      'token;rm -rf /',
    ]

    for (const kalit of xavflilar) {
      expect(SOZLAMA_KALITI_NAQSHI.test(kalit)).toBe(false)

      const ogoh: string[] = []
      const n = sozlamalarniTekshir(
        { ...sozlamaAsosi, maydonlar: [{ kalit, turi: 'matn', yorliq: 'X' }] },
        [],
        ogoh,
      )
      // Yaroqli maydon qolmadi — blok tushadi
      expect(n).toBeNull()
    }
  })

  test('kalit TAKRORLANSA manifest rad etiladi', () => {
    const xatolar: string[] = []
    sozlamalarniTekshir(
      {
        ...sozlamaAsosi,
        maydonlar: [
          { kalit: 'token', turi: 'sir', yorliq: 'A' },
          { kalit: 'token', turi: 'matn', yorliq: 'B' },
        ],
      },
      xatolar,
      [],
    )
    // Qaysi qiymat yozilishi tasodifga bog'liq bo'lardi — shuning uchun xato.
    expect(xatolar.some((x) => x.includes('takrorlangan'))).toBe(true)
  })
})

describe('sozlama maydoni turlari', () => {
  test('tanilmagan tur `matn` ga tushadi va ogohlantiradi', () => {
    const ogoh: string[] = []
    const n = sozlamalarniTekshir(
      { ...sozlamaAsosi, maydonlar: [{ kalit: 'x', turi: 'yolgon', yorliq: 'X' }] },
      [],
      ogoh,
    )
    expect(n?.maydonlar[0]?.turi).toBe('matn')
    expect(ogoh.some((o) => o.includes('tanilmadi'))).toBe(true)
  })

  test('`tanlov` variantsiz `matn` ga tushadi', () => {
    const ogoh: string[] = []
    const n = sozlamalarniTekshir(
      { ...sozlamaAsosi, maydonlar: [{ kalit: 'rejim', turi: 'tanlov', yorliq: 'R' }] },
      [],
      ogoh,
    )
    // Bo'sh select foydalanuvchini qamalda qoldirardi.
    expect(n?.maydonlar[0]?.turi).toBe('matn')
    expect(n?.maydonlar[0]?.variantlar).toBeUndefined()
  })

  test('`tanlov` variantlari bilan saqlanadi', () => {
    const n = sozlamalarniTekshir(
      {
        ...sozlamaAsosi,
        maydonlar: [
          { kalit: 'rejim', turi: 'tanlov', yorliq: 'R', variantlar: ['polling', 'webhook'] },
        ],
      },
      [],
      [],
    )
    expect(n?.maydonlar[0]?.turi).toBe('tanlov')
    expect(n?.maydonlar[0]?.variantlar).toEqual(['polling', 'webhook'])
  })

  // Sir uchun `standart` qarama-qarshilik: standart qiymat manifestda
  // OCHIQ turadi va bazaga yoziladi.
  test('`sir` maydondagi `standart` TASHLANADI', () => {
    const ogoh: string[] = []
    const n = sozlamalarniTekshir(
      {
        ...sozlamaAsosi,
        maydonlar: [{ kalit: 'token', turi: 'sir', yorliq: 'T', standart: '123:ABC' }],
      },
      [],
      ogoh,
    )
    expect(n?.maydonlar[0]?.standart).toBeUndefined()
    expect(ogoh.some((o) => o.includes('standart'))).toBe(true)
  })

  test('yorliq bo\'lmasa kalitning o\'zi ishlatiladi', () => {
    const n = sozlamalarniTekshir(
      { ...sozlamaAsosi, maydonlar: [{ kalit: 'admin_id', turi: 'raqam' }] },
      [],
      [],
    )
    expect(n?.maydonlar[0]?.yorliq).toBe('admin_id')
  })

  test('chegaradan oshgan maydonlar kesiladi', () => {
    const kop = Array.from({ length: SOZLAMA_SONI_CHEGARASI + 5 }, (_, i) => ({
      kalit: `maydon_${i}`,
      turi: 'matn',
      yorliq: `M${i}`,
    }))
    const ogoh: string[] = []
    const n = sozlamalarniTekshir({ ...sozlamaAsosi, maydonlar: kop }, [], ogoh)

    expect(n?.maydonlar).toHaveLength(SOZLAMA_SONI_CHEGARASI)
    expect(ogoh.some((o) => o.includes('olindi'))).toBe(true)
  })
})

describe('naqsh — injection himoyasining uchinchi qatlami', () => {
  test('yaroqli regex saqlanadi', () => {
    const n = sozlamalarniTekshir(
      {
        ...sozlamaAsosi,
        maydonlar: [
          { kalit: 'token', turi: 'sir', yorliq: 'T', naqsh: '^\\d+:[A-Za-z0-9_-]+$' },
        ],
      },
      [],
      [],
    )
    expect(n?.maydonlar[0]?.naqsh).toBe('^\\d+:[A-Za-z0-9_-]+$')
  })

  // Buzuq regex `new RegExp` da yiqilardi — butun formani yo'qotmaslik
  // uchun naqsh tashlanadi, maydon qoladi.
  test('buzuq regex TASHLANADI, maydon qoladi', () => {
    const ogoh: string[] = []
    const n = sozlamalarniTekshir(
      { ...sozlamaAsosi, maydonlar: [{ kalit: 'x', turi: 'matn', yorliq: 'X', naqsh: '([' }] },
      [],
      ogoh,
    )
    expect(n?.maydonlar).toHaveLength(1)
    expect(n?.maydonlar[0]?.naqsh).toBeUndefined()
    expect(ogoh.some((o) => o.includes('naqsh'))).toBe(true)
  })

  test('juda uzun naqsh TASHLANADI (ReDoS chegarasi)', () => {
    const ogoh: string[] = []
    const n = sozlamalarniTekshir(
      {
        ...sozlamaAsosi,
        maydonlar: [{ kalit: 'x', turi: 'matn', yorliq: 'X', naqsh: 'a'.repeat(600) }],
      },
      [],
      ogoh,
    )
    expect(n?.maydonlar[0]?.naqsh).toBeUndefined()
    expect(ogoh.some((o) => o.includes('uzun'))).toBe(true)
  })

  test('naqsh yo\'q bo\'lsa `naqshIzohi` ham saqlanmaydi', () => {
    const n = sozlamalarniTekshir(
      {
        ...sozlamaAsosi,
        maydonlar: [{ kalit: 'x', turi: 'matn', yorliq: 'X', naqshIzohi: 'Xato format' }],
      },
      [],
      [],
    )
    // Izoh naqshsiz ma'nosiz — hech qachon ko'rinmasdi.
    expect(n?.maydonlar[0]?.naqshIzohi).toBeUndefined()
  })
})

describe('amallarniTekshir', () => {
  test('yaroqli amal o\'tadi', () => {
    const n = amallarniTekshir([amalAsosi], [], [])
    expect(n).toHaveLength(1)
    expect(n?.[0]?.nom).toBe('restart')
    // Xavf berilmasa — ENG XAVFSIZ standart.
    expect(n?.[0]?.xavf).toBe("o'zgartirish")
  })

  test('berilmagan `amallar` — xato emas', () => {
    const xatolar: string[] = []
    for (const xom of [undefined, null]) {
      expect(amallarniTekshir(xom, xatolar, [])).toBeNull()
    }
    expect(xatolar).toEqual([])
  })

  test('massiv bo\'lmasa e\'tiborsiz qoldiriladi (rad etmaydi)', () => {
    const xatolar: string[] = []
    const ogoh: string[] = []
    expect(amallarniTekshir({ nom: 'x' }, xatolar, ogoh)).toBeNull()
    expect(xatolar).toEqual([])
    expect(ogoh.length).toBeGreaterThan(0)
  })

  // Amal nomi URL yo'liga tushadi — yo'l chiqishi butunlay yopilishi kerak.
  test('URL yo\'lini buzadigan nomlar RAD etiladi', () => {
    const xavflilar = ['../restart', 'res/tart', 'Restart', 'restart?x=1', 'res tart', '']
    for (const nom of xavflilar) {
      expect(AMAL_NOMI_NAQSHI.test(nom)).toBe(false)
      const ogoh: string[] = []
      expect(amallarniTekshir([{ ...amalAsosi, nom }], [], ogoh)).toBeNull()
      expect(ogoh.length).toBeGreaterThan(0)
    }
  })

  test('nom TAKRORLANSA manifest rad etiladi', () => {
    const xatolar: string[] = []
    amallarniTekshir([amalAsosi, { ...amalAsosi, yorliq: 'Boshqa' }], xatolar, [])
    expect(xatolar.some((x) => x.includes('takrorlangan'))).toBe(true)
  })

  test('kodsiz amal TASHLANADI, qolgani ishlaydi', () => {
    const ogoh: string[] = []
    const n = amallarniTekshir(
      [{ nom: 'buzuq', yorliq: 'B' }, amalAsosi],
      [],
      ogoh,
    )
    // Bitta buzuq amal uchun boshqasini yo'qotish foydalanuvchiga zarar.
    expect(n).toHaveLength(1)
    expect(n?.[0]?.nom).toBe('restart')
    expect(ogoh.some((o) => o.includes('kod'))).toBe(true)
  })

  test('tanilmagan xavf darajasi `o\'zgartirish` ga tushadi', () => {
    const n = amallarniTekshir([{ ...amalAsosi, xavf: 'yolgon' }], [], [])
    expect(n?.[0]?.xavf).toBe("o'zgartirish")
  })

  test('xavf darajasi to\'g\'ri bo\'lsa saqlanadi', () => {
    const n = amallarniTekshir([{ ...amalAsosi, xavf: 'xavfli' }], [], [])
    expect(n?.[0]?.xavf).toBe('xavfli')
  })

  test('`tasdiq` faqat aniq `true` bo\'lganda saqlanadi', () => {
    expect(amallarniTekshir([{ ...amalAsosi, tasdiq: true }], [], [])?.[0]?.tasdiq).toBe(true)
    // "truthy" qiymat yetarli emas: tasdiq xavfsizlik belgisi, aniq bo'lishi kerak.
    expect(amallarniTekshir([{ ...amalAsosi, tasdiq: 'ha' }], [], [])?.[0]?.tasdiq).toBeUndefined()
  })

  test('chegaradan oshgan amallar kesiladi', () => {
    const kop = Array.from({ length: AMAL_SONI_CHEGARASI + 3 }, (_, i) => ({
      ...amalAsosi,
      nom: `amal_${i}`,
    }))
    const ogoh: string[] = []
    expect(amallarniTekshir(kop, [], ogoh)).toHaveLength(AMAL_SONI_CHEGARASI)
    expect(ogoh.some((o) => o.includes('olindi'))).toBe(true)
  })
})

describe('manifest bilan birga', () => {
  const asos = { id: 'bot', name: 'Bot' }

  test('faqat sozlamalar bo\'lgan manifest O\'TADI (vidjet shart emas)', () => {
    // Boshqaruv paneli — to'liq ma'noli ilova. Vidjet majburlash ortiqcha.
    const n = manifestniTekshir({ ...asos, sozlamalar: sozlamaAsosi })
    expect(n.ok).toBe(true)
    expect(n.qiymat?.sozlamalar?.maydonlar).toHaveLength(1)
  })

  test('faqat amallar bo\'lgan manifest O\'TADI', () => {
    const n = manifestniTekshir({ ...asos, amallar: [amalAsosi] })
    expect(n.ok).toBe(true)
    expect(n.qiymat?.amallar).toHaveLength(1)
  })

  test('hammasi bo\'sh bo\'lsa RAD etiladi', () => {
    const n = manifestniTekshir(asos)
    expect(n.ok).toBe(false)
    expect(n.xatolar.some((x) => x.includes('ko\'rsatadigan narsa yo\'q'))).toBe(true)
  })

  test('`yangila` mavjud bo\'lmagan state\'ga ishora qilsa TOZALANADI', () => {
    const n = manifestniTekshir({
      ...asos,
      states: [{ nom: 'holat', kod: 'module.exports = async () => 1' }],
      amallar: [{ ...amalAsosi, yangila: ['holat', 'yoq_state'] }],
    })

    expect(n.ok).toBe(true)
    // Mavjudi qoladi, yo'g'i tushadi — aks holda "yangilash" jimgina
    // hech narsa qilmasdi.
    expect(n.qiymat?.amallar?.[0]?.yangila).toEqual(['holat'])
    expect(n.ogohlantirishlar.some((o) => o.includes('yoq_state'))).toBe(true)
  })

  test('`yangila` dagi hamma state yo\'q bo\'lsa maydon butunlay tushadi', () => {
    const n = manifestniTekshir({
      ...asos,
      amallar: [{ ...amalAsosi, yangila: ['yoq'] }],
    })
    expect(n.ok).toBe(true)
    expect(n.qiymat?.amallar?.[0]?.yangila).toBeUndefined()
  })

  test('buzuq sozlama bloki butun manifestni rad etadi', () => {
    // Forma — foydalanuvchi KIRISHI. Yarim ishlaydigan forma jimgina
    // ma'lumot yo'qotishga olib kelardi.
    const n = manifestniTekshir({
      ...asos,
      widgets: [{ type: 'note', text: 'x' }],
      sozlamalar: { maydonlar: [{ kalit: 'token', turi: 'sir' }] },
    })
    expect(n.ok).toBe(false)
  })
})

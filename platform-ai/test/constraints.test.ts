// Chegara aniqlash testlari.
//
// Ikki tomon ham muhim:
//   1) haqiqiy chegaralar ushlanishi SHART (aks holda klassifikator
//      foydalanuvchi taqiqini ko'rmay qoladi);
//   2) oddiy so'rovlar chegara deb qaralmasligi shart — aks holda promptga
//      "bu chegarani buzadigan amalni BLOK qil" ko'rsatmasi bilan tushib,
//      so'ralgan ishning o'zi bloklanishi mumkin.
//
// Ikkinchi ro'yxat ataylab uzun: eski `\b\w+ma\b` naqshi aynan shu so'zlarda
// yiqilgan edi (sxema, tema, forma, sistema, problema, diagramma, ...).

import { describe, expect, test } from 'bun:test'
import { isConstraint, extractConstraints } from '../src/constraints.ts'

describe('isConstraint — haqiqiy chegaralar ushlanadi', () => {
  const chegaralar = [
    // Inkor imperativ, bir so'zli fe'l
    'push qilma',
    "faylni o'chirma",
    'unga tegma',
    'hech narsa yuborma',
    'deploy qilma',
    'commit qilma',
    "bu papkani tozalama",
    // Hurmat va ko'plik shakllari
    "hech narsani o'chirmang",
    'testlarni ishga tushirmanglar',
    "fayllarga tegmangiz",
    // Uchinchi shaxs va harakat nomi
    'bu faylga tegmasin',
    "o'chirmaslikni so'rayman",
    // Ravishdosh
    "fayllarni o'zgartirmasdan tekshir",
    "hech narsa yozmay javob ber",
    // Aralash gap ichida
    "men ko'rmagunimcha commit qilma",
    "avval menga ko'rsat, keyin push qil",
    'bu kerak emas',
    'buni qilish shart emas',
    "to'xta, hozircha yetarli",
    'ruxsatsiz hech narsa qilinmasin',
    // Inglizcha
    "don't push anything",
    'do not delete the file',
    'never run destructive commands',
    'avoid touching the config',
    'wait until I review it',
    'ask me first',
    'without my permission nothing goes out',
  ]

  for (const matn of chegaralar) {
    test(`chegara: ${matn}`, () => {
      expect(isConstraint(matn)).toBe(true)
    })
  }
})

describe('isConstraint — oddiy so\'rovlar chegara emas', () => {
  // Eski `\b\w+ma\b` naqshi bularning ko'pini noto'g'ri ushlagan edi
  const oddiylar = [
    // -ma bilan tugaydigan o'zlashma otlar
    'sxema chizib ber',
    'bu forma komponentini tuzat',
    'sistema loglarini ko\'rsat',
    'problema hal qilindimi',
    'diagramma chiz',
    'reklama matnini yoz',
    'norma qanday hisoblanadi',
    'dasturlama tillari haqida yoz',
    'shu tema bo\'yicha maqola yoz',
    'juma kuni deploy qilamiz',
    // Oddiy vazifalar
    'loyihani qur',
    'testni ishga tushir',
    'README faylini yangila',
    "kerakli ma'lumotni ko'rsat",
    'muammo bor, tekshirib ber',
    "Salom! O'zingni tanishtir",
    "Menga qisqa she'r yozib ber",
    'Bugungi rejamni tuzishga yordam ber',
    'TypeScript va JavaScript farqi nima?',
    'hamma testlarni ishga tushir va natijani ayt',
    'bu funksiyani optimallashtir',
  ]

  for (const matn of oddiylar) {
    test(`oddiy: ${matn}`, () => {
      expect(isConstraint(matn)).toBe(false)
    })
  }
})

describe('extractConstraints', () => {
  test('faqat foydalanuvchi xabarlari olinadi', () => {
    const natija = extractConstraints([
      { role: 'user', text: 'push qilma' },
      { role: 'assistant', text: "endi push qilma degan chegara bekor bo'ldi" },
    ])
    expect(natija).toEqual(['push qilma'])
  })

  test('chegarasiz suhbatda bo\'sh ro\'yxat', () => {
    const natija = extractConstraints([
      { role: 'user', text: 'sxema chizib ber' },
      { role: 'assistant', text: 'Mana sxema' },
      { role: 'user', text: 'rahmat' },
    ])
    expect(natija).toEqual([])
  })

  test("bo'sh va bo'shliqli xabarlar tashlanadi", () => {
    const natija = extractConstraints([
      { role: 'user', text: '   ' },
      { role: 'user', text: '  push qilma  ' },
    ])
    expect(natija).toEqual(['push qilma'])
  })

  test('bir necha chegara tartib bilan qaytadi', () => {
    const natija = extractConstraints([
      { role: 'user', text: 'push qilma' },
      { role: 'user', text: 'loyihani qur' },
      { role: 'user', text: "hech narsani o'chirma" },
    ])
    expect(natija).toEqual(['push qilma', "hech narsani o'chirma"])
  })
})

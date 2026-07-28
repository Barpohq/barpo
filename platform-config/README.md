# @platforma/config

Platformaning sozlamalar qatlami. Foydalanuvchi agent xulqini, tool'larni va
ruxsat tizimini fayl orqali boshqaradi.

```ts
import { config } from '@platforma/config'

const { config: sozlama, ogohlantirishlar } = config({ ishPapkasi })
sozlama.agent.siqish.zaxiraTokenlar   // → 16384
```

## Fayllar qayerda

Ikki qatlam, yuqoridagisi pastdagini bosadi:

| Qatlam | Yo'l | Vazifa |
|---|---|---|
| global | `~/.platforma/config.json` | foydalanuvchining odatiy sozlamalari |
| loyiha | `<ish papkasi>/.platforma/config.json` | shu ish uchun cheklov |

Global papkani `PLATFORMA_CONFIG_PAPKA` bilan ko'chirish mumkin (testlarda
shunday qilinadi).

Ikkalasi ham majburiy emas — fayl bo'lmasa standart qiymatlar ishlaydi.

## Loyiha configi nimani QILA OLMAYDI

Loyiha fayli repo bilan birga keladi, ya'ni uni begona odam yozgan bo'lishi
mumkin. Shuning uchun u **xavfsizlik chegarasini pasaytira olmaydi**:

| Sozlama | Loyiha nima qila oladi |
|---|---|
| `ruxsat.rejim` | faqat `tasdiq` ga tushira oladi, `auto` ga ko'tara olmaydi |
| `ruxsat.qoshimchaTaqiqlar` | faqat qo'sha oladi, olib tashlay olmaydi |
| `agent.toollar.yoqilgan` | faqat toraytira oladi, kengaytira olmaydi |
| qolganlari | erkin bosadi (xavfsizlikka tegishli emas) |

Bu `loyihaChekloviniQoll()` da amalga oshiriladi va testlar bilan majburlanadi.
pi'ning "project trust" muammosi bilan bir xil sabab: repo sizning
sozlamalaringizni o'zgartira olmasligi kerak.

## Xato bo'lsa nima bo'ladi

**Config o'qish hech qachon xato tashlamaydi va platformani to'xtatmaydi.**

| Holat | Natija |
|---|---|
| fayl yo'q | standart qiymatlar, ogohlantirishsiz |
| buzuq JSON | standart qiymatlar + ogohlantirish |
| noto'g'ri tur (`"ha"` o'rniga `true`) | standart qiymat + ogohlantirish |
| chegaradan chiqqan son | chegaraga **kesiladi** + ogohlantirish |
| ro'yxatda noto'g'ri element | faqat o'sha element tashlanadi |
| notanish maydon (imlo xatosi) | e'tiborsiz + ogohlantirish |

Chegaradan chiqqan son standartga emas, chegaraga kesiladi: foydalanuvchi
niyati aniq ("kattaroq qilmoqchi edim"), shunchaki ruxsat etilgan oraliqqa
keltiriladi.

Ogohlantirishlar `ogohlantirishlar` ro'yxatida qaytadi — server ularni
log'ga yozadi va keyinchalik UI ko'rsatadi.

## Sozlama qo'shish

Bitta joyga yoziladi — `src/sxema.ts` dagi `MAYDONLAR`:

```ts
{
  yol: 'agent.siqish.zaxiraTokenlar',
  tur: 'son',
  standart: 16384,
  izoh: "Context window'ning summary uchun ajratilgan qismi.",
  eng: { kam: 1000, kop: 200_000 },
}
```

Keyin `Config` tipiga mos maydon qo'shiladi va sxema yangilanadi:

```bash
bun run schema
```

Validatsiya, standart qiymat, JSON Schema va (keyinchalik) web forma —
hammasi shu ta'rifdan avtomatik keladi. `sxema.test.ts` `MAYDONLAR` va
`Config` tipi mos kelishini majburlaydi, `schema.test.ts` esa `schema.json`
eskirmaganini tekshiradi.

## Nima uchun JSON

Web UI keyinchalik shu faylni yozadi. JSON Schema'dan forma avtomatik
quriladi va validatsiya bir joyda qoladi. JSONC/TOML odam o'qishi uchun
qulayroq, lekin web ↔ fayl aylanishida izohlar yo'qoladi — ya'ni foydalanuvchi
yozgan izoh birinchi saqlashda o'chib ketardi.

Tahrirlagichda avtomatik to'ldirish uchun faylning boshiga qo'ying:

```json
{ "$schema": "https://.../schema.json" }
```

`namuna-config.json` — barcha sozlamalar standart qiymatlari bilan.

## Testlar

```bash
bun test
```

49 test. Asosiy majburlanadigan xulqlar: axlat kirsa ham ishlaydigan config
chiqadi, loyiha configi xavfsizlik chegarasini pasaytira olmaydi, standart
qiymatlar ulashilgan obyekt sifatida sizib ketmaydi.

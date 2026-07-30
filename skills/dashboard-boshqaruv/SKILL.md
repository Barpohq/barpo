---
name: dashboard-boshqaruv
description: Use when an app's dashboard needs a settings form or control buttons — a bot token, an admin id, a mode switch, a restart/stop button. Covers the `sozlamalar` and `amallar` layers of appPublish, the `ssh` helper, and the rules that keep user input out of the shell. Read this BEFORE publishing any form or button.
license: ichki
---

# Ilova boshqaruvi: forma va tugmalar

Dashboard faqat **ko'rsatmaydi** — u boshqarishi ham mumkin. Ikki qatlam:

| Qatlam | Nima | Qachon |
|---|---|---|
| `sozlamalar` | forma — foydalanuvchi qiymat kiritadi | token, admin id, rejim |
| `amallar` | tugma — foydalanuvchi bosadi | restart, stop, keshni tozalash |

Ikkalasi ham `appPublish` ichida beriladi. Yangi endpoint, yangi fayl —
**yo'q**.

## Eng muhim qoida: qiymat QAYERGA yoziladi

**Sozlama qiymati serverdagi ilovaning O'ZIGA yoziladi, platformaga emas.**

Bot serverda ishlaydi va tokenni o'z konfiguratsiyasidan (`/opt/bot/.env`)
o'qiydi. Foydalanuvchi tokenni platformada kiritganda u **o'sha faylga**
borishi kerak — aks holda bot eski token bilan ishlashda davom etadi.

```
brauzer → platforma → SSH → server:/opt/bot/.env → restart
```

Platforma tokenni **saqlamaydi**. Shuning uchun:
- forma ochilganda sir maydon **bo'sh** ko'rinadi (`✓ o'rnatilgan` belgisi bilan)
- `oqi` kodi sir qiymatni **qaytarmasligi kerak** — qaytarsa tashlanadi

## Sozlamalar

```js
appPublish({
  id: "telegram-bot",
  name: "Telegram bot",
  widgets: [ /* ... */ ],

  sozlamalar: {
    maydonlar: [
      {
        kalit: "token",              // a-z0-9_ — konfiguratsiya kaliti bo'ladi
        turi: "sir",                 // UI'da yashiriladi, qaytarilmaydi
        yorliq: "Bot tokeni",
        izoh: "@BotFather bergan token",
        majburiy: true,
        naqsh: "^\\d+:[A-Za-z0-9_-]+$",
        naqshIzohi: "Token `123456:ABC-DEF` shaklida bo'lishi kerak"
      },
      { kalit: "admin_id", turi: "raqam", yorliq: "Admin ID" },
      {
        kalit: "rejim",
        turi: "tanlov",
        yorliq: "Rejim",
        variantlar: ["polling", "webhook"]
      },
      { kalit: "faol", turi: "kalit", yorliq: "Yoqilgan" }
    ],

    yoz: `module.exports = async function ({ qiymatlar, ssh }) {
      const s = ssh('helsinki-1')
      const env = {}
      if (qiymatlar.token) env.TELEGRAM_TOKEN = qiymatlar.token
      if (qiymatlar.admin_id) env.ADMIN_ID = qiymatlar.admin_id
      if (qiymatlar.rejim) env.REJIM = qiymatlar.rejim

      await s.envYoz('/opt/bot/.env', env)
      await s.buyruq(['docker', 'restart', 'telegram-bot'])
      return { xabar: 'Saqlandi, bot restart qilindi' }
    }`,

    oqi: `module.exports = async function ({ ssh }) {
      const matn = await ssh('helsinki-1').faylOqi('/opt/bot/.env')
      if (!matn) return {}
      const q = {}
      for (const qator of matn.split('\\n')) {
        const i = qator.indexOf('=')
        if (i > 0) q[qator.slice(0, i).trim()] = qator.slice(i + 1).trim()
      }
      return {
        admin_id: q.ADMIN_ID,
        rejim: q.REJIM,
        // Sir uchun QIYMAT emas, BORLIGI — true/false
        token: Boolean(q.TELEGRAM_TOKEN)
      }
    }`
  }
})
```

### Maydon turlari

| `turi` | UI | Izoh |
|---|---|---|
| `matn` | matn kiritish | standart tur |
| `sir` | parol kiritish | token, parol, API kalit |
| `raqam` | raqam kiritish | tekshiriladi |
| `tanlov` | select | `variantlar` majburiy |
| `kalit` | switch | qiymat `"true"` / `"false"` |
| `kopMatn` | textarea | uzun matn, konfiguratsiya bloki |

### `oqi` va sir maydonlar

Sir uchun **qiymat emas, `true` / `false`** qaytaring:

```js
return {
  rejim: q.REJIM,                     // sirsiz — qiymat
  token: Boolean(q.TELEGRAM_TOKEN)    // sir — faqat borligi
}
```

Platforma shundan `✓ o'rnatilgan` belgisini quradi. Foydalanuvchi joriy
tokenni ko'rmaydi, lekin **kiritilgan-kiritilmaganini** biladi — bu
"nega bot ishlamayapti?" savolini yopadi.

Agar sir qiymatini qaytarib qo'ysangiz, platforma uni **tashlab yuboradi**
(brauzerga bormaydi) va bo'sh emasligini "o'rnatilgan" deb hisoblaydi.
Ishlaydi, lekin `Boolean(...)` aniqroq va tokenni platforma xotirasidan
butunlay chetlab o'tadi.

### `yoz` kodi haqida

`qiymatlar` ichida faqat **o'zgargan** maydonlar keladi. Foydalanuvchi
tokenni tegmasa, `qiymatlar.token` bo'lmaydi — shuning uchun har qiymatni
tekshirib qo'shing (yuqoridagi misolda `if (qiymatlar.token)`).

**Sir uchun bo'sh qiymat "o'zgartirmadim" degani** va u umuman kelmaydi —
ya'ni mavjud token o'chib ketmaydi.

## Amallar

```js
amallar: [
  {
    nom: "restart",                  // a-z0-9_ — URL yo'liga tushadi
    yorliq: "Botni restart qilish",
    izoh: "Konteynerni qayta ishga tushiradi",
    tasdiq: true,                    // UI tasdiq so'raydi
    xavf: "o'zgartirish",            // o'qish | o'zgartirish | xavfli
    yangila: ["holat"],              // shu statelar darhol yangilanadi
    kod: `module.exports = async function ({ ssh }) {
      await ssh('helsinki-1').buyruq(['docker', 'restart', 'telegram-bot'])
      return { xabar: 'Bot restart qilindi' }
    }`
  },
  {
    nom: "loglarni_tozalash",
    yorliq: "Loglarni tozalash",
    xavf: "xavfli",
    tasdiq: true,
    kod: `module.exports = async function ({ ssh }) {
      await ssh('helsinki-1').buyruq(['truncate', '-s', '0', '/opt/bot/bot.log'])
      return { xabar: 'Loglar tozalandi' }
    }`
  }
]
```

Qaytargan `{ xabar }` foydalanuvchiga ko'rsatiladi.

**`yangila`** — amaldan keyin qayta hisoblanadigan state nomlari. Restart
bosilganda status darhol yangilanishi kerak, keshdagi eski qiymat interval
tugashini kutib turmasin.

**`tasdiq: true`** — o'zgartiruvchi va qaytarib bo'lmaydigan amallarga
qo'ying. Bu tasodifiy bosishdan saqlaydi.

## `ssh` — buyruq bajarish

`ssh(serverNomi)` uch funksiya beradi. Server nomi platformaga ulangan
serverlar ro'yxatidan bo'lishi kerak (`serverList` tool'i bilan ko'ring).

### `buyruq(argv)` — ARGV MASSIVI, shell satri EMAS

```js
await s.buyruq(['docker', 'restart', 'bot'])              // ✅
await s.buyruq(['systemctl', 'restart', 'mybot.service'])  // ✅

await s.buyruq('docker restart bot')                       // ❌ XATO tashlanadi
await s.buyruq([`docker restart ${sozlama.nom}`])          // ❌ shablon satr
```

**Nega bu qat'iy.** Foydalanuvchi kiritgan qiymat buyruqqa tushadi. Agar u
shell satriga qo'yilsa, `bot; rm -rf /` kiritish **buyruq bajarish**
bo'lardi. Massivda esa `;` oddiy matn bo'lib qoladi.

**Buyruq yiqilsa `buyruq` xato tashlaydi** (chiqish kodi ≠ 0). Ya'ni
chiqish kodini o'zingiz tekshirishingiz shart emas:

```js
await s.buyruq(['docker', 'restart', 'bot'])
return { xabar: 'Bot restart qilindi' }   // ✅ faqat muvaffaqiyatda yetib keladi
```

Xato `{ ok: false, xato: "..." }` bo'lib foydalanuvchiga ko'rsatiladi.

Chiqish kodini **o'zingiz** hal qilmoqchi bo'lsangiz — `buyruqXom`:

```js
const n = await s.buyruqXom(['docker', 'inspect', 'bot'])
const bormi = n.kod === 0          // yo'q konteyner uchun 1 — bu javob, xato emas
```

### `envYoz(yol, qiymatlar)` — konfiguratsiya yozish

```js
await s.envYoz('/opt/bot/.env', { TELEGRAM_TOKEN: qiymatlar.token })
```

O'zi hal qiladi:
- qiymatlar **stdin orqali** boradi — token `ps` chiqishida ko'rinmaydi
- mavjud kalit **joyida almashtiriladi** (eski qiymat faylda qolmaydi)
- izohlar va tartib saqlanadi
- atomik yozish (`mv`) — yarim yozilgan fayl bilan bot ko'tarilmasligi mumkin

**`echo >> .env` yozmang.** Bu eski qiymatni faylda qoldiradi va tokenni
shell tarixiga chiqaradi.

### `faylOqi(yol)`

Fayl matnini qaytaradi, yo'q bo'lsa `null` (xato tashlamaydi).

## Xavfsizlik qoidalari — qisqa ro'yxat

1. **`buyruq` ga faqat massiv** — hech qachon satr, hech qachon shablon
2. **`.env` uchun `envYoz`** — qo'lda `echo`/`sed` yozmang
3. **`oqi` sir qaytarmasin** — token brauzerga bormasligi kerak
4. **`naqsh` qo'ying** — qiymat formati ma'lum bo'lsa (token, port, URL)
5. **`tasdiq: true`** — o'zgartiruvchi amallarga

## Chegaralar

| Nima | Chegara |
|---|---|
| Sozlama maydonlari | 30 |
| Amallar soni | 20 |
| Bitta kod hajmi | 64 KB |
| Amal bajarilish vaqti | 90 soniya |
| `tanlov` variantlari | 50 |

## Xato bo'lganda nima bo'ladi

- **Amal yiqilsa** — foydalanuvchi xato xabarini ko'radi, dashboard ishlashda
  davom etadi
- **Sozlama yozilmasa** — forma ochiq qoladi, qiymatlar yo'qolmaydi
- **Bir xil amal ikki marta bosilsa** — bir marta bajariladi (qulf)
- **Sir xato matnida chiqsa** — platforma uni `•••` ga almashtiradi

## Maxsus forma kerak bo'lsa

Sxema yetmasa, `view` (JSX) ichida o'z formangizni yozishingiz mumkin —
u `ui.saqla({...})` va `ui.amal('nom')` funksiyalarini oladi. Ular faqat
**shu ilovaning** marshrutlariga boradi.

Lekin avval sxema bilan qilib ko'ring: validatsiya, sir maskalash va
"bo'sh sir = o'zgartirmadim" qoidasi unda tayyor.

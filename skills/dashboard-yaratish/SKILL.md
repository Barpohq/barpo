---
name: dashboard-yaratish
description: Use when the user asks for a dashboard, a status page, an app overview, or any UI that shows an app's data on this platform. Covers the appPublish tool and the built-in widget shapes (stats, bars, table, logs, note, deploy, git). Read this BEFORE the first appPublish call.
license: ichki
---

# Ilova dashboardi yaratish

Bu platformada ilova sahifasi **kod bilan emas, ma'lumot bilan** yaratiladi.
`appPublish` tool'iga nima ko'rsatilishini beriladi, platforma esa uni
render qiladi.

## Eng muhim qoida

**API, route yoki frontend fayl YOZMANG.**

Dashboard uchun endpoint yozish shart emas va noto'g'ri. Ma'lumotni
to'plang (bash, read, grep — nima kerak bo'lsa), so'ng qiymatlarni
`appPublish` ga bering. Sahifa shundan quriladi.

Xato yondashuv:
- ❌ `server.ts` ga `/api/dashboard` qo'shish
- ❌ `Dashboard.tsx` komponenti yozish
- ❌ ilovaga statistika endpointi qo'shish

To'g'ri yondashuv:
- ✅ ma'lumotni o'qing → `appPublish({ id, name, widgets: [...] })`

## Chaqiruv shakli

```
appPublish({
  id: "ai-news-bot",          // majburiy: kichik harf, raqam, tire
  name: "ai-news-bot",         // majburiy
  icon: "📰",
  tagline: "AI yangiliklarini yig'ib Telegram kanalga chiqaradi",
  version: "v1.4.2",
  service: "helsinki-1 · docker · uptime 31 kun",
  status: "running",           // yoki "idle"
  widgets: [ ... ]
})
```

Bir xil `id` bilan qayta chaqirsangiz — eski dashboard **almashtiriladi**.
Shuning uchun yangilash uchun alohida tool kerak emas.

## Vidjet turlari

Har vidjet — `type` maydoni bo'lgan obyekt. Ular berilgan tartibda,
ustma-ust ko'rsatiladi.

### `stats` — yuqoridagi raqamlar qatori

```json
{
  "type": "stats",
  "items": [
    { "label": "BUGUNGI KLASTERLAR", "value": "247" },
    { "label": "KANALGA CHIQDI", "value": "4", "hint": "1 tasdiq kutmoqda" },
    { "label": "APPROVAL RATE", "value": "96%", "accent": "#45c8b5" },
    { "label": "BUGUNGI XARAJAT", "value": "$0.084", "accent": "#d9a94e" }
  ]
}
```

`value` — **satr**, ya'ni `"$0.084"`, `"96%"`, `"31 kun"` kabi birlik
bilan yozing. `hint` — kichik izoh, `accent` — hex rang.

Eng yaxshisi 2–4 element: ular bir qatorga sig'adi.

### `bars` — nisbatlarni ko'rsatuvchi chiziqlar

```json
{
  "type": "bars",
  "title": "Manba turlari (bugungi 412 element)",
  "items": [
    { "label": "RSS (rasmiy bloglar)", "value": 214 },
    { "label": "Hacker News", "value": 102 },
    { "label": "Reddit", "value": 71 }
  ],
  "suffix": " ta"
}
```

`value` bu yerda **raqam** (satr emas!) — chiziq uzunligi shundan
hisoblanadi. Eng katta qiymat to'liq kenglikni oladi.

### `table` — jadval

```json
{
  "type": "table",
  "title": "Oxirgi postlar",
  "columns": ["Vaqt", "Sarlavha", "Holat"],
  "rows": [
    ["12:06", "Gemini 3 Flash narxi 40% tushdi", "nashr ✓"],
    ["12:04", "Til sinovi natijalari", "tasdiq kutmoqda"]
  ]
}
```

Har qator — satrlar massivi, ustunlar soniga mos. Mos kelmasa platforma
o'zi to'ldiradi yoki kesadi, lekin to'g'ri berganingiz ma'qul.

Birinchi ustun monospace shriftda chiqadi — vaqt va ID uchun qulay.

### `logs` — terminal ko'rinishidagi matn

```json
{
  "type": "logs",
  "title": "Oxirgi loglar",
  "lines": [
    "12:06:01 [publisher] post #6 kanalga chiqdi",
    "12:04:18 [writer] post #5 yozildi (412 token)"
  ]
}
```

### `note` — qisqa izoh

```json
{ "type": "note", "text": "Keyingi ishga tushish: bugun 18:00 (Toshkent)" }
```

### `deploy` — joylashtirish manzili

```json
{
  "type": "deploy",
  "url": "https://bot.misol.uz",
  "kind": "domen",
  "server": "helsinki-1",
  "ssl": "Let's Encrypt, 89 kun qoldi"
}
```

`kind`: `"domen"` yoki `"port"`. `url` **http(s) bo'lishi shart**.

### `git` — oxirgi commitlar

```json
{
  "type": "git",
  "repo": "firdavs/ai-news-bot",
  "branch": "main",
  "commits": [
    { "hash": "a3f21c8", "msg": "Rank bosqichiga spam filtri", "time": "2 soat oldin" }
  ]
}
```

## Ma'lumotni qayerdan olasiz

Vidjetdagi raqamlar **haqiqiy** bo'lishi kerak. Ularni o'zingiz to'plang:

- log fayllar — `bash`, `grep`
- baza — `bash` bilan `sqlite3` yoki loyihaning o'z skripti
- server holati — `serverList` + `ssh <nom> '<buyruq>'`
- git — `bash` bilan `git log`

Ma'lumot topilmasa **to'qimang**. Vidjetni tashlab keting yoki
`note` bilan "hozircha ma'lumot yo'q" deb yozing.

## Jonli ma'lumot — `states`

⚠️ **`widgets` va `data` ichidagi qiymatlar MUZLAB QOLADI.** Bir marta
yozilgan "CPU 1.6%" abadiy 1.6% bo'lib turadi.

Vaqt o'tishi bilan o'zgaradigan narsa uchun `states` ishlating. Har state
— serverda bajariladigan kod va **o'z yangilanish oralig'i**.

```
appPublish({
  id: "server-monitoring",
  name: "Server monitoring",
  states: [
    {
      nom: "cpu",
      interval: 5,          // ← soniyada. CPU tez o'zgaradi
      kod: `module.exports = async function () {
        const { execSync } = require('child_process')
        const yuk = execSync("ssh server-107 'cat /proc/loadavg'").toString()
        return { load: yuk.split(' ')[0] }
      }`
    },
    {
      nom: "disk",
      interval: 60,         // ← disk sekin o'zgaradi, tez-tez so'rash shart emas
      kod: `module.exports = async function () {
        const { execSync } = require('child_process')
        const chiqish = execSync("ssh server-107 'df -h /'").toString()
        const q = chiqish.split('\\n')[1].split(/\\s+/)
        return { ishlatilgan: q[2], bosh: q[3], foiz: q[4] }
      }`
    }
  ],
  widgets: [
    {
      type: "stats",
      items: [
        { label: "CPU LOAD", value: "{{cpu.load}}" },
        { label: "DISK", value: "{{disk.foiz}}", hint: "{{disk.bosh}} bo'sh" }
      ]
    }
  ]
})
```

### Muhim qoidalar

**Har qiymatga o'z oralig'ini bering.** Hammasini 5 soniyaga qo'ymang —
disk hajmi uchun `df` har 5 soniyada bejiz ishlaydi va serverni yuklaydi.
Mos oraliqlar: CPU/RAM 5–10s, disk/konteynerlar 30–60s, versiya yoki
uptime kabi deyarli o'zgarmaydiganlar uchun `interval` umuman bermang.

**Endpoint yozmang.** Platforma allaqachon beradi:
`/api/apps/:id/state/:nom`. Sahifa uni o'zi polling qiladi.

**Kod natijani QAYTARSIN**, chizmasin:
```js
module.exports = async function () {
  return { cpu: 3.2, ram: 61 }     // ✅ qiymatlar
}
```

**Vidjetda `{{state.yol}}` shabloni** jonli qiymat bilan almashadi:
- `{{cpu.load}}` → `"0.42"`
- `{{disk.foiz}}` → `"52%"`
- `{{postlar[0].sarlavha}}` → ichma-ich yo'l ham ishlaydi

Qiymat kelmasa shablon o'z holicha qoladi — bu ataylab, "ma'lumot yo'q"
yashirilmasin.

### Chegaralar

| Nima | Chegara |
|---|---|
| State soni | 20 |
| Bitta kod hajmi | 64 KB |
| Eng qisqa interval | 3 soniya |
| Bajarilish vaqti | 20 soniya |
| Natija hajmi | 256 KB |

Kod yiqilsa dashboard **ishlashda davom etadi** — o'sha state eski
qiymatini saqlaydi, qolgan hammasi normal ko'rinadi.

## Cheklovlar

| Nima | Chegara |
|---|---|
| Vidjetlar soni | 50 |
| Jadval/log qatorlari | 1000 |
| `data` hajmi | 256 KB |

Chegaradan oshsa ortiqchasi tashlanadi va sizga ogohlantirish qaytadi.

## Xato bo'lsa

Tool rad etsa, javobda sabablar ro'yxati keladi. Ularni o'qing,
tuzating va qayta chaqiring. Rad etilganda **hech narsa saqlanmaydi** —
eski dashboard o'z holicha qoladi.

## Maxsus ko'rinish kerak bo'lsa

Vidjetlar yetmasa — o'z JSX kodingizni yozishingiz mumkin. Uning
qoidalari alohida: **`dashboard-jsx` skillini o'qing**. Lekin avval
vidjetlar bilan qilib ko'ring: ular ishonchliroq va tezroq.

## Boshqarish kerak bo'lsa

Dashboard faqat ko'rsatishi shart emas. Foydalanuvchi qiymat kiritishi
(bot tokeni, admin id) yoki tugma bosishi (restart, stop) kerak bo'lsa —
`sozlamalar` va `amallar` qatlamlari bor.

Ular ayniqsa **deploy qilgandan keyin** kerak: ilova serverda ishlayapti,
lekin uni sozlash va qayta ishga tushirish uchun yo'l bo'lishi kerak.

**`dashboard-boshqaruv` skillini o'qing** — u forma maydonlari, `ssh`
yordamchisi va foydalanuvchi kirishini shelldan ajratib turadigan
qoidalarni tushuntiradi.

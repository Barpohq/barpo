# AI Platforma — UI demo

**Dastur yaratadigan dastur**ning interfeysi: chat orqali yangi servis
buyurtma qilinadi, platforma uni orqa fonda quradi, tayyor ilova esa o'z
dashboardini platformaga **o'zi qo'shadi** (sidebar'dagi "Ilovalar" bo'limi).

**Chat qismi backendga ulangan** — haqiqiy LLM bilan ishlaydi (`Chat.tsx`,
`lib/api.ts`, `lib/ws.ts`). Qolgan sahifalar hali `data/mock.ts` dan
o'qiydi; ular uchun backend endpointlari tayyor, faqat `fetch` yozilishi
kerak.

Qurilish stsenariylari (bot yasash, sayt deploy qilish) `mock.ts` da
`buildPlans` sifatida saqlanib turibdi — orchestrator qurilish oqimini
ulaganda ishlatiladi.

## Ishga tushirish

```sh
bun install
bun run dev
```

## Tuzilma

```
src/
  data/mock.ts     — hali ulanmagan sahifalar uchun mock ma'lumot
  lib/
    api.ts         — REST chaqiruvlari (/api/models, /api/chat/...)
    ws.ts          — yagona WebSocket klienti (avtomatik qayta ulanish)
    model-saqlash.ts — oxirgi tanlangan model localStorage'da
  components/
    ModelTanlagich.tsx — qidiruvli model tanlash (provider bo'yicha guruhlangan)
    ToolKartasi.tsx    — agent bajargan tool (holat, diff, klassifikator yorlig'i)
    RuxsatKartasi.tsx  — xavfli amal uchun ruxsat so'rovi (3 tugma)
    RejimAlmashtirgich.tsx — ⏸ tasdiq / ⏵⏵ auto
    RejimKartasi.tsx   — auto o'chganda sabab + "Qayta yoqish"
  ui.tsx           — umumiy komponentlar (Card, StatTile, LevelBadge, Meter...)
  App.tsx          — qobiq: header, Pro rejim tugmasi, sidebar, status lenta
  pages/
    Chat.tsx       — haqiqiy LLM chat: model tanlash, streaming javob, xato holati
    AppView.tsx    — ilova manifestini dinamik render qiluvchi (vidjet sxemalari)
    Servers.tsx    — 5 server, daemon holati, ruxsat darajalari
    Skills.tsx     — skill do'koni, ruxsat modali (Android modeli)
    Audit.tsx      — append-only audit log, filtrlash
    Terminal.tsx   — tmux/Claude Code sessiyasi ko'rinishi, tasdiq oqimi
```

Menyu ataylab minimal: **Chat · Serverlar · Skill do'koni · Audit log ·
Terminal + Ilovalar**. Platforma oddiy PC'ga o'rnatib ishlatiladigan darajada
sodda — server ishlatmaydiganlar uchun ortiqcha texnik sahifalar yo'q.
(`pages/Dashboard.tsx`, `Agents.tsx`, `Workflow.tsx` fayllari saqlab qo'yilgan
lekin menyuga ulanmagan — kerak bo'lsa `App.tsx` da bir qatorda qaytariladi.)

## Dizayn qarorlari

- **Progressive disclosure** — default holat faqat chat; "PRO REJIM" tugmasi
  sidebar, status lenta va barcha texnik sahifalarni ochadi (02-ai-platform.md
  §3.5 falsafasi).
- Rang palitrasi: siyoh-ko'k fon + lazur aksent + oltin (xarajat). Grafik
  seriyalari (`--color-s1..s4`) dataviz validatoridan o'tgan (CVD-safe).
- Shriftlar: Bricolage Grotesque (sarlavha) · Manrope (matn) · JetBrains Mono
  (loglar, raqamlar) — hammasi lokal (@fontsource), CDN kerak emas.
- Mock raqamlar roadmapdagi real natijalardan olingan (247 klaster, 151 qabul,
  $0.037/post, approval 96%).

## Navigatsiya (deep-link)

URL hash orqali istalgan sahifaga to'g'ridan-to'g'ri kirish mumkin:
`/#pro/dashboard`, `/#pro/audit`, `/#pro/terminal` va h.k.

## Dinamik ilova modullari — arxitektura

Demo "server-driven UI" modelini ishlatadi va real versiyada ham shu tavsiya
etiladi:

1. **Manifest** — har bir yaratilgan servis o'zi bilan JSON manifest olib
   keladi: nom, ikon, backend servis manzili va **dashboard vidjetlari sxema
   sifatida** (`AppManifest` tipi, `src/data/mock.ts`).
2. **Host renderer** — `pages/AppView.tsx` sxemani UI'ga aylantiradi
   (stats / bars / table / logs / note / deploy / git vidjetlari). Yangi
   ilova uchun frontend **qayta build qilinmaydi** — faqat data keladi.
   Qurilish rejalari `BuildPlan` tipida (`src/data/mock.ts`) — qadamlar,
   ixtiyoriy deploy tanlovi va tayyor manifest.
3. **Registratsiya** — real platformada orchestrator yangi manifestni
   WebSocket orqali yuboradi, UI `installApp()` bilan sidebar'ga qo'shadi
   (demo'da xuddi shu funksiya chat build oqimidan chaqiriladi).

Nega iframe/module-federation emas? Sxema-vidjet modeli xavfsizroq (AI
yozgan kod host UI kontekstida ishlamaydi — prompt injection himoyasi),
soddaroq va bir xil dizayn tizimini kafolatlaydi. Vidjet turlari yetmay
qolganda ikkita yo'l bor: yangi vidjet turini host'ga qo'shish (nazorat
ostida) yoki murakkab ilovalar uchun sandbox iframe qatlami.

## Chat qanday ishlaydi

```
xabar yuborish   →  POST /api/chat/send  →  202 { messageId }
javob            →  WS: chat.delta × N                    (matn)
                     WS: chat.tool                        (tool kartalari)
                     WS: chat.permission                  (ruxsat so'rovi)
                     WS: chat.klassifikator               (auto rejim qarori)
                     WS: chat.rejim                       (rejim o'zgardi)
                  →  chat.done | chat.error
```

Ikkiga bo'linganining sababi: so'rov qabul qilinganini (yoki rad etilganini,
masalan 409 — provider qulfi) darhol bilish kerak, javob esa uzoq davom
etadi va uni HTTP javobida ushlab turish shart emas.

Model tanlagich `/api/models` dan ro'yxat oladi — bu foydalanuvchi
kompyuterida aniqlangan providerlar (mahalliy Ollama, muhit kalitlari,
`~/.claude` va `~/.codex` obunalari). Modellar provider bo'yicha
guruhlanadi, bepullari tepada.

**Provider qulfi:** birinchi xabar yuborilgach sessiya provideriga
bog'lanadi va tanlagich qulflanadi (🔒). Boshqa provider kerak bo'lsa
"+ yangi suhbat". Sababi: har provider suhbat tarixini o'z formatida saqlaydi
(thinking bloklari, tool id'lari), o'rtada almashtirish kontekstni buzadi.

WebSocket (`lib/ws.ts`) butun ilova uchun bitta — sahifa almashganda
uzilmaydi, aloqa uzilsa avtomatik qayta ulanadi va obunalarni tiklaydi.

### Tool kartalari va ruxsat

`chat.tool` bitta `id` uchun bir necha marta keladi (ishlamoqda → tugadi),
UI mavjud kartani almashtiradi. `edit` uchun diff ko'rsatiladi, `bash` ning
uzun chiqishi yig'ilgan holda turadi va bosilganda ochiladi.

`chat.permission` kelganda ruxsat kartasi chiqadi — agent javob kelguncha
kutib turadi. Javob darhol UI'da ko'rsatiladi (server tasdiqlashini
kutmasdan), yuborilmasa toast bilan xabar beriladi.

### Ruxsat rejimi

Model tanlagich yonidagi almashtirgich ikki holatni beradi:

| Yorliq | Ma'nosi |
|---|---|
| `⏸ tasdiq` | har xavfli amal so'raladi (standart) |
| `⏵⏵ auto` | klassifikator hal qiladi — so'rovlar keskin kamayadi |

Auto rejimda klassifikator qarori tool kartasi ostida bir qatorli yorliq
bo'lib ko'rinadi (`chat.klassifikator`). Qaror amal *xavflimi* emas,
*foydalanuvchi so'raganidan chetga chiqdimi* degan savolga javob beradi.

Auto o'z-o'zidan o'chishi mumkin — klassifikator ishlamasa yoki ketma-ket
bloklasa. O'shanda chatda `RejimKartasi` chiqadi: sabab va "Qayta yoqish"
tugmasi. Almashtirgich ham gold rangga o'tadi. Avtomatik tiklanmaydi —
rejimning o'z-o'zidan o'zgarishi chalkash bo'lardi.

## Qolgan backend ulash rejasi

1. `src/data/mock.ts` dagi qolgan eksportlar — har biri bitta API
   endpoint'ga mos (`/api/servers`, `/api/audit`, `/api/apps`, ... — bular
   backendda **allaqachon tayyor**, faqat `lib/api.ts` ga funksiya qo'shilishi
   kerak).
2. `builder.create` — orchestrator'da Claude Code'ni tmux sessiyasida ishga
   tushiradigan haqiqiy endpoint bo'ladi; qurilish qadamlari `build.*`
   eventlari orqali keladi (protokolda tayyor).
3. Approval kartalar Telegram approval flow bilan bitta backend'dan oziqlanadi.

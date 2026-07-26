# AI Platforma — UI demo

**Dastur yaratadigan dastur**ning interfeysi: chat orqali yangi servis
buyurtma qilinadi, platforma uni orqa fonda quradi, tayyor ilova esa o'z
dashboardini platformaga **o'zi qo'shadi** (sidebar'dagi "Ilovalar" bo'limi).
Hamma narsa **mock data** bilan ishlaydi — backend/orchestrator hali
ulanmagan. Maqsad: UI'ni oldindan ko'rish, keyin backend qismlarini yozib
asta-sekin ulash.

Uch xil qurilish stsenariysi bor (chat tavsiya tugmalarida):

| Buyruq | Nima bo'ladi |
|---|---|
| "…bot yasab ber" | Telegram bot: sandbox → kod → docker → deploy → dashboard |
| "…landing sayt yasab ber" | Static sayt: dizayn → kod → git → **deploy tanlovi so'raladi** (domen yoki port-preview) |
| "GitHub'dagi loyihamni deploy qilib ber" | Full-stack (FastAPI+React): git clone → stack tahlili → **skill yuklanadi** → to'liq deploy + domen + SSL |

Har loyiha manifestida `git` (commitlar) va `deploy` (URL, SSL, server)
vidjetlari bor — platforma git bilan ishlaydi, har o'zgarish commit bo'ladi.

## Ishga tushirish

```sh
bun install
bun run dev
```

## Tuzilma

```
src/
  data/mock.ts     — barcha mock ma'lumotlar (bitta faylda, backend ulanishida shu almashtiriladi)
  ui.tsx           — umumiy komponentlar (Card, StatTile, LevelBadge, Meter...)
  App.tsx          — qobiq: header, Pro rejim tugmasi, sidebar, status lenta
  pages/
    Chat.tsx       — chat-first interfeys: streaming, tool-kartalar, approval va qurilish oqimi
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

## Backend ulash rejasi

1. `src/data/mock.ts` dagi har bir eksport — bitta API endpoint'ga mos keladi
   (`/api/agents`, `/api/servers`, `/api/audit`, `/api/apps`, ...).
2. Chat uchun `cannedReplies` o'rniga orchestrator WebSocket oqimi ulanadi
   (streaming allaqachon UI'da bor).
3. `builder.create` — orchestrator'da Claude Code'ni tmux sessiyasida ishga
   tushiradigan haqiqiy endpoint bo'ladi; qurilish qadamlari shu oqimdan keladi.
4. Approval kartalar Telegram approval flow bilan bitta backend'dan oziqlanadi.

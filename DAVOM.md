# Qolgan joy — davom etish qo'llanmasi

_Oxirgi yangilanish: 2026-07-27. Boshqa kompyuterda davom etish uchun shu fayldan boshlang._

## Hozirgi holat

Mock demo'ni haqiqiy platformaga aylantirish jarayoni. Tanlangan yo'l: **haqiqiy
backend, Bun + TypeScript (Hono), orchestrator haqiqatan Claude Code CLI'ni ishga
tushiradi**. Ish ko'p agent bilan boshqariladi (opus — og'ir, sonnet — yengil ishlar).

**Poydevor (Faza B1) — TAYYOR.** Repo bun workspace monorepo:

- `platform-shared/` (`@platforma/shared`) — barcha tiplar + WS protokoli,
  discriminated union, `eventKanali()` exhaustive switch.
- `platform-server/` (`@platforma/server`) — Bun.serve + Hono + bun:sqlite (WAL),
  port **8787**, migratsiyalar, mock'dan idempotent seed.
  REST: `/api/health`, `apps`, `servers`, `skills`, `audit` (filter),
  `chat/sessions`. WS hub: `/ws`.
- `platform-ui/` — mock.ts tiplari shared'dan re-export qilingan,
  vite dev proxy `/api` + `/ws` → 8787.

**Testlar:** 43/43 yashil (`bun test`). Jonli curl/WS bilan ham tekshirilgan.

## Ishga tushirish

```bash
bun install
bun test                          # 43 test
cd platform-server && bun run src/index.ts   # backend :8787
cd platform-ui && bun run dev                # UI (proxy orqali backendga ulanadi)
```

## Qolgan reja (tartib bilan)

1. ~~Poydevor: shared + server + proxy~~ ✅
2. **Orchestrator + chat backend** (opus) — `routes/chat.ts`dagi
   `TODO(orchestrator)` joylaridan boshlanadi.
3. **UI statik sahifalarni API'ga ulash** (sonnet) — `platform-ui/src/lib/`
   HALI YARATILMAGAN, hech narsa yozilmagan.
4. **Server status / skill install / audit filtrlar backend** (sonnet).
5. **Chat + Terminal WS streaming** (sonnet).
6. **Integratsiya + Playwright** (opus).

2–4 parallel bajarsa bo'ladi, keyin 5, keyin 6.

## Uzilish nuqtasi (nima uchun to'xtagan edik)

- **Orchestrator agenti**: ishga tushirish auto-mode classifier tomonidan
  bloklandi (ehtimol promptdagi `--allowedTools "Bash,..."` bilan claude CLI
  spawn ko'rsatmalari sabab). Keyingi urinish: promptni yumshatish yoki
  foydalanuvchidan ruxsat rejimini so'rash.
- **UI ulash agenti** reja tuzgan joyida to'xtatilgan. Uning xulosalari:
  - server-status WS eventi yo'q → `Servers.tsx` polling qilishi kerak;
  - WS klient `sub` eventi bilan `apps` / `audit` kanallariga obuna bo'lishi shart.

## Agent eslatmalari (muhim texnik detallar)

- **Route qo'shish:** `platform-server/src/routes/<nom>.ts` + `app.ts`dagi
  `appYarat()`ga bitta import va `api.route()` qatori.
- **Audit:** faqat `auditYoz(...)` orqali — jadval UPDATE/DELETE SQL trigger
  bilan bloklangan; to'g'ridan-to'g'ri INSERT WS eventsiz qoladi.
- **Orchestrator ulanish nuqtalari:** `routes/chat.ts`da `TODO(orchestrator)`,
  `hub.handlerQosh(...)` (chat.send / chat.choice), `repo.ts`da `buildYarat` /
  `buildHolatiOzgart` / `ilovaSaqla` (yangi bayrog'i app.installed/app.updated
  tanlaydi).
- **Testlarda:** `bazaOch(':memory:')` + `dbOrnat(db)`.
- Runtime baza `platform-server/data/` ichida — git'da yo'q, birinchi ishga
  tushirishda migratsiya + seed avtomatik.

## Kengroq kontekst

- `ai-news-bot/` — alohida tayyor loyiha (488 test), bu ishga aloqasi yo'q.
- Loyiha hujjatlari: `README.md`, `01-telegram-bot.md`, `02-ai-platform.md`,
  `03-roadmap.md`, `04-xavflar.md`.

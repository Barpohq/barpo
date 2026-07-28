# Qolgan joy — davom etish qo'llanmasi

_Oxirgi yangilanish: 2026-07-28. Boshqa kompyuterda davom etish uchun shu fayldan boshlang._

## Hozirgi holat

Mock demo'ni haqiqiy platformaga aylantirish jarayoni. Tanlangan yo'l: **haqiqiy
backend, Bun + TypeScript (Hono)**, AI qatlami `pi-agent-core` ustiga qurilgan
(pi — [earendil-works/pi](https://github.com/earendil-works/pi), terminal uchun
coding agent; biz shu g'oyalarni web uchun moslashtiramiz).

**Testlar:** 681/681 yashil (`bun test`). Barcha paketlar `tsc --noEmit` toza.

**Ish uslubi o'zgardi (2026-07-28):** "avval to'liq tizim, keyin sayqal"
rejasidan voz kechildi. Endi kerakli qism quriladi va ustida ko'ringan
xato/kamchiliklar tuzatib boriladi. Maqsad o'zgarmagan, yo'l o'zgardi —
pastdagi eski "Qolgan reja" endi majburiy tartib emas, g'oyalar zaxirasi.

### Paketlar

| Paket | Vazifa |
|---|---|
| `platform-shared` | umumiy tiplar + WS protokoli (discriminated union) |
| `platform-server` | Bun.serve + Hono + bun:sqlite (WAL), port **8787** |
| `platform-ai` | provider aniqlash, agent oqimi, tool'lar, xavfsizlik |
| `platform-config` | JSON + JSON Schema sozlamalar, global + loyiha qatlami |
| `platform-ui` | React + Vite, dev proxy `/api` va `/ws` → 8787 |

## Ishga tushirish

```bash
bun install
bun test                                     # 602 test
bun run schema                               # config sxemasini qayta yasash
cd platform-server && bun run src/index.ts   # backend :8787
cd platform-ui && bun run dev                # UI
```

## Bajarilgan bosqichlar

1. ~~Poydevor: shared + server + proxy~~ ✅
2. ~~AI agent qatlami: tool'lar, ruxsat, model tanlash~~ ✅
3. ~~**Agent qatlamini pi darajasiga yetkazish**~~ ✅ (quyida)
4. ~~**Loyiha (project) mantig'i + background agentlar ko'rinishi**~~ ✅ (quyida)

### 4-bosqichda nima qilindi (2026-07-28)

**Background agentlar ko'rinishi** — server allaqachon fon rejimida ishlardi
(orchestrator fire-and-forget), ko'rinish qatlami qo'shildi:

- `chat.status` WS eventi (`ishlayapti` / `ruxsat-kutmoqda` / `tugadi` /
  `xato`) — ataylab sessiya bo'yicha FILTRLANMAYDI (`eventSessiyasi()` →
  null), sidebar hamma sessiyani ko'rsin.
- `GET /chat/running` — sahifa ochilgandagi boshlang'ich holat.
- UI: App sidebar'da "Jonli oqimlar" bo'limi, `Agents.tsx` real ma'lumotga
  ulandi ("To'xtatish" tugmasi bilan), Chat'da "Fonda" chizig'i.
- Eng muhim holat — `ruxsat-kutmoqda`: orqa fondagi agent ruxsat so'rasa
  foydalanuvchi badge orqali ko'radi (aks holda 30 daq TTL'da bekor bo'lardi).

**Loyiha (project) mantig'i** — workspace tushunchasi:

- 005-migratsiya: `projects` jadvali + `chat_sessions.project_id` (NULL =
  oddiy chat). `routes/projects.ts`: GET/POST.
- Papkani faqat platforma yaratadi: `~/.platforma/loyihalar/<slug>/`
  (`PLATFORMA_LOYIHALAR` env bilan ko'chiriladi). Slug — allowlist
  `[a-zA-Z0-9_-]`.
- Loyihali sessiyaning agent tool'lari loyiha papkasida ishlaydi — bir
  loyihaning hamma chatlari BITTA papkada (parallel to'qnashuv — qabul
  qilingan risk, qulf yo'q). Chegara `muhit.ts` dagi oddiy sessiya bilan
  bir xil.
- Loyiha papkasidagi `AGENTS.md` (ustun) yoki `CLAUDE.md` agent system
  promptiga qo'shiladi (16k belgi limiti). Klassifikatorga BORMAYDI —
  testlar bilan majburlangan (`loyiha-konteksti`, hujum matni bilan).
- UI: Chat'da `LoyihaTanlagich` (inline yangi loyiha yaratish bilan),
  sessiya boshlangach qulflanadi.

**Qoldirilgan:** loyihani o'chirish (papka taqdiri — tasdiq talab qiladi),
sessiyalar ro'yxati UI'si (loyihaning eski chatlarini ochish hali mumkin
emas), alohida Projects sahifasi, mavjud tashqi papkaga ulanish.

### 3-bosqichda nima qilindi

**Kritik tuzatishlar:**

- **Tool natijalari tarixda saqlanadi.** Ilgari agent har turn xotirasini
  yo'qotardi — "faylni o'qi" dan keyin "versiyani ayt" desa, faylni qayta
  o'qishga majbur edi. `AgentMessage[]` endi bazada
  (`chat_messages.agent_messages`, 004-migratsiya).
- **Kontekst siqish.** Uzun suhbat context window'ga sig'may qolib sessiya
  butunlay ishlamay qolardi. Endi LLM xulosasi + zaxira kesish.
- **WS sessiya izolyatsiyasi.** Ikki brauzer oynasi bir-birining
  `chat.delta`/`chat.permission` eventlarini olardi.
- **Xotira sizmasi.** Ruxsat/rejim boshqaruvchilari abadiy qolardi —
  endi TTL (30 daq) + LRU (500) bilan tozalanadi.
- **Yo'qolgan foydalanuvchi xabari.** "To'xtatish" bosib darhol yangi xabar
  yuborilsa, poyga holati tufayli xabar jimgina yo'qolardi.

**Yangi imkoniyatlar:**

- `grep` / `find` / `ls` tool'lari — `rg` bo'lsa undan, bo'lmasa Node
  backend. **Ikkalasi aynan bir xil natija beradi** (test bilan majburlangan).
- Hook tizimi: `oldin` (bloklash) va `keyin` (natijani o'zgartirish).
- Config qatlami: `~/.platforma/config.json` + loyihadagi
  `.platforma/config.json`, JSON Schema bilan.

## G'oyalar zaxirasi (eski reja — endi majburiy tartib emas)

1. **UI sahifalarni API'ga ulash** — `Servers.tsx`, `Audit.tsx`, `Skills.tsx`
   hali mock ma'lumot ishlatadi.
2. **Skills** (`SKILL.md`) — `pi-agent-core` da `loadSkills()` tayyor.
   Foydalanuvchi alohida bosqich sifatida rejalashtirgan.
3. **Config web UI** — JSON Schema'dan forma avtomatik quriladi.
4. **Docker izolyatsiyasi** — `ExecutionEnv` ni Docker exec ustida qayta yozish.
5. **AgentHarness ga o'tish** — sessiya daraxti, `steer()`, provider retry.
6. **Integratsiya + Playwright.**

## Agent eslatmalari (muhim texnik detallar)

- **Route qo'shish:** `platform-server/src/routes/<nom>.ts` + `app.ts`dagi
  `appYarat()` ga bitta import va `api.route()` qatori.
- **WS event qo'shish:** `platform-shared/src/protocol.ts` dagi tartibga amal
  qiling — u yerda 4 qadamli izoh bor. `eventKanali()` va `eventSessiyasi()`
  ikkalasini ham yangilash kerak.
- **Config sozlama qo'shish:** faqat `platform-config/src/sxema.ts` dagi
  `MAYDONLAR` ga bitta qator + `Config` tipiga maydon, keyin `bun run schema`.
  Validatsiya, standart qiymat va JSON Schema o'zi keladi.
- **Audit:** faqat `auditYoz(...)` orqali — jadval UPDATE/DELETE SQL trigger
  bilan bloklangan.
- **Testlarda:** `bazaOch(':memory:')` + `dbOrnat(db)`.
- Runtime baza `platform-server/data/` ichida — git'da yo'q, birinchi ishga
  tushirishda migratsiya + seed avtomatik.

### Buzmaslik kerak bo'lgan uch chegara

| Chegara | Qayerda | Buzilsa nima bo'ladi |
|---|---|---|
| Klassifikatorga tool natijasi bormaydi | `agent.ts`, `orchestrator.ts` | prompt injection himoyasi yo'qoladi |
| Kesish `toolResult` dan boshlanmaydi | `kontekst.ts` | provider so'rovni rad etadi |
| `rg` va Node backend bir xil natija | `qidiruv-motor.ts` | agent PC'ga qarab boshqacha ishlaydi |

Uchalasi ham test bilan majburlangan — testni "tuzatish" o'rniga kodni
tuzating.

## Kengroq kontekst

- `ai-news-bot/` — alohida tayyor loyiha (488 test), bu ishga aloqasi yo'q.
- Loyiha hujjatlari: `README.md`, `01-telegram-bot.md`, `02-ai-platform.md`,
  `03-roadmap.md`, `04-xavflar.md`.
- Paket hujjatlari: `platform-ai/README.md` (eng batafsil — xavfsizlik
  modeli), `platform-config/README.md`, `platform-server/README.md`.

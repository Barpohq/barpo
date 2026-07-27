# @platforma/server — platforma backend poydevori

"Dastur yaratadigan dastur" platformasining server qismi. Hozircha **poydevor**:
baza, migratsiyalar, audit tizimi, WebSocket hub va REST endpointlar tayyor.
Orchestrator (chat → LLM → qurilish oqimi) keyingi bosqichda ulanadi.

## Stack

| Qism | Tanlov | Nega |
|---|---|---|
| Runtime | Bun | monorepo bo'ylab yagona toolchain, TS'ni to'g'ridan-to'g'ri o'qiydi |
| HTTP | Hono | yengil, `app.request()` bilan tarmoqsiz test qilinadi |
| Baza | bun:sqlite (WAL) | bitta fayl, o'rnatish shart emas — oddiy PC'ga qo'yish printsipi |
| Real-time | Bun.serve websocket | REST bilan bitta portda, CORS muammosi yo'q |

## Ishga tushirish

```sh
bun install          # repo ildizida (workspace)
cd platform-server
bun run dev          # watch rejim
bun run start        # oddiy ishga tushirish
bun test             # testlar
```

Port: `PORT` env o'zgaruvchisi, default **8787**.
Baza yo'li: `DB_YOLI` env, default `platform-server/data/platform.db`
(papka runtime'da yaratiladi, git'ga tushmaydi).

UI dev serveri `/api` va `/ws` ni shu portga proxy qiladi
(`platform-ui/vite.config.ts`), shuning uchun frontend kodida absolut manzil
yozilmaydi.

## Fayl tuzilmasi

```
src/
  index.ts          — kirish nuqtasi: Bun.serve (Hono + WS bitta portda)
  app.ts            — Hono ilovasi, route modullarini yig'adi
  db.ts             — SQLite ulanishi, WAL, migratsiya runner
  repo.ts           — baza bilan ishlash qatlami (SQL faqat shu yerda)
  audit.ts          — auditYoz / auditOqi — audit yozuvining YAGONA yo'li
  seed.ts           — boshlang'ich ma'lumot (idempotent)
  migrations/
    index.ts        — migratsiyalar ro'yxati
    001-boshlangich.ts
  routes/
    health.ts  apps.ts  servers.ts  skills.ts  audit.ts  chat.ts
  ws/
    hub.ts          — ulanish registri, kanal obunasi, broadcast
test/               — bun test (43 test)
```

## REST endpointlar

Hammasi `/api` prefiksi ostida, javob JSON.

| Metod | Yo'l | Javob | Izoh |
|---|---|---|---|
| GET | `/api/health` | `{ok, version, schema, wsClients, uptimeMs, time}` | tiriklik + sxema versiyasi |
| GET | `/api/apps` | `{apps: AppManifest[]}` | o'rnatilgan ilovalar manifestlari |
| GET | `/api/apps/:id` | `{manifest, status, createdAt, updatedAt}` | topilmasa 404 |
| GET | `/api/servers` | `{servers: Server[]}` | |
| GET | `/api/skills` | `{skills: Skill[]}` | ruxsatlar bilan |
| GET | `/api/audit` | `{entries: AuditEntry[], total}` | query: `level`, `actor`, `limit` (max 1000), `offset` |
| GET | `/api/chat/sessions` | `{sessions: ChatSession[]}` | oxirgi faollik bo'yicha saralangan |
| POST | `/api/chat/sessions` | `{session}` · 201 | tana ixtiyoriy: `{title?}` |
| GET | `/api/chat/sessions/:id/messages` | `{messages: ChatMessage[]}` | topilmasa 404 |
| POST | `/api/chat/send` | **501** | orchestrator keyingi bosqichda to'ldiradi |

Audit uchun **yozish endpointi ataylab yo'q** — log faqat backend ichidan
`auditYoz(...)` orqali to'ladi, tashqaridan yozib bo'lmaydi.

## WebSocket protokoli

Endpoint: `ws://<host>/ws`. Tiplar `@platforma/shared/protocol` da
(discriminated union, `type` maydoni bo'yicha).

Ulanish ochilishi bilan server `hello` yuboradi. Keyin mijoz **kanallarga
obuna bo'lishi shart** — obunasiz hech qanday event kelmaydi:

```js
ws.send(JSON.stringify({ type: 'sub', channels: ['chat', 'build', 'audit'] }))
```

**Client → server:** `chat.send`, `chat.choice`, `sub`

**Server → client:**

| Event | Kanal | Qachon |
|---|---|---|
| `hello` | — (hammaga) | ulanishda |
| `chat.delta` / `chat.toolcard` / `chat.done` | `chat` | javob oqimi |
| `build.step` / `build.choice` / `build.done` / `build.failed` | `build` | qurilish jarayoni |
| `app.installed` / `app.updated` | `apps` | manifest ro'yxatdan o'tdi |
| `audit.entry` | `audit` | har `auditYoz` chaqiruvida |
| `terminal.line` | `terminal` | tmux sessiya chiqishi |

## Baza sxemasi

`schema_version` jadvali qo'llangan migratsiyalarni kuzatadi; har migratsiya
o'z tranzaksiyasida bajariladi — yarim qo'llangan holat bo'lmaydi.

Jadvallar: `servers`, `skills`, `audit_log`, `apps`, `chat_sessions`,
`chat_messages`, `build_sessions`.

`audit_log` — **append-only**: `UPDATE` va `DELETE` trigger bilan bloklangan
(`RAISE(ABORT)`), ya'ni kafolat SQL darajasida, kod xatosi ham buza olmaydi.

Manifestlar `apps.manifest` ustunida to'liq JSON sifatida saqlanadi —
server-driven UI modeli: yangi ilova qo'shilganda frontend qayta build
qilinmaydi.

## Kengaytirish (keyingi agentlar uchun)

**Yangi REST route:**
1. `src/routes/<nom>.ts` da `export const <nom>Routes = new Hono()`
2. `src/app.ts` ga bitta import + bitta `api.route('/', <nom>Routes)` qatori

**Yangi WS event:**
1. `platform-shared/src/protocol.ts` da interfeys yozing (`type` — noyob literal)
2. `ClientEvent` yoki `ServerEvent` union'iga qo'shing
3. Serverga tegishli bo'lsa `eventKanali()` switch'iga case qo'shing
   (aks holda TypeScript xato beradi — bu ataylab, unutib qoldirmaslik uchun)
4. `hub.broadcast(...)` bilan yuboring

**Yangi migratsiya:**
`src/migrations/00N-nom.ts` yarating va `migrations/index.ts` ro'yxatiga
qo'shing. Qo'llangan migratsiyani hech qachon tahrirlamang — yangisini yozing.

**Audit qoidasi:** holat o'zgartiradigan yoki maxfiy ma'lumot o'qiydigan har
amal `auditYoz(...)` chaqirishi shart. Jadvalga to'g'ridan-to'g'ri yozsangiz
WS eventi yuborilmaydi va UI'dagi lenta jim qoladi.

# @platforma/server — platforma backend poydevori

"Dastur yaratadigan dastur" platformasining server qismi. Baza, migratsiyalar,
audit tizimi, WebSocket hub va REST endpointlar tayyor. **Chat AI qatlami
tool'lar bilan ulangan**: agent fayl o'qiy/yoza/tahrirlay oladi va buyruq
bajaradi (`@platforma/ai`). Qurilish oqimi (chat → loyiha yasash) hali
ulanmagan.

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
  orchestrator.ts   — chat javob oqimi: @platforma/ai → WS eventlari → DB
  ish-papkasi.ts    — sessiya bo'yicha agent ish papkasi
  seed.ts           — boshlang'ich ma'lumot (idempotent)
  migrations/
    index.ts        — migratsiyalar ro'yxati
    001-boshlangich.ts
    002-chat-model.ts — chat_sessions ga provider/model ustunlari
    003-tool-cards.ts — chat_messages ga tool_cards ustuni
  routes/
    health.ts  apps.ts  servers.ts  skills.ts  audit.ts  chat.ts  models.ts
  ws/
    hub.ts          — ulanish registri, kanal obunasi, broadcast
    chat-handler.ts — WS chat.send, chat.permission.reply, chat.rejim.set
test/               — bun test (78 test)
```

## Chat AI oqimi

LLM bilan bog'liq hamma narsa `@platforma/ai` paketida (kalitlar, OAuth,
Ollama, model kataloglari, klassifikator). Server `modellarniAniqla()` va
`agentOqimi()` ni chaqiradi — tool'siz rejim uchun `suhbatOqimi()`.

```
POST /api/chat/send  →  xabar DB ga yoziladi, sessiya provideri qulflanadi
                     →  javobOqizi() fonda ishga tushadi (202 qaytadi)
                     →  chat.delta · chat.tool · chat.permission
                        chat.klassifikator · chat.rejim              [WS]
                     →  chat.done | chat.error
                     →  to'liq javob + tool kartalari DB ga bir marta yoziladi
```

WS orqali kelgan `chat.send` ham xuddi shu yo'ldan boradi
(`ws/chat-handler.ts`), farqi — xatolar HTTP status emas, `chat.error` eventi.

### Tool'lar

Agent `read`, `write`, `edit`, `bash` ishlatadi. Har sessiya o'z ish
papkasini oladi: `~/.platforma/ishlar/<sessionId>/` (`PLATFORMA_ISHLAR` env
bilan ko'chiriladi).

Har tool chaqiruvi audit logga tushadi: `read` → o'qish, `write`/`edit` →
o'zgartirish, `bash` → xavfli.

### Ruxsat rejimlari

| Rejim | Xatti-harakat |
|---|---|
| `tasdiq` (standart) | xavfli/notanish amal uchun `chat.permission` chiqadi, agent javob kutadi |
| `auto` | klassifikator hal qiladi — amal so'ralganidan chetga chiqmasa o'tadi |

Rejim `POST /api/chat/sessions/:id/rejim` yoki WS `chat.rejim.set` bilan
almashtiriladi. Klassifikator qarori `chat.klassifikator`, rejim o'zgarishi
`chat.rejim` eventi bo'lib keladi.

**Auto o'z-o'zidan o'chishi mumkin** — klassifikator nosoz bo'lsa, 3 marta
ketma-ket yoki 20 marta jami bloklasa. O'shanda `chat.rejim` eventi sabab
bilan keladi va UI "Qayta yoqish" tugmasini ko'rsatadi. Avtomatik
tiklanmaydi.

Ruxsat javobi `chat.permission.reply` (WS) yoki `POST /api/chat/permission`
(REST) orqali beriladi. 5 daqiqada javob kelmasa rad etiladi.

Klassifikator mexanizmi, tool natijalari izolyatsiyasi va cheklovlar:
`platform-ai/README.md`.

Modellar ro'yxati foydalanuvchi kompyuterida aniqlanadi: muhit
o'zgaruvchilari, mahalliy Ollama va `~/.claude` / `~/.codex` obuna
tokenlari.

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
| POST | `/api/chat/send` | `{messageId, model}` · 202 | javob WS orqali oqadi; xatolar: 400 / 404 / 409 |
| POST | `/api/chat/stop` | `{toxtatildi}` | ketayotgan javob oqimini bekor qiladi |
| POST | `/api/chat/permission` | `{qabulQilindi}` | ruxsat javobi: `ruxsat` / `rad` / `hardoim` |
| GET | `/api/chat/sessions/:id/rejim` | `{holat}` | sessiyaning ruxsat rejimi |
| POST | `/api/chat/sessions/:id/rejim` | `{holat}` | rejimni almashtirish: `tasdiq` / `auto` |
| GET | `/api/models` | `{models, providers, ogohlantirishlar, vaqt}` | PC'da aniqlangan AI modellari (keshlangan) |
| POST | `/api/models/refresh` | yuqoridagidek | aniqlashni qayta ishga tushiradi |

`POST /api/chat/send` javobni **kutmaydi**: xabar saqlanadi, oqim fonda
boshlanadi va 202 qaytadi. Javob `chat.delta` → `chat.done` (yoki
`chat.error`) eventlari bo'lib WS orqali keladi.

Sessiyaning **birinchi** xabarida `model: { provider, model }` yuborilishi
shart — o'shanda provider qulflanadi. Keyin boshqa provider yuborilsa **409**
qaytadi (bir provider ichida modelni almashtirish mumkin).

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

**Client → server:** `chat.send`, `chat.choice`, `chat.permission.reply`, `chat.rejim.set`, `sub`

**Server → client:**

| Event | Kanal | Qachon |
|---|---|---|
| `hello` | — (hammaga) | ulanishda |
| `chat.delta` · `chat.tool` · `chat.permission` · `chat.klassifikator` · `chat.rejim` · `chat.done` · `chat.error` | `chat` | javob oqimi |
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

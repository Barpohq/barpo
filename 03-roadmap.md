# Roadmap — Bosqichma-bosqich reja

> Tamoyil: har bosqich o'zi mustaqil foydali natija beradi. Hech qachon "hammasi tayyor bo'lganda ishlaydi" holatiga tushmaymiz.

---

## Faza 0 — Poydevor (1-hafta) ✅

- [x] Repo yaratish (open source, litsenziya tanlash — MIT yoki Apache 2.0)
- [x] Docker + docker-compose skeleti
- [x] SQLite sxema va migratsiya tizimi
- [x] `bot/llm/` — OpenRouter klienti (retry, fallback, xarajat log bilan)
- [x] Konfiguratsiya tizimi (`sources.yaml`, `channel.yaml`, `models.yaml`)

**Natija:** `docker compose up` ishlaydi, LLM'ga test so'rov ketadi.

## Faza 1 — Bot: yig'ish va dedup (1–2 hafta) ✅

- [x] RSS collector (rasmiy bloglar)
- [x] Hacker News + Reddit adapterlari
- [x] Lokal embedding + klasterlash
- [x] 7 kunlik oyna bilan dedup
- [x] CLI: bazadagi klasterlarni ko'rish

**Natija:** baza har kuni klasterlangan yangiliklarga to'ladi. Sifatini ko'z bilan tekshirish mumkin.

## Faza 2 — Bot: analiz va post (1–2 hafta)

- [x] Rank: arzon model bilan baholash + spam filtri
- [x] Enricher: web search + sahifa fetch
- [x] Writer: kuchli model + kanal uslubi few-shot
- [ ] Til sinovi: postlar tilida qaysi model eng sifatli yozadi — taqqoslash
- [x] Publisher + approval flow (shaxsiy chatga ✅/✏️/❌)

**Rank natijasi (2026-07-26):** 247 klaster baholandi, 151 qabul / 96 rad
(24 spam), $0.047, 0 xato. Spam filtri PR maqolalar, obuna reklamalari va
mavzuga aloqasiz kontentni to'g'ri tutdi.

**Enricher natijasi (2026-07-26):** 25 klasterdan 14 tasi faqat fetch bilan
boyitildi (o'rtacha 130 → 5000+ belgi). Qolgan 11 tasi Tavily kaliti
qo'shilganda hal bo'ladi: 7 tasi agregator klasteri (aniq URL yo'q),
4 tasi OpenAI sahifasi (403 — bot bloklash, search fallback ishlaydi).

Tavily kaliti qo'shilgach 26 klaster boyitildi (16 fetch, 10 search),
matn hajmi 62 → 4805 belgi.

**Writer natijasi (2026-07-26):** 5 post yozildi, hammasi birinchi
urinishda tekshiruvdan o'tdi. O'rtacha 840 belgi (chegara 1024),
$0.037/post. Kanal formati va few-shot namunalar `channel.yaml` da.

**Publisher natijasi (2026-07-26):** to'liq zanjir ishladi — Writer
yozdi, tasdiqqa yubordi, ✅ bosilgach kanalga chiqdi
(https://t.me/meninguchunyangikanal/2). Takror filtri klaster 259 va 264
muammosini hal qildi: model identifikatori bo'yicha taqqoslanadi, post #3
avtomatik chiqarib tashlandi.

**Qolgan ish — til sinovi:** hozir writer uchun Opus 5 ishlatilmoqda
($0.037/post). models.yaml dagi language_test_candidates bo'yicha
taqqoslash o'tkazilmagan — arzonroq model yetarli sifat bersa oylik
xarajat bir necha barobar tushadi.

**Natija:** har kuni shaxsiy chatga tayyor postlar keladi, men tasdiqlab kanalga chiqaraman.

## Faza 3 — Bot: avtonomlik (2–4 hafta parallel kuzatuv)

> Diqqat: birinchi va oxirgi band **ma'lumot to'planishini kutadi** —
> tahrir farqlari va approval statistikasi kanal ishlatilgani sari
> yig'iladi. Infratuzilma (health, statistika) tayyor va ularni
> avtomatik o'lchaydi.

- [ ] Tahrir farqi va rad etish naqshlari asosida prompt tuning
- [x] Health report + alerting
- [x] Idempotentlik va crash-recovery testlari
- [ ] Approval rate ≥ 95% barqaror → **auto rejim yoqiladi**

**Tuzatilgan taxmin (2026-07-27):** dastlabki reja `reject_reason` ustuniga
tayangan edi — rad etilgan post uchun odam sabab yozadi deb hisoblangan.
Amalda bunday bo'lmaydi: rad etish ko'pincha "shunchaki yoqmadi" bo'ladi va
uni so'z bilan ifodalash qiyin, shuning uchun sabab maydoni bo'sh qoladi.
Sababga tayangan prompt tuning ishlamaydi — undan voz kechildi.

O'rniga ikkita signal ishlatiladi, ikkalasi ham so'zsiz yig'iladi:

  1. **Tahrir farqi** (`original_body` ↔ `body`) — eng kuchlisi. Odam
     matnni tuzatganda nima yoqmaganini harakat bilan ko'rsatadi, va bu
     izohdan aniqroq. Publisher allaqachon saqlaydi.
  2. **Rad etish naqshlari** — qaysi kategoriya, manba, muhimlik bahosi va
     post uzunligi rad etilyapti. Sababsiz ham naqsh chiqadi.

**Health natijasi (2026-07-26):** kunlik hisobot Telegram'ga (09:00
Toshkent), muammo bo'lsa darhol alert (6 soat cooldown bilan). Approval
rate avtomatik hisoblanadi, avtonom rejimga tayyorlik ko'rsatiladi.
CLI: `bot health`, `bot stats`. Telegram: /health, /stats, /sources.

Manba "buzilgan" holati xatolar tarixidan emas, hozirgi holatdan
aniqlanadi — tuzatilgan manba kun bo'yi alert bermasligi uchun.

**Crash-recovery natijasi (2026-07-27):** `tests/test_recovery.py` — 29 test,
har bosqich uchun "jarayon o'rtada o'ldi" ssenariysi. Tamoyil: yo'qotish
arzon (keyingi sikl qayta uradi), takrorlash qimmat (LLM puli, kanalga
ikkinchi post) — shuning uchun testlar takrorlanmaslikni tekshiradi.

Tasdiqlangan xossalar: Collector qayta ishga tushishda dublikat yozmaydi;
dedup navbati `cluster_items` ga tayangani uchun yarim yozilgan holatda ham
element ikkilanmaydi; `item_count` COUNT(*) dan qayta hisoblanadi;
Rank `UPDATE ... WHERE status = 'new'` bilan himoyalangan; Enricher
`enriched_at` bo'yicha bir marta ishlaydi; Writer `_save_post()` atomik va
navbat filtri posts jadvaliga tayanadi; Publisher takror filtri uzilishdan
keyin ikkinchi postni to'xtatadi; migratsiya xatosi to'liq rollback bo'ladi.

Bitta ataylab qilingan xulq hujjatlashtirildi: Writer'da saqlash xatosi
butun oqimni to'xtatadi (bitta klasterning xatosidan farqli) — baza
yozilmayotgan bo'lsa keyingi klasterlarga LLM puli sarflash behuda.

**Natija:** bot to'liq avtonom. Bu — loyihaning birinchi katta g'alabasi va platformaning isbotlangan yadrosi.

## Faza 4 — Ikkinchi use case (platformaning tug'ilishi) ✅

Tanlangan use case: **server monitor agent**. Sabab — bot bilan eng ko'p
modul bo'lishadi (LLM, baza, Telegram, konfiguratsiya, scheduler), ya'ni
core ajratish uchun eng kuchli signal beradi. Deploy agent kuchliroq og'riq,
lekin u Faza 5 ishining katta qismini (daemon, ruxsat darajalari, sandbox)
oldinga tortardi.

- [x] Core ajratish: `core/` — logging, config, db, llm, telegram
- [x] Monitor agent: SSH checklar, holat, alert, LLM diagnostika
- [x] Ikkala agent bitta bazada, migratsiyalar diapazon bilan ajratilgan

**Qarorlar:**

- **Ulanish — SSH** (tizim `ssh`, kutubxona emas). Serverga daemon
  o'rnatilmaydi, kalit Python jarayoniga o'qilmaydi, yangi bog'liqlik yo'q.
  Faza 5 da agent daemon'ga almashtirish mumkin.
- **Faqat o'qish.** Roadmap'ning dastlabki tavsifida "o'zi tuzatishga
  urinish" bor edi — X2 (prompt injection) riskini hisobga olib rad etildi.
  LLM hech qanday amal bajarmaydi, faqat izohlaydi.
- **Paket nomi `core/`, `platform/` emas** — `platform` stdlib moduli,
  loyiha ildizidagi `platform/` uni shadow qilib, `httpx`/`apscheduler`
  ichida tushunarsiz xato berardi.
- **Bitta SQLite fayl** — `llm_calls` bo'linmasligi kerak ("qaysi agent
  qancha sarflayapti"). Migratsiya diapazonlari: bot 1–199, monitor 200–299.

**Core'ga ko'chmagani (ataylab):** `bot/health/`, `notify._send()`,
scheduler, CLI. Ular ikki domenning o'xshash-lekin-boshqa kodi — 15 qator
SQL takrorlanishi noto'g'ri abstraksiyadan arzonroq.

**Natija (2026-07-26):** 2 agent bitta core ustida. 333 → 488 test.
Real serverda sinaldi: o'lchovlar to'g'ri, alert va tiklanish oqimi
ishladi, prompt injection hujumiga model bo'ysunmadi va hujumni qayd etdi.
Monitor diagnostikasi ~$0.0007/chaqiruv.

## Faza 5 — Server agents + xavfsizlik qatlami

- [ ] Agent daemon (outbound WebSocket, bitta buyruq bilan o'rnatish)
- [ ] Ruxsat darajalari (o'qish / o'zgartirish / xavfli)
- [ ] Human-in-the-loop tasdiqlash (approval flow'ning umumlashgan versiyasi)
- [ ] Append-only audit log
- [ ] 5 serverimni ulash

**Natija:** chat orqali serverlarimni xavfsiz boshqaraman.

## Faza 6 — Web UI + progressive disclosure

- [ ] Chat-first web interfeys
- [ ] Pro rejim: loglar, tmux ko'rinishi, xarajat dashboardi, audit log
- [ ] Skill'lar katalogi (oddiy versiya: ro'yxat + bir klik o'rnatish + ruxsatlar ko'rsatish)

**Natija:** to'liq platforma tajribasi — o'zim har kuni ishlataman.

## Faza 7+ — Ochiq rivojlanish

- Deploy skill'lar to'plami (Python/Django, Rust, Go, Docker...)
- MCP server integratsiyalari
- Hujjatlashtirish + README — boshqalar ham self-host qila olishi uchun
- Jamiyatdan kelgan hissalar (agar kelsa — bonus, kelmasa ham loyiha men uchun ishlayapti)

---

## Muvaffaqiyat mezonlari

| Bosqich | Mezon |
|---|---|
| Bot | 30 kun uzluksiz, aralashuvimsiz, sifatli postlar |
| Platforma yadrosi | 2+ agent bitta core'da, kod takrorlanishisiz |
| Server boshqaruv | Oddiy deploy'ni chat orqali 1 buyruq bilan qilaman, terminal ochmayman |
| Umumiy | Kundalik ishimda eski tarqoq vositalarga qaytish ehtiyoji yo'qolgan |

## Anti-maqsadlar (tuzoqlardan saqlanish)

- Bot tayyor bo'lmasdan platforma kodini yozishni boshlamaslik
- "Kelajakda kerak bo'ladi" degan funksiya qo'shmaslik — faqat hozirgi real ehtiyoj
- UI'ni Faza 6'dan oldin boshlamaslik (CLI + Telegram approval yetadi)
- Mukammallikka intilmaslik — ishlagan versiya > chiroyli reja

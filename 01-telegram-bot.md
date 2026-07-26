# Bosqich 1 — Telegram AI Yangiliklar Boti

> To'liq avtonom bot: har kuni AI yangiliklarini yig'adi, tahlil qiladi, dublikatlarni ajratadi, chala ma'lumotlarni to'ldiradi va kanalga chiroyli formatda joylaydi.

---

## 1. Maqsad va talablar

### Funksional talablar

1. **Yig'ish** — bir nechta manbadan AI yangiliklarini muntazam (har 2–4 soatda) yig'ish
2. **Deduplication** — bir xil yangilikning turli manbalardagi versiyalarini bitta klasterga birlashtirish
3. **Analiz** — har bir yangilikning muhimligini baholash, kanal auditoriyasiga mosligini aniqlash
4. **Boyitish** — chala yangiliklar bo'yicha web search orqali qo'shimcha ma'lumot to'plash
5. **Generatsiya** — kanal uslubida, chiroyli formatda post yozish
6. **Yuborish** — Telegram kanalga avtomatik joylash (boshida approval bilan, keyin to'liq auto)
7. **Avtonomlik** — mening aralashuvimsiz uzluksiz ishlash, xatolardan o'zi tiklanish

### Nofunksional talablar

- Bitta serverda Docker ichida ishlaydi
- LLM xarajatlari minimal (arzon model 90% ishni qiladi, kuchli model faqat yakuniy postga)
- Barcha holatlar bazada saqlanadi — server restart bo'lsa hech narsa yo'qolmaydi
- Har bir qadam log'lanadi — muammo chiqsa aniq qayerda ekani ko'rinadi

---

## 2. Arxitektura — Pipeline

```
┌──────────┐   ┌────────┐   ┌───────┐   ┌──────────┐   ┌──────────┐   ┌─────────┐
│ Collector │──▶│ Dedup  │──▶│ Rank  │──▶│ Enricher │──▶│ Writer   │──▶│ Publisher│
│ (RSS/API) │   │(embed) │   │ (LLM) │   │(search)  │   │ (LLM)    │   │(Telegram)│
└──────────┘   └────────┘   └───────┘   └──────────┘   └──────────┘   └─────────┘
      │             │            │            │              │              │
      └─────────────┴────────────┴────┬───────┴──────────────┴──────────────┘
                                      ▼
                              ┌──────────────┐
                              │ SQLite (holat)│
                              └──────────────┘
```

Har bir bosqich mustaqil modul — bu keyinchalik platformaga ajratib olishni osonlashtiradi.

### 2.1 Collector (yig'uvchi)

Manbalar (boshlang'ich ro'yxat):

| Turi | Manba | Izoh |
|---|---|---|
| RSS | Anthropic, OpenAI, Google AI, HuggingFace bloglari | Rasmiy e'lonlar — eng ishonchli |
| RSS | arXiv (cs.AI, cs.CL, cs.LG) | Ilmiy maqolalar — filtrlab olish kerak |
| API | Hacker News (Algolia API) | "AI" bo'yicha top postlar |
| API | Reddit JSON (r/LocalLLaMA, r/MachineLearning) | Jamiyat muhokamalar |
| Scrape | Model release trackerlar | OpenRouter yangi modellar ro'yxati |

- Cron: har 2–4 soatda ishga tushadi
- Har bir element xom holatda bazaga yoziladi: `url, title, content, source, fetched_at, status='raw'`
- Manbalar konfiguratsiya faylida (`sources.yaml`) — kod o'zgartirmasdan qo'shish/olib tashlash mumkin

### 2.2 Deduplication

Ikki bosqichli:

1. **Arzon filtr:** URL normalizatsiya + sarlavha o'xshashligi (fuzzy match). Aynan bir xil elementlar shu yerda tushib qoladi.
2. **Semantik klasterlash:** Embedding (lokal model, masalan `bge-small` — API xarajati nol) + cosine similarity. "GPT-5 chiqdi" haqidagi 15 ta turli post bitta klasterga tushadi.

Klaster ichida eng to'liq/original manba "asosiy" deb belgilanadi, qolganlari qo'shimcha kontekst sifatida saqlanadi.

Muhim: dedup faqat bugungi emas, oxirgi 7 kunlik yangiliklar bilan solishtiradi — LLM'lar eski yangilikni yangi deb o'ylash xatosining oldini olish uchun.

### 2.3 Rank (baholash)

Arzon LLM (Haiku / Gemini Flash / OpenRouter'dagi arzon model) har bir klasterga:

- **Muhimlik bahosi** (1–10): yangi model relizi > kichik feature yangilanishi > mish-mish
- **Kategoriya:** model reliz / tadqiqot / vosita / biznes yangiligi / boshqa
- **Kanalga moslik:** auditoriya profili prompt'da tavsiflanadi
- **Reklama/spam filtri:** reklama postlarni yangilik deb qabul qilmaslik

Faqat threshold'dan o'tganlar (masalan ≥ 6) keyingi bosqichga o'tadi. Kuniga post soni cheklanadi (masalan maks 5–8) — kanalni to'ldirib yubormaslik uchun.

### 2.4 Enricher (boyitish)

Agar klasterdagi ma'lumot chala bo'lsa (masalan faqat sarlavha bor):
- Web search (Brave Search API / Tavily / SearXNG self-hosted) orqali qo'shimcha manbalar topiladi
- Asosiy sahifa fetch qilinib, matn ajratib olinadi
- Hamma narsa klaster kontekstiga qo'shiladi

### 2.5 Writer (post generatsiya)

- **Eng kuchli model** faqat shu bosqichda ishlatiladi (post sifati = kanal obro'si)
- Prompt tarkibi: klaster konteksti + kanalning 5–10 ta eng yaxshi eski posti (few-shot uslub namunasi) + formatlash qoidalari
- O'zbek tilida yozilsa: modellarni alohida sinash kerak — o'zbekchada kuchli modelni tanlash (Claude / GPT sinovdan o'tkaziladi)
- Chiqish formati: Telegram HTML/Markdown, emoji siyosati, manba havolasi, hashtag'lar

### 2.6 Publisher (yuboruvchi)

- Telegram Bot API orqali kanalga yuborish
- Rasm: yangilikning o'z rasmi (OG image) bo'lsa oladi, bo'lmasa matnli post
- Yuborilgan postlar bazada belgilanadi (`status='published'`, `message_id` saqlanadi)

### 2.7 Approval flow (nazorat qatlami)

**Birinchi 2–4 hafta majburiy bosqich:**

```
Writer ──▶ Shaxsiy chatga yuboradi ──▶ [✅ Tasdiqlash] [✏️ Tahrir] [❌ Rad etish]
                                            │                          │
                                            ▼                          ▼
                                        Kanalga                 Sabab so'raladi,
                                                                bazaga yoziladi
```

- Rad etish sabablari to'planadi → Rank prompt'ini yaxshilash uchun ma'lumot
- Ishonch statistikasi yig'iladi (approval rate ≥ 95% bo'lganda auto rejimga o'tish mumkin)
- To'liq auto rejimda ham ❌ tugmasi qoladi — kanaldan o'chirish + feedback

---

## 3. Texnik stack

| Qatlam | Tanlov | Sabab |
|---|---|---|
| Til | Python 3.12+ | Yig'ish/pipeline uchun eng boy ekotizim |
| Baza | SQLite | Bitta fayl, backup oson, bu yuklama uchun ortig'i bilan yetadi |
| Scheduler | APScheduler yoki cron | Oddiy, ishonchli |
| LLM kirish | OpenRouter (hamma modelga bitta API) | Modellarni almashtirib sinash oson — mening ish uslubimga mos |
| Embedding | sentence-transformers (lokal, bge-small) | API xarajati nol |
| Web search | Tavily API yoki SearXNG (self-hosted) | Boyitish bosqichi uchun |
| Telegram | python-telegram-bot yoki aiogram | Ikkalasi ham yetuk |
| Deploy | Docker + docker-compose | Bitta serverga qo'yiladi |
| Monitoring | Healthcheck + xato bo'lsa Telegram'ga alert | Bot o'zi haqida o'zi xabar beradi |

## 4. Loyiha strukturasi

```
ai-news-bot/
├── docker-compose.yml
├── .env.example              # API kalitlar shabloni
├── config/
│   ├── sources.yaml          # Manbalar ro'yxati
│   ├── channel.yaml          # Kanal profili, uslub, til, post limiti
│   └── models.yaml           # Qaysi bosqichda qaysi model (OpenRouter slug)
├── bot/
│   ├── collector/            # Manba adapterlari (rss.py, hn.py, reddit.py)
│   ├── dedup/                # Embedding + klasterlash
│   ├── rank/                 # LLM baholash
│   ├── enricher/             # Web search + fetch
│   ├── writer/               # Post generatsiya
│   ├── publisher/            # Telegram yuborish + approval flow
│   ├── llm/                  # OpenRouter klienti (yagona kirish nuqtasi!)
│   ├── db/                   # SQLite modellari va migratsiyalar
│   └── main.py               # Scheduler + pipeline orkestratsiyasi
└── tests/
```

**Muhim dizayn qarori:** `bot/llm/` — barcha LLM chaqiruvlar yagona modul orqali o'tadi. Bu modul keyinchalik platformaning "LLM Router" komponentiga aylanadi. Xuddi shunday `collector/`, `dedup/`, `publisher/` ham kelajakda platforma modullari bo'ladi — shuning uchun ular boshidan bir-biriga bog'lanmagan (loosely coupled) yoziladi.

## 5. Ishga tushirish bosqichlari

1. **Hafta 1:** Collector + baza + dedup. Natija: baza yangiliklarga to'lyapti, dublikatlar klasterlanyapti (buni oddiy CLI orqali tekshirish mumkin)
2. **Hafta 2:** Rank + Writer + Publisher (approval rejimda). Natija: shaxsiy chatga tayyor postlar kelyapti
3. **Hafta 3–4:** Approval feedback asosida prompt'lar sozlanadi, xato holatlar tuzatiladi
4. **Hafta 5+:** Approval rate barqaror ≥ 95% → auto rejim yoqiladi. Bot to'liq avtonom.

## 6. Xato holatlarga chidamlilik

- Har bir bosqich idempotent — qayta ishga tushirilsa ishni qayerda qolgan bo'lsa o'sha yerdan davom ettiradi (holat bazada)
- Manba ishlamay qolsa → skip + log, boshqa manbalar davom etadi
- LLM API xato bersa → 3 marta retry (exponential backoff) → keyingi siklga qoldiradi
- Kunlik "health report" shaxsiy chatga: nechta yangilik yig'ildi, nechta post chiqdi, xatolar bormi
- 24 soat davomida hech narsa yig'ilmasa → alert (nimadir buzilgan)

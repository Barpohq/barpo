# AI News Bot

> Telegram kanali uchun to'liq avtonom AI yangiliklar boti.
> Har kuni AI yangiliklarini yig'adi, dublikatlarni klasterlaydi, muhimini tanlaydi
> va o'zbek tilida post yozib kanalga joylaydi.

Bu — [AI Platform](../README.md) loyihasining birinchi bosqichi. Botning modullari
keyinchalik umumiy platforma komponentlariga aylanadi.

## Pipeline

```
Collector → Dedup → Rank → Enricher → Writer → Publisher
 (RSS/API)  (embed)  (LLM)  (search)   (LLM)   (Telegram)
                        │
                   SQLite (holat)
```

## Talablar

- Python 3.12+
- [uv](https://docs.astral.sh/uv/) (paket menejeri)
- Docker (ixtiyoriy, deploy uchun)
- OpenRouter API kaliti
- Telegram bot tokeni

## Ishga tushirish

```bash
# 1. Kalitlarni sozlash
cp .env.example .env
$EDITOR .env

# 2. Bog'liqliklarni o'rnatish
uv sync

# 3. Bazani yaratish
uv run bot db migrate

# 4. LLM ulanishini tekshirish
uv run bot llm test

# 5. Bir marta yig'ish + dedup + baholash + boyitish
uv run bot collect
uv run bot dedup
uv run bot rank
uv run bot enrich

# 6. Klasterlarni ko'rish
uv run bot clusters list
uv run bot clusters list --status ranked
uv run bot clusters show <id>
```

Baholashni bazaga yozmasdan sinash:

```bash
uv run bot rank --limit 8 --dry-run
```

Doimiy rejim (scheduler bilan):

```bash
uv run bot run
# yoki
docker compose up -d
```

## Konfiguratsiya

Sozlamalar `config/` katalogida — kod o'zgartirmasdan tahrirlash mumkin:

| Fayl | Mazmuni |
|---|---|
| `sources.yaml` | Yangilik manbalari (RSS, HN, Reddit, arXiv) |
| `channel.yaml` | Kanal profili, auditoriya, formatlash, post limitlari |
| `models.yaml` | Har bosqich uchun model, fallback zanjiri, narxlar, limitlar |

`channel.yaml` dagi `audience`, `topics_of_interest` va `topics_to_avoid`
to'g'ridan-to'g'ri Rank promptiga tushadi — baholash sifatini shu yerdan
sozlaysiz. `posting.min_importance_score` esa rad etish chegarasi.

### Agregator manbalar

Anthropic va Meta AI rasmiy RSS chiqarmaydi, shuning uchun ular uchun Google
News RSS ishlatiladi. Bunday feed'da `link` — agregatorning redirect havolasi
(JavaScript orqali ochiladi, ichida haqiqiy URL yo'q). Collector `<source url>`
tegidan nashriyot domenini olib `extra.publisher_url` ga yozadi; dedup shu
asosda birlamchi manbani tanlaydi va postdagi havola agregatorga emas,
nashriyotga ketadi.

Collector'ga bu qo'shilishidan oldin yig'ilgan elementlar uchun:

```bash
uv run bot backfill-publishers
```

## Boyitish (Enricher)

Feed'lardagi matn qisqa (o'rtacha ~130 belgi — sarlavha va anons), Writer
uchun yetarli emas. Enricher har bir baholangan klasterga to'liq maqola
matnini topadi:

| Holat | Usul |
|---|---|
| Aniq maqola URL'i bor | Sahifa ochiladi, HTML'dan matn ajratiladi |
| Faqat nashriyot domeni (agregator) | Sarlavha bo'yicha web search |
| Sahifa 403 beradi (OpenAI kabi) | Search'ga fallback |

Web search uchun `TAVILY_API_KEY` kerak (oyiga 1000 so'rov bepul —
[tavily.com](https://tavily.com)). Kalitsiz ham ishlaydi, faqat fetch
bilan:

```bash
uv run bot enrich --limit 20     # fetch + search
uv run bot enrich --no-search    # faqat fetch, kredit sarflanmaydi
```

Boyitib bo'lmagan klaster ham `enriched` deb belgilanadi — har siklda qayta
urinilmasligi uchun. U Writer'ga feed'dagi qisqa matn bilan boradi.

Maxfiy ma'lumotlar (API kalitlar) faqat `.env` faylida — YAML'ga yozilmaydi.

## Server monitor

Ikkinchi agent: serverlarni SSH orqali kuzatadi, muammo bo'lsa Telegram'ga
alert va LLM diagnostikasi yuboradi. **Faqat o'qish** — hech narsa
o'zgartirmaydi.

```bash
uv run monitor servers            # SSH ulanishini tekshirish
uv run monitor check              # bir marta tekshirish
uv run monitor status             # oxirgi holat (tekshirmasdan)
uv run monitor alerts --open      # ochiq alertlar
uv run monitor diagnose --server web-1
uv run monitor run                # doimiy rejim (har 10 daqiqa)
```

Serverlar `config/servers.yaml` da. Tekshiruvlar: `load` (yadroga
nisbatan), `memory` (`total - available`), `disk` (mount bo'yicha),
`uptime`, `service:<nom>` (`systemctl is-active`).

**Buyruqlar konfiguratsiyada emas** — ular `monitor/checks.py` da qat'iy
belgilangan. `servers.yaml` faqat "qaysi server, qaysi check, qaysi
chegara" deydi, aks holda konfiguratsiya masofaviy kod bajarish
kanaliga aylanardi.

### SSH sozlash

Kalit bilan, parolsiz kirish kerak (`BatchMode=yes` — parol so'ralmaydi).
Serverda cheklangan foydalanuvchi tavsiya etiladi:

```bash
# Serverda
sudo useradd -m -s /bin/bash monitor
sudo mkdir -p /home/monitor/.ssh

# authorized_keys ga — kalit oldiga cheklovlar:
# no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA...
```

`root` bilan ham ishlaydi, lekin kalit to'liq huquqli bo'ladi — kod faqat
o'qish buyruqlarini yuborsa ham, kalit o'g'irlansa zarar kattaroq.

Birinchi ulanishdan oldin host kalitini qabul qiling
(`StrictHostKeyChecking=yes` — noma'lum host xato beradi):

```bash
ssh-keyscan -H 10.0.0.11 >> ~/.ssh/known_hosts
uv run monitor servers   # sozlash to'g'riligini tekshiradi
```

### Alertlar

- Ketma-ket **ikki** muvaffaqiyatsizlikdan keyin yuboriladi — tarmoqning
  bir soniyalik uzilishi alert bermaydi
- Cooldown `(server, check)` bo'yicha, 4 soat — bitta serverning diski
  boshqasining alertini bosmaydi
- Muammo tugagach "✅ tiklandi" xabari keladi
- LLM diagnostikasi faqat `fail` uchun; LLM ishlamasa alert baribir ketadi

## Loyiha strukturasi

```
core/            # Ikkala agent ishlatadi
├── config.py    # .env, models.yaml, baza yo'li
├── db/          # SQLite ulanishi + migratsiya registri
├── llm/         # OpenRouter klienti (LLM Router)
├── telegram.py  # Telegram transport
└── logging_setup.py

bot/             # 1-agent: yangiliklar boti
├── collector/   # Manba adapterlari (rss.py, hn.py, ...)
├── dedup/       # Embedding + klasterlash
├── rank/        # LLM baholash
├── enricher/    # Web search + sahifa fetch
├── writer/      # Post generatsiya
├── publisher/   # Telegram + approval flow
├── health/      # Hisobot va alerting
├── schema.py    # Bot migratsiyalari (versiya 1–199)
└── __main__.py  # CLI + scheduler

monitor/         # 2-agent: server monitor
├── ssh.py       # SSH qatlami (tizim `ssh`, kutubxona emas)
├── checks.py    # Buyruqlar va parserlar
├── state.py     # Holat saqlash
├── notify.py    # Alert + cooldown
├── diagnose.py  # LLM diagnostika
├── schema.py    # Monitor migratsiyalari (versiya 200–299)
└── __main__.py  # CLI + scheduler
```

**Dizayn qoidasi:** modul `core/` ga faqat **ikkinchi** ishlatuvchi paydo
bo'lganda ko'chiriladi. Bitta ishlatuvchisi bor abstraksiya — abstraksiya
emas, ortiqcha qatlam.

Ikkala agent bitta SQLite faylni ishlatadi: `llm_calls` bo'linmasligi
kerak. Migratsiyalar versiya diapazonlari bilan ajratilgan,
`bot db migrate` ikkalasini ham qo'llaydi.

## Xarajat nazorati

Har bir LLM chaqiruvi `llm_calls` jadvaliga yoziladi (model, tokenlar, narx).
Kunlik limit `models.yaml` da (`limits.daily_cost_usd`) — oshsa bot to'xtaydi va alert yuboradi.

Bosqichlarga alohida limit qo'yish mumkin (`limits.stage_limits`) — bot
limitni to'ldirsa monitor diagnostikasi bloklanmasligi uchun.

```bash
uv run bot cost           # bugungi xarajat
uv run bot cost --days 7  # oxirgi 7 kun
```

## Litsenziya

MIT

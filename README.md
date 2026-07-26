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

# 5. Bir marta yig'ish + dedup
uv run bot collect
uv run bot dedup

# 6. Klasterlarni ko'rish
uv run bot clusters list
uv run bot clusters show <id>
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

Maxfiy ma'lumotlar (API kalitlar) faqat `.env` faylida — YAML'ga yozilmaydi.

## Loyiha strukturasi

```
bot/
├── collector/   # Manba adapterlari (rss.py, hn.py, ...)
├── dedup/       # Embedding + klasterlash
├── rank/        # LLM baholash
├── enricher/    # Web search + sahifa fetch
├── writer/      # Post generatsiya
├── publisher/   # Telegram + approval flow
├── llm/         # OpenRouter klienti — barcha LLM chaqiruvlar shu yerdan
├── db/          # SQLite sxema va migratsiyalar
├── config.py    # Konfiguratsiya yuklash
└── __main__.py  # CLI + scheduler
```

**Dizayn qoidasi:** modullar bir-biriga bog'lanmagan (loosely coupled) — keyinchalik
platformaga ajratib olish uchun. Barcha LLM chaqiruvlar `bot/llm/` orqali o'tadi.

## Xarajat nazorati

Har bir LLM chaqiruvi `llm_calls` jadvaliga yoziladi (model, tokenlar, narx).
Kunlik limit `models.yaml` da (`limits.daily_cost_usd`) — oshsa bot to'xtaydi va alert yuboradi.

```bash
uv run bot cost           # bugungi xarajat
uv run bot cost --days 7  # oxirgi 7 kun
```

## Litsenziya

MIT

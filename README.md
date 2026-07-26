# AI Platform — Loyiha hujjatlari

> Self-hosted, open-source AI orkestratsiya platformasi.
> Bosqich 1: Telegram AI yangiliklar boti. Bosqich 2: Bot asosida umumiy platformaga evolyutsiya.

---

## Loyiha haqida qisqacha

**Muammo:** Bugungi kunda AI bilan jiddiy ishlash uchun bir nechta alohida vositalardan foydalanishga majbursiz — Claude, ChatGPT, Gemini, OpenRouter, Claude Code, turli deploy xizmatlari. Ularning har biri o'z ekotizimiga bog'laydi, o'zaro integratsiya yo'q, va murakkab ishlar (server boshqaruvi, deploy) hali ham qo'lda yoki terminal orqali bajariladi.

**Yechim:** Barcha AI provayderlar, agentlar, serverlar va vositalarni bitta self-hosted platformada birlashtirish. AI chat orqali yuqori darajadagi buyruq beriladi, platforma orqa fonda kerakli vositalarni (masalan Claude Code'ni tmux sessiyasida) ishga tushirib, ishni bajaradi.

**Falsafa:**
- Avval o'zim uchun quraman — abstraksiyalar real ehtiyojdan tug'iladi, oldindan o'ylab topilmaydi
- Open source va self-hosted — hech qanday vendor lock-in, ma'lumotlar o'z serverimda
- Pastdan yuqoriga — avval ishlaydigan konkret yechim (bot), keyin undan platforma o'sib chiqadi
- Progressive disclosure — oddiy foydalanuvchi murakkablikni ko'rmaydi, professional hamma narsaga kirisha oladi
- Xavfsizlik dizaynning bir qismi — AI'ga parol berilmaydi, har bir amal ruxsat darajasiga ega, hamma narsa audit log'da

## Hujjatlar tarkibi

| Fayl | Mazmuni |
|---|---|
| [01-telegram-bot.md](01-telegram-bot.md) | Birinchi bosqich: AI yangiliklar botining to'liq spetsifikatsiyasi va arxitekturasi |
| [02-ai-platform.md](02-ai-platform.md) | Ikkinchi bosqich: botdan platformaga evolyutsiya, modullar, arxitektura |
| [03-roadmap.md](03-roadmap.md) | Bosqichma-bosqich reja va muvaffaqiyat mezonlari |
| [04-xavflar.md](04-xavflar.md) | Tanqidiy tahlil: xavflar, zaif tomonlar va mudofaa strategiyalari |

## Kontekst: mening holatim

- 5 ta server mavjud, platformaga ulanadi
- Claude, ChatGPT, Gemini obunalari + OpenRouter orqali yangi modellarni sinash odati
- Asosiy ish muhiti — web
- Birinchi real ehtiyoj: Telegram kanalim uchun to'liq avtonom AI yangiliklar boti

## Ilhom manbalari va o'xshash loyihalar

- **OpenClaw / Hermes** — agent qatlamining yuqori darajasi; bir kishi o'zi uchun qurgan open-source loyihalarning tarqalish modeli
- **MCP (Model Context Protocol)** — integratsiya standarti; o'z standartimizni o'ylab topmasdan mavjudiga tayanamiz
- **Coolify / Dokploy** — self-hosted server boshqaruv modeli, agent-daemon arxitekturasi
- **OpenRouter** — model-agnostik LLM kirish qatlami

## Asosiy tamoyil

> Platformaning to'g'ri abstraksiyalari faqat real ishlatishdan tug'iladi.
> Bot — birinchi "skill". Ikkinchi use case paydo bo'lganda umumiy naqshlar o'zi ko'rinadi.
> Platforma yuqoridan pastga loyihalanmaydi — pastdan yuqoriga o'sadi.

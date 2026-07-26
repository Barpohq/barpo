# Bosqich 2 — AI Platform

> Botdan o'sib chiqadigan self-hosted, open-source AI orkestratsiya platformasi.
> OpenClaw/Hermes kabi agentlarning eng yuqori qatlami: barcha AI vositalar, serverlar va agentlar bitta boshqaruv nuqtasida.

---

## 1. Vizyon

**Bir jumlada:** "AI vositalar uchun operatsion tizim — barcha modellar, agentlar, serverlar va deploy bitta chat va bitta klik masofasida, o'z serveringda, o'z nazoratingda."

Platforma hal qiladigan muammolar (o'z tajribamdan):

1. **Tarqoqlik** — Claude, ChatGPT, Gemini, OpenRouter alohida-alohida; bitta interfeys yo'q
2. **Integratsiyasizlik** — AI vositalar bir-birini bilmaydi; chat'da aytilgan ish Claude Code'da qo'lda qayta boshlanadi
3. **Deploy og'rig'i** — JS'dan boshqa tillar uchun oddiy deploy yechimi yo'q; har safar qo'lda server sozlash
4. **Xavfsizlik madaniyati** — odamlar AI'ga server parollarini to'g'ridan-to'g'ri berishyapti; buning to'g'ri yo'li bo'lishi kerak
5. **Har bir yangi avtomatlashtirish nol'dan** — bot kabi loyihalar uchun tayyor modullar yo'q, hammasi qo'lda birlashtiriladi

## 2. Evolyutsiya yo'li: bot → platforma

Platforma oldindan loyihalanmaydi — botdan modullar ajratib olinadi:

| Bot moduli | Platforma komponenti bo'ladi |
|---|---|
| `bot/llm/` (OpenRouter klienti) | **LLM Router** — barcha provayderlar, model tanlash, fallback, xarajat hisobi |
| `bot/collector/` | **Data Sources** — RSS/API/scrape adapterlari, har qanday agent uchun |
| Scheduler + pipeline | **Workflow Engine** — bosqichli agent oqimlarini ta'riflash va ishga tushirish |
| Approval flow | **Human-in-the-loop** — har qanday agent uchun tasdiqlash qatlami |
| Publisher (Telegram) | **Channels** — Telegram/Slack/Email chiqish adapterlari |
| SQLite holat boshqaruvi | **State Store** — agent holatlari, tarix, audit log |

**Qoida:** modul platformaga faqat *ikkinchi* use case unga muhtoj bo'lganda ko'chiriladi. Bitta ishlatuvchisi bor abstraksiya — bu abstraksiya emas, ortiqcha qatlam.

## 3. Maqsadli arxitektura

```
┌─────────────────────────────────────────────────────────────┐
│                      Web UI (chat-first)                     │
│   Oddiy rejim: faqat chat  │  Pro rejim: terminal, loglar,   │
│                            │  agent boshqaruvi, konfiglar    │
├─────────────────────────────────────────────────────────────┤
│                     Orchestrator Core                        │
│  Workflow Engine │ Agent Manager │ Human-in-the-loop │ Audit │
├──────────────┬──────────────┬───────────────┬───────────────┤
│  LLM Router  │  Skill Store │  Tool Runtime │ Server Agents  │
│  (barcha     │  (o'rnatila- │  (Claude Code │ (5 serverim-   │
│  provayder + │  digan skill │  tmux'da,     │ dagi daemon-   │
│  OpenRouter) │  paketlari)  │  MCP, bash)   │ lar)           │
├──────────────┴──────────────┴───────────────┴───────────────┤
│              State Store (holat, tarix, audit log)           │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 LLM Router

- Barcha provayderlar (Claude, OpenAI, Gemini, OpenRouter) yagona interfeys ostida
- BYOK — o'z API kalitlarim/obunalarim ishlatiladi
- Vazifa turiga qarab model tanlash qoidalari (`models.yaml`): arzon ishlar arzon modelga, muhim ishlar kuchli modelga
- Fallback: provayder ishlamasa avtomatik boshqasiga o'tish
- Xarajat hisobi: qaysi agent qancha token yeyapti — hammasi ko'rinadi

### 3.2 Tool Runtime

- **Claude Code integratsiyasi:** chat'da "shu repo'ga X feature qo'sh" deyilsa, orchestrator tmux sessiyasida Claude Code'ni ishga tushiradi, jarayonni kuzatadi, natijani chat'ga qaytaradi. Pro rejimda tmux sessiyasini jonli ko'rish mumkin, oddiy rejimda faqat natija ko'rinadi
- **MCP klienti:** o'z standartimizni o'ylab topmaymiz — MCP serverlarni ulaymiz (mavjud ekotizimdan foydalanamiz)
- **Sandbox:** har bir tool alohida konteynerda cheklangan huquqlar bilan

### 3.3 Server Agents

Server parolini platformaga berish YO'Q. Buning o'rniga:

```
Platforma ◀──── outbound WebSocket ──── Agent daemon (har bir serverda)
```

- Har serverga kichik agent o'rnatiladi (`curl ... | sh` bilan bitta buyruq)
- Agent platformaga **o'zi** ulanadi (outbound) — serverda port ochilmaydi, parol uzatilmaydi
- Agent faqat ruxsat berilgan amallar ro'yxatiga ega

**Ruxsat darajalari:**

| Daraja | Amallar | Rejim |
|---|---|---|
| O'qish | loglar, status, metrikalar | Avtomatik |
| O'zgartirish | deploy, restart, config | Sozlanadigan (avto yoki tasdiq bilan) |
| Xavfli | rm -rf, DROP DATABASE, DNS, foydalanuvchi boshqaruvi | Har doim inson tasdig'i |

- Har bir amal audit log'da: kim (qaysi agent/LLM), nima, qachon, natija
- Preview: o'zgarishlar avval vaqtinchalik muhitda ko'rsatiladi, tasdiqdan keyin production

### 3.4 Skill Store

- Skill = deklarativ paket: manifest (nima qiladi, qanday ruxsatlar kerak) + prompt'lar + kod
- Deploy skill'lar birinchi navbatda: "Django deploy", "Rust binary deploy", "Docker compose deploy" — har qanday til uchun bir xil tajriba
- UI orqali bir klik o'rnatish (App Store modeli), lekin o'rnatishda ruxsatlar ro'yxati ko'rsatiladi (Android permission modeli)
- Open source bo'lgani uchun: jamiyat o'z skill'larini yozishi mumkin, lekin bu maqsad emas, bonus
- Xavfsizlik: skill sandbox'da ishlaydi, so'ramagan ruxsatiga ega bo'lmaydi (store'dan kelgan skill ichidagi prompt injection'ga qarshi asosiy himoya)

### 3.5 UI falsafasi — progressive disclosure

- **Default:** faqat chat. "Botim nima qildi bugun?", "shu loyihani serverimga deploy qil" — hammasi oddiy til bilan
- **Pro rejim (bitta tugma):** tmux sessiyalar, agent loglari, workflow editor, xarajat dashboardi, audit log
- Hech kim cheklanmaydi, hech kimga majburlanmaydi — ko'rishni istamagan ko'rmaydi

## 4. Xavfsizlik tamoyillari (birinchi kundan)

1. Parollar/kalitlar hech qachon LLM kontekstiga tushmaydi — agent daemon modeli
2. Har bir amal — eng kam huquq tamoyili (least privilege)
3. Xavfli amallar har doim inson tasdig'i bilan (auto rejimda ham)
4. To'liq audit log — o'zgarmas (append-only)
5. Prompt injection'ga hushyorlik: tashqi kontentdan (loglar, web sahifalar, skill'lar) kelgan matn hech qachon to'g'ridan-to'g'ri buyruq sifatida bajarilmaydi
6. Self-hosted — ma'lumotlar mening serverimdan chiqmaydi

## 5. Nima QILMAYMIZ (scope chegarasi)

- ❌ O'z standartimizni yaratmaymiz — MCP va mavjud standartlarga tayanamiz
- ❌ SaaS/biznes qurmaymiz — self-hosted open source, o'zim uchun
- ❌ Barcha auditoriyani ko'zlamaymiz — o'z ehtiyojlarim birinchi, qolgani bonus
- ❌ Store'ni "marketplace biznes" qilmaymiz — oddiy skill katalogi yetadi
- ❌ Model provayder bilan raqobat qilmaymiz — biz orkestratsiya qatlamimiz, model emas

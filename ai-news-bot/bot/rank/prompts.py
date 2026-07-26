"""Rank bosqichi promptlari.

Prompt kanal profilidan (`channel.yaml`) quriladi — kod o'zgartirmasdan
auditoriya va mavzularni sozlash mumkin.

Dizayn qarorlari:
  - Batch: bir chaqiruvda bir nechta klaster baholanadi (arzon va tez).
  - JSON: model faqat JSON qaytaradi, `id` orqali klasterga bog'lanadi.
  - Izoh qisqa: `reason` debug va prompt tuning uchun, postga tushmaydi.
"""

from __future__ import annotations

import json
from typing import Any

# Kategoriyalar — schema.py dagi `clusters.category` bilan bir xil bo'lishi shart
CATEGORIES = ("model_release", "research", "tool", "business", "other")

SYSTEM_PROMPT = """Sen AI yangiliklari kanali uchun kontent tahlilchisisan.
Vazifang — yangiliklarni xolis baholash va kanalga mos kelmaydiganlarini filtrlash.

Sen qat'iy baholaysan: har kuni o'nlab yangilik keladi, lekin kanalga faqat
eng muhimlari chiqadi. Yuqori baho — istisno, o'rtacha baho — norma.

Javobingni faqat JSON sifatida qaytarasan, hech qanday izohsiz."""


def _rubric() -> str:
    """Baholash mezonlari — modelga aniq shkala berish uchun.

    Shkalasiz model hamma narsani 7-8 ga baholaydi (2026-07-26 sinovida
    kuzatilgan), shuning uchun har daraja misol bilan tavsiflanadi.
    """
    return """
BAHOLASH MEZONLARI

importance (1-10) — yangilikning AI sohasi uchun umumiy ahamiyati:
  9-10  Sohani o'zgartiradigan voqea: yirik model relizi (GPT, Claude, Gemini
        yangi avlodi), katta ilmiy yutuq, sohani qayta shakllantiruvchi bitim
  7-8   Muhim yangilik: sezilarli model yangilanishi, keng ishlatiladigan
        vositaning katta relizi, yirik investitsiya yoki sotib olish
  5-6   O'rtacha: foydali vosita, qiziqarli tadqiqot, o'rtacha biznes yangiligi
  3-4   Kichik: kichik yangilanish, mahalliy ahamiyatga ega xabar
  1-2   Ahamiyatsiz: takroriy fikr, eski yangilikning qayta hikoyasi

relevance (1-10) — shu KANAL auditoriyasiga qanchalik mos:
  9-10  Auditoriya darhol o'qiydi va amalda ishlatadi
  7-8   Qiziqarli, ko'pchilikka foydali
  5-6   Bir qismi qiziqadi
  3-4   Tor doiraga, ko'pchilikka begona
  1-2   Auditoriyaga umuman aloqasi yo'q

category — bittasini tanla:
  model_release  yangi model yoki model versiyasi e'lon qilindi
  research       ilmiy maqola, tadqiqot natijasi, benchmark
  tool           vosita, kutubxona, API, dasturchi asbobi
  business       investitsiya, sotib olish, kompaniya yangiliklari, siyosat
  other          yuqoridagilarning hech biriga tushmaydi

is_spam (true/false) — quyidagilardan biri bo'lsa true:
  - Reklama yoki sponsorlik posti, mahsulot sotish maqsadida yozilgan
  - Korporativ PR: yangilik emas, kompaniya haqida maqtov matni
  - Clickbait: sarlavha va'da qilgan narsa matnda yo'q
  - Tasdiqlanmagan mish-mish ("aytishlaricha", "manbalar da'vo qilmoqda")
  - Kripto/NFT bilan aralash, AI faqat bahona sifatida ishlatilgan
  - Sifatsiz kontent-ferma matni yoki AI tomonidan avtomatik generatsiya

reason — 1 jumla o'zbek tilida: nima uchun shunday baholading.
""".strip()


def _channel_context(channel: dict[str, Any]) -> str:
    """channel.yaml dan auditoriya va mavzular bloki."""
    ch = channel.get("channel") or {}
    parts: list[str] = ["KANAL PROFILI"]

    if audience := (ch.get("audience") or "").strip():
        parts.append(f"\nAuditoriya:\n{audience}")

    if interests := ch.get("topics_of_interest"):
        listed = "\n".join(f"  - {t}" for t in interests)
        parts.append(f"\nQiziqarli mavzular:\n{listed}")

    if avoid := ch.get("topics_to_avoid"):
        listed = "\n".join(f"  - {t}" for t in avoid)
        parts.append(f"\nKanalga chiqmaydigan mavzular:\n{listed}")

    return "\n".join(parts)


def _format_cluster(cluster: dict[str, Any], *, max_content: int = 700) -> str:
    """Bitta klasterni promptga tushadigan matnga aylantirish.

    Matn qisqartiriladi: rank arzon bosqich, to'liq matn Enricher ishi.
    Bir nechta manba bo'lsa — bu signal (yangilik keng tarqalgan), shuning
    uchun manbalar soni ko'rsatiladi.
    """
    lines = [f"id: {cluster['id']}", f"sarlavha: {cluster['title']}"]

    if sources := cluster.get("sources"):
        lines.append(f"manbalar ({len(sources)}): {', '.join(sources)}")

    if published := cluster.get("published_at"):
        lines.append(f"sana: {published}")

    body = (cluster.get("content") or cluster.get("summary") or "").strip()
    if body:
        body = " ".join(body.split())
        if len(body) > max_content:
            body = body[:max_content] + "…"
        lines.append(f"matn: {body}")

    return "\n".join(lines)


def build_rank_prompt(clusters: list[dict[str, Any]], channel: dict[str, Any]) -> str:
    """Bir nechta klaster uchun batch baholash prompti."""
    items = "\n\n".join(f"───\n{_format_cluster(c)}" for c in clusters)
    ids = [c["id"] for c in clusters]

    schema_example = json.dumps(
        {
            "results": [
                {
                    "id": ids[0],
                    "importance": 7,
                    "relevance": 8,
                    "category": "model_release",
                    "is_spam": False,
                    "reason": "Keng ishlatiladigan modelning yangi versiyasi.",
                }
            ]
        },
        ensure_ascii=False,
        indent=2,
    )

    return f"""{_channel_context(channel)}

{_rubric()}

BAHOLANADIGAN YANGILIKLAR ({len(clusters)} ta)

{items}

───

Har bir yangilikni baholab, faqat quyidagi formatdagi JSON qaytar:

{schema_example}

Talablar:
  - `results` ichida aynan {len(clusters)} ta element bo'lsin
  - `id` yuqoridagi id'lardan biri: {ids}
  - Har bir id aynan bir marta uchrasin
  - `importance` va `relevance` — 1 dan 10 gacha butun son
  - `category` — {", ".join(CATEGORIES)} dan biri
  - `is_spam` — true yoki false
  - `reason` — bitta qisqa jumla o'zbek tilida
  - JSON'dan boshqa hech narsa yozma"""

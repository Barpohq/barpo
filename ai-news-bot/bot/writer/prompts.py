"""Writer bosqichi promptlari.

Prompt to'liq `channel.yaml` dan quriladi: post tuzilishi, uslub qoidalari,
few-shot namunalar va format cheklovlari. Kod o'zgartirmasdan kanal
uslubini sozlash mumkin.

Muhim: kanal imzosi promptga kirmaydi — uni Publisher qo'shadi. Model
imzoni yozishga urinmasligi kerak, aks holda username'ni xato yozishi
yoki takrorlashi mumkin.
"""

from __future__ import annotations

from typing import Any

SYSTEM_PROMPT = """Sen o'zbek tilidagi AI yangiliklar kanali uchun muharrirsan.

Vazifang — ingliz tilidagi yangilikni o'qib, kanalning aniq formatida
o'zbekcha post yozish. Sen tarjimon emassan: manbani so'zma-so'z
o'girmaysan, balki mohiyatini ajratib, o'z auditoriyangga tushunarli
qilib qayta yozasan.

Yozganingda ikki narsa muqaddas:
1. Faktlar — manbada yo'q narsani hech qachon qo'shmaysan
2. Format — kanalning tuzilishi va uslub qoidalari qat'iy

Javob sifatida faqat post matnini qaytarasan, hech qanday izohsiz."""


def _channel_block(channel: dict[str, Any]) -> str:
    """Auditoriya profili — post kim uchun yozilayotganini belgilaydi.

    `topics_of_interest` bu yerga kirmaydi: u Rank bosqichi uchun —
    "bu yangilik kanalga mosmi?" degan savolga javob beradi. Writer'ga
    yangilik allaqachon tanlangan holda keladi, ro'yxat esa promptni
    uzaytiradi va hech narsa qo'shmaydi.
    """
    ch = channel.get("channel") or {}
    audience = (ch.get("audience") or "").strip()
    return f"AUDITORIYA\n{audience}" if audience else ""


def _structure_block(channel: dict[str, Any]) -> str:
    """Post tuzilishi — har blokning vazifasi va hajmi."""
    structure = channel.get("post_structure") or {}
    blocks = structure.get("blocks") or []
    if not blocks:
        return ""

    lines = ["POST TUZILISHI (tartib qat'iy)"]
    position = 0
    for block in blocks:
        name = block.get("name", "")
        # Imzoni Publisher qo'shadi — model uni yozmasligi kerak
        if name == "imzo":
            continue
        position += 1
        rule = (block.get("rule") or "").strip()
        indented = "\n".join(f"   {line}" for line in rule.split("\n"))
        lines.append(f"\n{position}. {name}\n{indented}")

    return "\n".join(lines)


def _style_block(channel: dict[str, Any]) -> str:
    rules = channel.get("style_rules") or []
    if not rules:
        return ""
    listed = "\n".join(f"  - {rule}" for rule in rules)
    return f"USLUB QOIDALARI\n{listed}"


def _format_block(channel: dict[str, Any], *, budget: int, target: int) -> str:
    """Texnik cheklovlar: uzunlik, ruxsat etilgan teglar."""
    fmt = channel.get("format") or {}
    allowed = fmt.get("allowed_tags") or []
    tags = ", ".join(f"<{t}>" for t in allowed)

    lines = [
        "TEXNIK CHEKLOVLAR",
        # Maqsadli uzunlik ham aytiladi: faqat maksimal berilsa model
        # byudjetni to'ldirishga intiladi va ortiqcha blok qo'shadi
        f"  - Maqbul uzunlik: {target} belgi atrofida",
        f"  - Qat'iy chegara: {budget} belgi (oshsa post rad etiladi)",
        "  - Yuqoridagi bloklardan boshqa blok QO'SHILMAYDI —"
        " matn sig'masa qisqartiriladi, yangi abzats ochilmaydi",
        f"  - Faqat shu HTML teglar ishlaydi: {tags}",
        "  - <ul>, <li>, <br>, <p> ISHLAMAYDI — ro'yxat uchun '• ' belgisi",
    ]

    bullet_min = int(fmt.get("min_bullets", 0) or 0)
    bullet_max = int(fmt.get("max_bullets", 0) or 0)
    if bullet_max:
        lines.append(
            f"  - Ro'yxatda {bullet_min}-{bullet_max} punkt — ko'pi qabul qilinmaydi"
        )

    lines += [
        "  - & < > belgilari matnda &amp; &lt; &gt; ko'rinishida yoziladi",
        "  - Bloklar orasida bitta bo'sh qator",
    ]

    if fmt.get("emoji_policy") == "minimal":
        lines.append("  - Emoji faqat sarlavhada (🔹) va havolada (🔗)")
    elif fmt.get("emoji_policy") == "none":
        lines.append("  - Emoji ishlatilmaydi")

    return "\n".join(lines)


# Promptga tushadigan namunalar soni.
#
# Har namuna ~500 belgi (~125 token). 4 ta namuna promptning 35% ini
# egallaydi, lekin ular bir xil uslubni ko'rsatadi — model uchun 2 tasi
# ham yetarli signal. Xarajat: kuniga 6 post × 250 token × 30 kun =
# oyiga 45k input token tejaladi.
MAX_EXAMPLES = 2

# Manba matnining promptga tushadigan qismi (belgilarda).
#
# Enricher 6000 belgigacha beradi, lekin postdagi faktlar tahlili
# (2026-07-26) ko'rsatdiki, ular deyarli har doim matn boshida:
# to'rtta postda fakt pozitsiyalari 0-3300 oralig'ida, bittasida 5390.
# Maqola oxiri odatda marketing tafsilotlari, prompt namunalari va
# "shuningdek o'qing" bo'ladi.
#
# 3500 tanlandi: fakt yo'qotmaslik uchun zaxira bilan, lekin promptni
# sezilarli qisqartiradi.
MAX_SOURCE_TEXT = 3500


def _examples_block(channel: dict[str, Any], category: str) -> str:
    """Few-shot namunalar.

    Shu kategoriyaning namunasi birinchi qo'yiladi — model eng yaqin
    misolni ko'radi. Qolganlari uslubni mustahkamlash uchun.
    """
    posts = channel.get("few_shot_posts") or []
    if not posts:
        return ""

    same = [p for p in posts if p.get("category") == category]
    other = [p for p in posts if p.get("category") != category]
    ordered = same + other

    lines = ["NAMUNALAR (shu uslubda yoz)"]
    for example in ordered[:MAX_EXAMPLES]:
        body = (example.get("post") or "").strip()
        if not body:
            continue
        lines.append(f"\n--- {example.get('category', '')} ---\n{body}")

    return "\n".join(lines)


def trim_source(text: str, limit: int = MAX_SOURCE_TEXT) -> str:
    """Manba matnini qisqartirish — abzats chegarasida.

    O'rtasidan kesish jumlani buzadi va model uzilgan faktni noto'g'ri
    talqin qilishi mumkin, shuning uchun oxirgi to'liq abzatsda to'xtaymiz.
    """
    text = text.strip()
    if len(text) <= limit:
        return text

    cut = text[:limit]
    # Oxirgi abzats chegarasi (yoki jumla, agar abzats topilmasa)
    for separator in ("\n\n", ". "):
        index = cut.rfind(separator)
        # Juda erta kesilmasin — kamida yarmi qolsin
        if index > limit // 2:
            return cut[: index + len(separator)].strip()

    return cut.strip()


def signature_length(channel: dict[str, Any]) -> int:
    """Publisher qo'shadigan imzoning uzunligi.

    Writer'ning belgi byudjetidan chegirib tashlanadi — aks holda tayyor
    post imzo bilan birga chegaradan oshib ketadi.
    """
    fmt = channel.get("format") or {}
    if not fmt.get("include_channel_signature"):
        return 0

    username = ((channel.get("channel") or {}).get("username") or "").strip()
    if not username:
        return 0

    separator = (fmt.get("signature_separator") or "").strip()
    # "\n\n" + ajratkich + "\n" + username
    length = 2 + len(username)
    if separator:
        length += len(separator) + 1
    return length


def build_write_prompt(
    cluster: dict[str, Any],
    channel: dict[str, Any],
    *,
    budget: int,
    target: int | None = None,
    feedback: str = "",
) -> str:
    """Bitta klaster uchun post yozish prompti.

    `budget` — qat'iy chegara (imzo hisobga olingan).
    `target` — maqbul uzunlik; berilmasa byudjetning 70% i.
    `feedback` — oldingi urinish nima uchun rad etilgani (qayta yozishda).
    """
    if target is None:
        target = int(budget * 0.7)
    fmt = channel.get("format") or {}
    category = str(cluster.get("category") or "other")

    hashtags = list(fmt.get("hashtags") or [])
    if category_tag := (fmt.get("category_hashtags") or {}).get(category):
        hashtags.append(category_tag)
    hashtag_line = " ".join(hashtags)

    sections = [
        _channel_block(channel),
        _structure_block(channel),
        _style_block(channel),
        _format_block(channel, budget=budget, target=target),
        _examples_block(channel, category),
    ]

    source_text = trim_source(str(cluster.get("text") or ""))
    link = str(cluster.get("link") or "")

    task = f"""YANGILIK

Sarlavha: {cluster.get("title", "")}
Kategoriya: {category}
Manba havolasi: {link}

Matn:
{source_text}

───

VAZIFA

Yuqoridagi yangilikdan kanal uchun post yoz.

  - Hashtaglar: {hashtag_line}
  - Manba havolasi aynan shu bo'lsin: {link}
  - Kanal username'ini YOZMA — u avtomatik qo'shiladi
  - Uzunlik {target} belgi atrofida, {budget} dan oshmasin
  - Tuzilishdagi bloklardan boshqasi qo'shilmaydi

Faqat post matnini qaytar."""

    if feedback:
        task += f"""

DIQQAT — oldingi urinish qabul qilinmadi:
{feedback}

Shu kamchilikni tuzatib qayta yoz."""

    return "\n\n".join(part for part in [*sections, task] if part)

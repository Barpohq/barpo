"""Model versiyalarini ajratish — embedding'ning zaif joyini to'ldiradi.

Muammo: embedding modellari versiya raqamlariga deyarli sezgir emas.
Real o'lchov (bge-small):
    "Claude Opus 5"  ↔ "Claude Opus 4.7"   = 0.910
    "Gemini 3.5 Flash" ↔ "Gemini 2.5 Flash" = 0.966
Bu haqiqiy dublikatlarnikidan (0.887) ham yuqori — threshold bilan hal
qilib bo'lmaydi.

AI yangiliklar kanali uchun bu hal qiluvchi: model relizlari asosiy kontent
va ular aynan versiya raqami bilan farqlanadi. Shuning uchun klasterlashdan
oldin sarlavhalardagi mahsulot versiyalari solishtiriladi: agar ikkala
sarlavhada ham versiya bo'lsa va ular boshqa bo'lsa — bir klasterga tushmaydi.
"""

from __future__ import annotations

import re

# Mahsulot nomi + versiya: "Claude Opus 5", "GPT-4.1", "Gemini 3.5", "Llama 4"
# Nom qismi ixtiyoriy so'zlar zanjiri, versiya — raqam(lar).
_VERSION_PATTERN = re.compile(
    r"""
    \b
    (?P<product>
        gpt | claude | gemini | llama | mistral | qwen | grok | deepseek |
        phi | gemma | command | nova | sonnet | opus | haiku | o\d
    )
    [\s\-]*
    (?P<qualifier>opus|sonnet|haiku|pro|flash|lite|mini|nano|turbo|max)?
    [\s\-]*
    v?
    (?P<version>\d+(?:\.\d+)*)
    \b
    """,
    re.IGNORECASE | re.VERBOSE,
)


def extract_versions(text: str) -> set[tuple[str, str]]:
    """Matndan (mahsulot, versiya) juftliklarini ajratish.

    >>> sorted(extract_versions("Introducing Claude Opus 5"))
    [('claude', '5')]
    >>> sorted(extract_versions("Gemini 3.5 Flash vs Gemini 2.5 Flash"))
    [('gemini', '2.5'), ('gemini', '3.5')]
    """
    found: set[tuple[str, str]] = set()
    for match in _VERSION_PATTERN.finditer(text):
        product = match.group("product").lower()
        version = match.group("version")
        # "opus"/"sonnet" mustaqil mahsulot emas — Claude oilasi
        if product in {"opus", "sonnet", "haiku"}:
            product = "claude"
        found.add((product, version))
    return found


def extract_model_ids(text: str) -> set[str]:
    """Matndagi to'liq model identifikatorlari: variant + versiya.

    `extract_versions` dan farqi: bu yerda Claude oilasining variantlari
    (Opus / Sonnet / Haiku) alohida saqlanadi. Dedup uchun ular bir xil
    mahsulot, lekin "qaysi maqola aynan shu reliz haqida?" degan savolda
    Opus 5 va Sonnet 5 — butunlay boshqa yangilik.

    >>> sorted(extract_model_ids("Introducing Claude Opus 5"))
    ['claude-opus-5']
    >>> sorted(extract_model_ids("Claude Sonnet 5 vs Claude Opus 5"))
    ['claude-opus-5', 'claude-sonnet-5']
    >>> sorted(extract_model_ids("GPT-5.6 Sol preview"))
    ['gpt-5.6']
    """
    found: set[str] = set()
    for match in _VERSION_PATTERN.finditer(text):
        product = match.group("product").lower()
        qualifier = (match.group("qualifier") or "").lower()
        version = match.group("version")

        # "Claude Opus 5" — product=claude, qualifier=opus
        # "Opus 5"       — product=opus,   qualifier=None
        if product in {"opus", "sonnet", "haiku"}:
            qualifier = product
            product = "claude"

        parts = [product, qualifier, version] if qualifier else [product, version]
        found.add("-".join(parts))
    return found


def models_conflict(text_a: str, text_b: str) -> bool:
    """Ikki matn turli model variantlari haqidami?

    True — masalan biri Opus 5, ikkinchisi Sonnet 5 haqida.
    False — model topilmadi, yoki hech bo'lmasa bittasi umumiy.

    >>> models_conflict("Claude Opus 5 released", "Introducing Claude Sonnet 5")
    True
    >>> models_conflict("Anthropic launches Claude Opus 5", "Introducing Claude Opus 5")
    False
    >>> models_conflict("AI funding news", "Another AI story")
    False
    """
    ids_a = extract_model_ids(text_a)
    ids_b = extract_model_ids(text_b)
    if not ids_a or not ids_b:
        return False
    return not (ids_a & ids_b)


def versions_conflict(text_a: str, text_b: str) -> bool:
    """Ikki matnda bir mahsulotning turli versiyalari bormi?

    True — bu ikki yangilik turli relizlar haqida, birlashtirilmasligi kerak.
    False — konflikt yo'q (versiya yo'q, yoki bir xil, yoki turli mahsulotlar).

    >>> versions_conflict("Claude Opus 5 released", "Claude Opus 4.7 benchmarks")
    True
    >>> versions_conflict("Claude Opus 5 released", "Anthropic launches Opus 5")
    False
    >>> versions_conflict("New AI research", "Another AI paper")
    False
    """
    versions_a = extract_versions(text_a)
    versions_b = extract_versions(text_b)
    if not versions_a or not versions_b:
        return False

    products_a = {p for p, _ in versions_a}
    products_b = {p for p, _ in versions_b}
    shared = products_a & products_b
    if not shared:
        return False

    # Umumiy mahsulot bo'yicha versiyalar kesishadimi?
    for product in shared:
        va = {v for p, v in versions_a if p == product}
        vb = {v for p, v in versions_b if p == product}
        if va & vb:
            # Hech bo'lmasa bitta umumiy versiya bor — bir yangilik bo'lishi mumkin
            return False

    # Umumiy mahsulot bor, lekin umumiy versiya yo'q → turli relizlar
    return True

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

"""Yozilgan postni tekshirish va tozalash.

LLM javobiga ishonib bo'lmaydi: uzunlik oshib ketishi, ruxsatsiz teg
ishlatilishi, yoki markdown belgilari aralashib qolishi mumkin. Telegram
noto'g'ri HTML'ni butunlay rad etadi, shuning uchun yuborishdan oldin
tekshiramiz.

Tuzatib bo'ladigan nuqsonlar tuzatiladi (kod bloklari, ortiqcha bo'sh
qatorlar), tuzatib bo'lmaydiganlari xato sifatida qaytariladi — Writer
ularni feedback qilib modelga qaytaradi.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
from typing import Any

# Ochiluvchi/yopiluvchi teglar: <b>, </b>, <a href="...">
_TAG = re.compile(r"</?([a-zA-Z][a-zA-Z0-9]*)(?:\s[^>]*)?>")
# Model javobni ```html ... ``` blokiga o'rashi mumkin
_CODE_FENCE = re.compile(r"^```[a-zA-Z]*\n(.*?)\n?```$", re.DOTALL)
# Uchtadan ortiq ketma-ket qator uzilishi
_EXTRA_BLANK = re.compile(r"\n{3,}")
# Markdown qoldiqlari: **qalin**, __kursiv__
_MD_BOLD = re.compile(r"\*\*(.+?)\*\*", re.DOTALL)
_MD_ITALIC = re.compile(r"(?<!\w)__(.+?)__(?!\w)", re.DOTALL)
# Ro'yxat markerlari: "- " yoki "* " qator boshida
_MD_BULLET = re.compile(r"^[*-]\s+", re.MULTILINE)


@dataclass(slots=True)
class ValidationResult:
    """Tekshiruv natijasi."""

    text: str
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def feedback(self) -> str:
        """Modelga qaytariladigan izoh."""
        return "\n".join(f"- {e}" for e in self.errors)


def strip_code_fence(text: str) -> str:
    """```html ... ``` o'ramini olib tashlash."""
    stripped = text.strip()
    match = _CODE_FENCE.match(stripped)
    return match.group(1).strip() if match else stripped


def normalize_markdown(text: str) -> str:
    """Markdown belgilarini Telegram HTML'ga o'girish.

    Model ba'zan HTML o'rniga markdown yozadi — bu Telegram'da xom matn
    bo'lib ko'rinadi, shuning uchun tuzatamiz.
    """
    text = _MD_BOLD.sub(r"<b>\1</b>", text)
    text = _MD_ITALIC.sub(r"<i>\1</i>", text)
    text = _MD_BULLET.sub("• ", text)
    return text


def collapse_blank_lines(text: str) -> str:
    """Ikkitadan ortiq bo'sh qatorni bittaga tushirish."""
    return _EXTRA_BLANK.sub("\n\n", text).strip()


def find_forbidden_tags(text: str, allowed: set[str]) -> list[str]:
    """Ruxsat etilmagan HTML teglar ro'yxati."""
    found = {match.group(1).lower() for match in _TAG.finditer(text)}
    return sorted(found - allowed)


def find_unclosed_tags(text: str, allowed: set[str]) -> list[str]:
    """Yopilmagan yoki ortiqcha yopilgan teglar.

    Telegram bunday matnni butunlay rad etadi (400 Bad Request).
    """
    depth: dict[str, int] = {}
    for match in _TAG.finditer(text):
        name = match.group(1).lower()
        if name not in allowed:
            continue
        if match.group(0).startswith("</"):
            depth[name] = depth.get(name, 0) - 1
        else:
            depth[name] = depth.get(name, 0) + 1
    return sorted(name for name, count in depth.items() if count != 0)


def find_unescaped_entities(text: str, allowed: set[str]) -> bool:
    """Teg bo'lmagan '<' belgisi bormi.

    Masalan "a < b" yozilsa Telegram uni teg deb o'qishga urinadi.
    """
    without_tags = _TAG.sub("", text)
    # &lt; &gt; &amp; to'g'ri, yalang'och < esa yo'q
    return "<" in without_tags or ">" in without_tags


def has_link_to(text: str, url: str) -> bool:
    """Postda aynan shu manba havolasi bormi."""
    if not url:
        return True
    return f'href="{url}"' in text or f"href='{url}'" in text


def count_blocks(text: str) -> int:
    """Bo'sh qator bilan ajratilgan bloklar soni."""
    return len([b for b in text.split("\n\n") if b.strip()])


def max_blocks(channel: dict[str, Any]) -> int:
    """Tuzilishga ko'ra ruxsat etilgan maksimal blok soni.

    Imzo hisobga olinmaydi — u validatsiyadan keyin qo'shiladi.
    """
    structure = channel.get("post_structure") or {}
    blocks = structure.get("blocks") or []
    return len([b for b in blocks if b.get("name") != "imzo"])


def validate_post(
    raw_text: str,
    *,
    channel: dict[str, Any],
    max_length: int,
    expected_link: str = "",
) -> ValidationResult:
    """Postni tekshirish va tozalash.

    Tuzatib bo'ladigani tuzatiladi, qolgani xato sifatida qaytariladi.
    """
    fmt = channel.get("format") or {}
    allowed = {str(t).lower() for t in (fmt.get("allowed_tags") or [])}

    text = strip_code_fence(raw_text)
    text = normalize_markdown(text)
    text = collapse_blank_lines(text)

    result = ValidationResult(text=text)

    if not text:
        result.errors.append("Post bo'sh")
        return result

    if len(text) > max_length:
        result.errors.append(
            f"Post juda uzun: {len(text)} belgi, ruxsat {max_length}. "
            f"{len(text) - max_length} belgi qisqartirilishi kerak."
        )

    if forbidden := find_forbidden_tags(text, allowed):
        listed = ", ".join(f"<{t}>" for t in forbidden)
        result.errors.append(
            f"Telegram qo'llab-quvvatlamaydigan teglar: {listed}. "
            f"Ro'yxat uchun '• ' belgisini ishlating."
        )

    if unclosed := find_unclosed_tags(text, allowed):
        listed = ", ".join(f"<{t}>" for t in unclosed)
        result.errors.append(f"Yopilmagan yoki ortiqcha yopilgan teglar: {listed}")

    if find_unescaped_entities(text, allowed):
        result.errors.append(
            "Matnda escape qilinmagan < yoki > belgisi bor — "
            "&lt; va &gt; ko'rinishida yozing"
        )

    if expected_link and not has_link_to(text, expected_link):
        result.errors.append(f"Manba havolasi yo'q yoki noto'g'ri. Kerak: {expected_link}")

    # Tuzilishdan tashqari blok — model qo'shimcha abzats qo'shib yuborgan
    allowed_blocks = max_blocks(channel)
    actual_blocks = count_blocks(text)
    if allowed_blocks and actual_blocks > allowed_blocks:
        result.errors.append(
            f"Ortiqcha blok: {actual_blocks} ta, tuzilishda {allowed_blocks} ta. "
            f"Qo'shimcha abzatsni olib tashlang yoki mavjud blokka qo'shing."
        )

    # Ogohlantirishlar — post rad etilmaydi, lekin log'ga tushadi
    if (username := ((channel.get("channel") or {}).get("username") or "")) and username in text:
        result.warnings.append("Model kanal username'ini yozgan — Publisher takrorlamasin")

    return result


def append_signature(text: str, channel: dict[str, Any]) -> str:
    """Post oxiriga kanal imzosini qo'shish.

    Writer emas, shu funksiya qo'shadi: imzo har postda bir xil, LLM'ga
    ishonib o'tirishning hojati yo'q.
    """
    fmt = channel.get("format") or {}
    if not fmt.get("include_channel_signature"):
        return text

    username = ((channel.get("channel") or {}).get("username") or "").strip()
    if not username:
        return text

    # Model o'zi yozib qo'ygan bo'lsa takrorlamaymiz
    if username in text:
        return text

    separator = (fmt.get("signature_separator") or "").strip()
    tail = f"\n{separator}\n{username}" if separator else f"\n{username}"
    return f"{text.rstrip()}\n{tail}"


def escape(text: str) -> str:
    """Foydalanuvchi matnini HTML sifatida xavfsiz qilish."""
    return html.escape(text, quote=False)

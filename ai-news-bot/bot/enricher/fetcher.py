"""Maqola sahifasidan to'liq matn olish.

Feed'lardagi matn qisqa (o'rtacha ~130 belgi — asosan sarlavha + anons),
Writer uchun bu yetarli emas. Aniq maqola URL'i bo'lsa sahifani ochib
asosiy matnni ajratamiz.

Tashqi kutubxonasiz: HTML'dan skript/stil/navigatsiya olib tashlanadi,
qolgan matn bloklaridan eng zichi tanlanadi. Bu mukammal emas, lekin
LLM'ga kontekst berish uchun yetarli va bog'liqlik qo'shmaydi.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import httpx

from bot.collector.base import clean_text
from core.logging_setup import get_logger

log = get_logger(__name__)

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

# Sahifadan olinadigan maksimal matn (belgilarda) — LLM konteksti uchun
MAX_TEXT_LENGTH = 6000

# Shundan qisqa matn Writer uchun foydasiz — boyitilmagan deb qaraladi
MIN_USEFUL_TEXT = 200

# Matn bo'lmagan bloklar — butunlay olib tashlanadi
_NOISE_BLOCKS = re.compile(
    r"<(script|style|noscript|svg|head|nav|header|footer|aside|form|iframe)\b[^>]*>.*?</\1>",
    re.IGNORECASE | re.DOTALL,
)
_COMMENTS = re.compile(r"<!--.*?-->", re.DOTALL)
_WHITESPACE = re.compile(r"\s+")
# Paragraf chegaralari — matnni bloklarga bo'lish uchun
_BLOCK_END = re.compile(r"</(p|div|section|article|li|h[1-6]|br)\s*>", re.IGNORECASE)


class FetchError(RuntimeError):
    """Sahifani olishda xato."""


@dataclass(slots=True)
class Article:
    """Sahifadan ajratilgan maqola."""

    url: str
    text: str
    title: str = ""
    image_url: str = ""

    @property
    def is_useful(self) -> bool:
        """Matn Writer uchun foydali uzunlikdami."""
        return len(self.text) >= MIN_USEFUL_TEXT


def _meta_content(html: str, *keys: str) -> str:
    """<meta property="og:..." content="..."> qiymatini olish."""
    for key in keys:
        pattern = re.compile(
            rf'<meta[^>]+(?:property|name)=["\']{re.escape(key)}["\'][^>]*>',
            re.IGNORECASE,
        )
        match = pattern.search(html)
        if not match:
            continue
        content = re.search(r'content=["\'](.*?)["\']', match.group(0), re.IGNORECASE | re.DOTALL)
        if content and content.group(1).strip():
            return clean_text(content.group(1))
    return ""


def extract_text(html: str) -> str:
    """HTML'dan asosiy matnni ajratish.

    Yondashuv: shovqin bloklarini olib tashlab, qolgan matnni paragraflarga
    bo'lamiz va faqat "gapga o'xshaganlarini" qoldiramiz. Menyu va tugma
    matnlari qisqa bo'lgani uchun tabiiy ravishda tushib qoladi.
    """
    if not html:
        return ""

    cleaned = _COMMENTS.sub(" ", html)
    # Ba'zi sahifalarda teglar ichma-ich — bir necha marta tozalaymiz
    for _ in range(3):
        cleaned, count = _NOISE_BLOCKS.subn(" ", cleaned)
        if not count:
            break

    # HTML manba kodidagi qator uzilishlari mazmunli emas: bitta paragraf
    # bir necha qatorga bo'lingan bo'lishi mumkin. Avval ularni bo'shliqqa
    # aylantiramiz, keyin faqat blok chegaralari bo'yicha bo'lamiz.
    cleaned = _WHITESPACE.sub(" ", cleaned)
    cleaned = _BLOCK_END.sub("\n", cleaned)

    paragraphs: list[str] = []
    for chunk in cleaned.split("\n"):
        text = clean_text(chunk)
        # Gap belgisi: yetarli uzun va ichida bo'shliq bor
        if len(text) >= 80 and " " in text:
            paragraphs.append(text)

    if not paragraphs:
        return ""

    # Takrorlarni olib tashlash (sahifada bir xil blok bir necha marta)
    seen: set[str] = set()
    unique: list[str] = []
    for para in paragraphs:
        key = para[:120]
        if key in seen:
            continue
        seen.add(key)
        unique.append(para)

    return "\n\n".join(unique)[:MAX_TEXT_LENGTH]


# Markdown navigatsiya qatorlari: [Skip to content](#main), menyu havolalari
_MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
# Markdown sarlavha belgilari va ro'yxat markerlari qator boshida
_MD_DECORATION = re.compile(r"^\s*(#{1,6}\s+|[*+-]\s+|>\s+)", re.MULTILINE)


def clean_markdown(text: str) -> str:
    """Tavily'ning markdown matnidan navigatsiya shovqinini olib tashlash.

    Search yo'li bilan kelgan matn sahifaning to'liq markdown nusxasi —
    ichida menyu, "Skip to content", havolalar ro'yxati bo'ladi. Fetch
    yo'lida bu HTML darajasida tozalanadi; bu yerda markdown darajasida.
    """
    if not text:
        return ""

    # Havolalarni matniga almashtiramiz: [Claude](https://x) → Claude
    without_links = _MD_LINK.sub(r"\1", text)
    without_decoration = _MD_DECORATION.sub("", without_links)

    paragraphs: list[str] = []
    seen: set[str] = set()
    for chunk in without_decoration.split("\n"):
        line = _WHITESPACE.sub(" ", chunk).strip()
        # Gap belgisi: yetarli uzun va ichida bo'shliq bor (extract_text
        # bilan bir xil mezon — menyu elementlari qisqa bo'ladi)
        if len(line) < 80 or " " not in line:
            continue
        key = line[:120]
        if key in seen:
            continue
        seen.add(key)
        paragraphs.append(line)

    return "\n\n".join(paragraphs)[:MAX_TEXT_LENGTH]


def fetch_article(url: str, *, timeout: float = 20.0) -> Article:
    """Sahifani ochib matn va metama'lumotni ajratish."""
    try:
        with httpx.Client(
            timeout=timeout,
            follow_redirects=True,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
            },
        ) as client:
            response = client.get(url)
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise FetchError(f"HTTP {exc.response.status_code}") from exc
    except httpx.RequestError as exc:
        raise FetchError(f"tarmoq xatosi: {exc}") from exc

    content_type = response.headers.get("content-type", "")
    if "html" not in content_type.lower():
        raise FetchError(f"HTML emas: {content_type or 'noma’lum'}")

    html = response.text
    return Article(
        url=str(response.url),
        text=extract_text(html),
        title=_meta_content(html, "og:title", "twitter:title"),
        image_url=_meta_content(html, "og:image", "twitter:image"),
    )

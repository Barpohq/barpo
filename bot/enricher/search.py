"""Tavily web search klienti.

Agregatordan kelgan klasterlarda aniq maqola URL'i yo'q — faqat nashriyot
domeni (`https://siliconangle.com`). Sarlavha bo'yicha qidirib, aniq
maqolani va uning matnini topamiz.

Tavily tanlangani: `include_raw_content` bilan bitta so'rovda ham URL, ham
tozalangan matn qaytadi — alohida fetch qadami kerak emas.

Xarajat: basic qidiruv = 1 kredit, oyiga 1000 kredit bepul.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from core.config import env_str
from core.logging_setup import get_logger

log = get_logger(__name__)

API_URL = "https://api.tavily.com/search"

# Vaqtinchalik xatolar — qayta urinish mantiqiy
RETRYABLE_STATUS = {429, 500, 502, 503, 504}


class SearchError(RuntimeError):
    """Qidiruv bilan bog'liq umumiy xato."""


class SearchUnavailable(SearchError):
    """Kalit yo'q yoki limit tugagan — qidiruvsiz davom etamiz."""


@dataclass(slots=True)
class SearchResult:
    """Bitta qidiruv natijasi."""

    title: str
    url: str
    content: str
    raw_content: str = ""
    score: float = 0.0

    @property
    def best_text(self) -> str:
        """Eng to'liq matn: raw_content > content."""
        return self.raw_content or self.content


def is_configured() -> bool:
    """Tavily kaliti mavjudmi. Yo'q bo'lsa Enricher qidiruvsiz ishlaydi."""
    return bool(env_str("TAVILY_API_KEY"))


class SearchClient:
    """Tavily API klienti."""

    def __init__(self, timeout: float = 30.0) -> None:
        self._api_key = env_str("TAVILY_API_KEY")
        if not self._api_key:
            raise SearchUnavailable(
                "TAVILY_API_KEY belgilanmagan. .env.example dan nusxa oling yoki "
                "qidiruvsiz ishlash uchun `--no-search` ishlating."
            )
        self._client = httpx.Client(
            timeout=timeout,
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> SearchClient:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def search(
        self,
        query: str,
        *,
        max_results: int = 5,
        include_domains: list[str] | None = None,
        days: int | None = 14,
        with_content: bool = True,
    ) -> list[SearchResult]:
        """Qidiruv. Natijalar reyting bo'yicha kamayish tartibida.

        `include_domains` — faqat shu domenlardan (nashriyot ma'lum bo'lsa).
        `days` — shu kunlar ichidagi natijalar (eski maqolani tortmaslik uchun).
        """
        payload: dict[str, Any] = {
            "query": query,
            "max_results": max_results,
            "search_depth": "basic",  # 1 kredit; advanced 2 kredit va bu yerda ortiqcha
            "topic": "news",
        }
        if with_content:
            # Bitta so'rovda matn ham keladi — alohida fetch kerak emas
            payload["include_raw_content"] = "markdown"
        if include_domains:
            payload["include_domains"] = include_domains
        if days:
            payload["time_range"] = "week" if days <= 7 else "month"

        data = self._post(payload)

        results: list[SearchResult] = []
        for entry in data.get("results") or []:
            if not isinstance(entry, dict):
                continue
            url = entry.get("url")
            if not url:
                continue
            results.append(
                SearchResult(
                    title=str(entry.get("title") or ""),
                    url=str(url),
                    content=str(entry.get("content") or ""),
                    raw_content=str(entry.get("raw_content") or ""),
                    score=float(entry.get("score") or 0.0),
                )
            )
        return results

    def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            response = self._client.post(API_URL, json=payload)
        except httpx.RequestError as exc:
            raise SearchError(f"tarmoq xatosi: {exc}") from exc

        # 432/433 — plan yoki pay-as-you-go limiti tugadi
        if response.status_code in (401, 432, 433):
            raise SearchUnavailable(
                f"Tavily kirish rad etildi (HTTP {response.status_code}): "
                f"{response.text[:200]}"
            )
        if response.status_code in RETRYABLE_STATUS:
            raise SearchError(f"vaqtinchalik xato HTTP {response.status_code}")
        if response.status_code >= 400:
            raise SearchError(f"HTTP {response.status_code}: {response.text[:200]}")

        try:
            data = response.json()
        except ValueError as exc:
            raise SearchError(f"javob JSON emas: {exc}") from exc

        if not isinstance(data, dict):
            raise SearchError(f"javob obyekt emas: {type(data).__name__}")
        return data

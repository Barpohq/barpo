"""OpenRouter klienti — barcha LLM chaqiruvlar uchun yagona kirish nuqtasi.

Platformaning "LLM Router" komponenti: ikkala agent ham shu orqali
model chaqiradi. Boshqa modullarga bog'lanmagan — faqat config va db.

Xususiyatlari:
  - Model fallback zanjiri (asosiy model ishlamasa keyingisiga o'tadi)
  - Retry: exponential backoff, faqat vaqtinchalik xatolarda
  - Har chaqiruv `llm_calls` jadvaliga yoziladi (model, tokenlar, narx)
  - Kunlik xarajat limiti — oshsa CostLimitExceeded

Eslatma: `cluster_id` parametri hali botga xos (yangilik klasteri).
Uni generik `ref` ga umumlashtirish uchun ikkinchi haqiqiy ishlatuvchi
kerak — monitor unga muhtoj emas, chaqiruvlarini `stage` bo'yicha
topadi. Uchinchi agent paydo bo'lganda ko'riladi.
"""

from __future__ import annotations

import json
import random
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx

from core.config import ModelsConfig, env_str, load_models
from core.db import execute, query_one, utc_now
from core.logging_setup import get_logger

log = get_logger(__name__)

API_URL = "https://openrouter.ai/api/v1/chat/completions"

# Shu HTTP statuslarda qayta urinish mantiqiy (vaqtinchalik muammo)
RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504, 520, 522, 524}


class LLMError(RuntimeError):
    """LLM chaqiruvi bilan bog'liq umumiy xato."""


class CostLimitExceeded(LLMError):
    """Kunlik xarajat limiti oshib ketdi."""


class AllModelsFailed(LLMError):
    """Fallback zanjiridagi barcha modellar ishlamadi."""


@dataclass(slots=True)
class LLMResponse:
    """LLM javobi va u haqidagi metama'lumot."""

    text: str
    model: str
    requested_model: str
    prompt_tokens: int
    completion_tokens: int
    cost_usd: float
    duration_ms: int
    raw: dict[str, Any] = field(repr=False, default_factory=dict)

    @property
    def used_fallback(self) -> bool:
        return self.model != self.requested_model

    def json(self) -> Any:
        """Javob matnini JSON sifatida o'qish.

        Modellar ba'zan JSON'ni ```json ... ``` blokiga o'raydi — tozalanadi.
        """
        text = self.text.strip()
        if text.startswith("```"):
            lines = text.split("\n")
            # birinchi qator ```json yoki ```, oxirgisi ```
            if lines[-1].strip() == "```":
                lines = lines[:-1]
            text = "\n".join(lines[1:]).strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise LLMError(
                f"Model javobini JSON sifatida o'qib bo'lmadi: {exc}. "
                f"Javob boshi: {text[:200]!r}"
            ) from exc


def today_cost_usd() -> float:
    """Bugungi (UTC) jami LLM xarajati."""
    today = datetime.now(UTC).date().isoformat()
    row = query_one(
        "SELECT COALESCE(SUM(cost_usd), 0.0) AS total FROM llm_calls WHERE created_at >= ?",
        (today,),
    )
    return float(row["total"]) if row else 0.0


def _record_call(
    *,
    stage: str,
    model: str,
    requested_model: str,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    cost_usd: float = 0.0,
    duration_ms: int | None = None,
    attempt: int = 1,
    success: bool = True,
    error: str = "",
    cluster_id: int | None = None,
) -> None:
    """Chaqiruvni bazaga yozish. Bu yerdagi xato pipeline'ni to'xtatmasligi kerak."""
    try:
        execute(
            "INSERT INTO llm_calls (created_at, stage, model, requested_model, prompt_tokens, "
            "completion_tokens, cost_usd, duration_ms, attempt, success, error, cluster_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                utc_now(),
                stage,
                model,
                requested_model,
                prompt_tokens,
                completion_tokens,
                cost_usd,
                duration_ms,
                attempt,
                int(success),
                error or None,
                cluster_id,
            ),
        )
    except Exception:  # noqa: BLE001
        log.exception("LLM chaqiruvini bazaga yozib bo'lmadi")


class LLMClient:
    """OpenRouter orqali LLM chaqiruvlarini bajaradi."""

    def __init__(self, models: ModelsConfig | None = None) -> None:
        self.models = models or load_models()
        self._api_key = env_str("OPENROUTER_API_KEY", required=True)
        self._client = httpx.Client(
            timeout=httpx.Timeout(self.models.limits.request_timeout),
            headers=self._headers(),
        )

    def _headers(self) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        # OpenRouter reyting sahifasida ko'rinish uchun (ixtiyoriy)
        if site := env_str("OPENROUTER_SITE_URL"):
            headers["HTTP-Referer"] = site
        if name := env_str("OPENROUTER_SITE_NAME"):
            headers["X-Title"] = name
        return headers

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> LLMClient:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    # ─────────────────────── Asosiy API ───────────────────────

    def complete(
        self,
        stage: str,
        *,
        prompt: str,
        system: str = "",
        cluster_id: int | None = None,
        json_mode: bool = False,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> LLMResponse:
        """Bosqich sozlamalari bo'yicha LLM chaqiruvi.

        `stage` — models.yaml dagi bosqich nomi (rank, enrich, write).
        Model ishlamasa fallback zanjiri bo'ylab o'tadi.
        """
        self._check_cost_limit()

        cfg = self.models.stage(stage)
        messages: list[dict[str, str]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        payload_base: dict[str, Any] = {
            "messages": messages,
            "max_tokens": max_tokens if max_tokens is not None else cfg.max_tokens,
            "temperature": temperature if temperature is not None else cfg.temperature,
        }
        if json_mode:
            payload_base["response_format"] = {"type": "json_object"}

        errors: list[str] = []
        for model in cfg.chain:
            try:
                return self._call_with_retry(
                    model=model,
                    requested_model=cfg.model,
                    payload_base=payload_base,
                    stage=stage,
                    cluster_id=cluster_id,
                )
            except CostLimitExceeded:
                raise
            except LLMError as exc:
                errors.append(f"{model}: {exc}")
                log.warning("Model %s ishlamadi (%s), keyingisiga o'tilmoqda", model, exc)

        raise AllModelsFailed(
            f"'{stage}' bosqichi uchun barcha modellar ishlamadi:\n  " + "\n  ".join(errors)
        )

    def complete_with_model(
        self,
        model: str,
        *,
        stage: str,
        prompt: str,
        system: str = "",
        cluster_id: int | None = None,
        json_mode: bool = False,
        max_tokens: int = 2000,
        temperature: float = 0.7,
    ) -> LLMResponse:
        """Aniq model bilan chaqiruv — fallback zanjirisiz.

        Model taqqoslash uchun: fallback ishlasa qaysi model javob
        berganini bilib bo'lmaydi, natija esa shu savolga bog'liq.
        """
        self._check_cost_limit()

        messages: list[dict[str, str]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        payload: dict[str, Any] = {
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}

        return self._call_with_retry(
            model=model,
            requested_model=model,
            payload_base=payload,
            stage=stage,
            cluster_id=cluster_id,
        )

    # ─────────────────────── Ichki mantiq ───────────────────────

    def _check_cost_limit(self) -> None:
        limit = self.models.limits.daily_cost_usd
        spent = today_cost_usd()
        if spent >= limit:
            raise CostLimitExceeded(
                f"Kunlik xarajat limiti oshdi: ${spent:.4f} / ${limit:.2f}. "
                f"Limitni models.yaml (limits.daily_cost_usd) da o'zgartiring."
            )

    def _call_with_retry(
        self,
        *,
        model: str,
        requested_model: str,
        payload_base: dict[str, Any],
        stage: str,
        cluster_id: int | None,
    ) -> LLMResponse:
        limits = self.models.limits
        payload = {**payload_base, "model": model}
        last_error = ""

        for attempt in range(1, limits.max_retries + 1):
            started = time.monotonic()
            try:
                response = self._client.post(API_URL, json=payload)
            except httpx.RequestError as exc:
                last_error = f"tarmoq xatosi: {exc}"
                self._record_failure(stage, model, requested_model, attempt, last_error, cluster_id)
                if attempt < limits.max_retries:
                    self._sleep_backoff(attempt)
                    continue
                raise LLMError(last_error) from exc

            duration_ms = int((time.monotonic() - started) * 1000)

            if response.status_code in RETRYABLE_STATUS:
                last_error = f"HTTP {response.status_code}: {response.text[:200]}"
                self._record_failure(
                    stage, model, requested_model, attempt, last_error, cluster_id, duration_ms
                )
                if attempt < limits.max_retries:
                    self._sleep_backoff(attempt, retry_after=response.headers.get("retry-after"))
                    continue
                raise LLMError(last_error)

            if response.status_code >= 400:
                # 400/401/403/404 — qayta urinish foydasiz
                last_error = f"HTTP {response.status_code}: {response.text[:300]}"
                self._record_failure(
                    stage, model, requested_model, attempt, last_error, cluster_id, duration_ms
                )
                raise LLMError(last_error)

            return self._parse_response(
                response.json(),
                model=model,
                requested_model=requested_model,
                stage=stage,
                cluster_id=cluster_id,
                duration_ms=duration_ms,
                attempt=attempt,
            )

        raise LLMError(last_error or "noma'lum xato")

    def _sleep_backoff(self, attempt: int, retry_after: str | None = None) -> None:
        """Exponential backoff + jitter. Retry-After sarlavhasi bo'lsa unga bo'ysunadi."""
        if retry_after:
            try:
                delay = float(retry_after)
            except ValueError:
                delay = self.models.limits.retry_base_delay * (2 ** (attempt - 1))
        else:
            delay = self.models.limits.retry_base_delay * (2 ** (attempt - 1))
        delay += random.uniform(0, delay * 0.25)  # noqa: S311 — jitter, kriptografik emas
        log.info("Qayta urinishdan oldin %.1f soniya kutilmoqda (urinish %d)", delay, attempt)
        time.sleep(delay)

    def _record_failure(
        self,
        stage: str,
        model: str,
        requested_model: str,
        attempt: int,
        error: str,
        cluster_id: int | None,
        duration_ms: int | None = None,
    ) -> None:
        log.warning("LLM xatosi (%s, %s, urinish %d): %s", stage, model, attempt, error)
        _record_call(
            stage=stage,
            model=model,
            requested_model=requested_model,
            duration_ms=duration_ms,
            attempt=attempt,
            success=False,
            error=error,
            cluster_id=cluster_id,
        )

    def _parse_response(
        self,
        data: dict[str, Any],
        *,
        model: str,
        requested_model: str,
        stage: str,
        cluster_id: int | None,
        duration_ms: int,
        attempt: int,
    ) -> LLMResponse:
        # OpenRouter 200 bilan ham xato qaytarishi mumkin
        if "error" in data and not data.get("choices"):
            message = str(data["error"].get("message", data["error"]))
            self._record_failure(
                stage, model, requested_model, attempt, message, cluster_id, duration_ms
            )
            raise LLMError(f"OpenRouter xatosi: {message}")

        choices = data.get("choices") or []
        if not choices:
            raise LLMError(f"Javobda 'choices' bo'sh: {str(data)[:300]}")

        text = (choices[0].get("message") or {}).get("content") or ""
        if not text.strip():
            finish = choices[0].get("finish_reason")
            raise LLMError(f"Model bo'sh javob qaytardi (finish_reason={finish})")

        usage = data.get("usage") or {}
        prompt_tokens = int(usage.get("prompt_tokens", 0))
        completion_tokens = int(usage.get("completion_tokens", 0))

        # Haqiqatda ishlagan model — OpenRouter routing tufayli farq qilishi mumkin
        actual_model = data.get("model") or model
        cost = self._cost(actual_model, prompt_tokens, completion_tokens, usage)

        _record_call(
            stage=stage,
            model=actual_model,
            requested_model=requested_model,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            cost_usd=cost,
            duration_ms=duration_ms,
            attempt=attempt,
            success=True,
            cluster_id=cluster_id,
        )

        log.info(
            "LLM ok: %s (%s) — %d+%d token, $%.5f, %d ms",
            stage,
            actual_model,
            prompt_tokens,
            completion_tokens,
            cost,
            duration_ms,
        )

        return LLMResponse(
            text=text,
            model=actual_model,
            requested_model=requested_model,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            cost_usd=cost,
            duration_ms=duration_ms,
            raw=data,
        )

    def _cost(
        self, model: str, prompt_tokens: int, completion_tokens: int, usage: dict[str, Any]
    ) -> float:
        """Xarajat: models.yaml narxlaridan, bo'lmasa OpenRouter `usage.cost` dan."""
        price = self.models.price(model)
        if price is not None:
            return price.cost_usd(prompt_tokens, completion_tokens)
        if (reported := usage.get("cost")) is not None:
            return float(reported)
        log.warning("Model %s uchun narx noma'lum — xarajat 0 deb hisoblandi", model)
        return 0.0

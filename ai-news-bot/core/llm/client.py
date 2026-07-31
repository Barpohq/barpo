"""OpenRouter client — the single entry point for all LLM calls.

The platform's "LLM Router" component: both agents call models through
it. It depends on nothing else — only on config and db.

Features:
  - Model fallback chain (moves to the next model if the primary fails)
  - Retries: exponential backoff, only on transient errors
  - Every call is written to the `llm_calls` table (model, tokens, cost)
  - Daily cost limit — raises CostLimitExceeded once exceeded

Note: the `cluster_id` parameter is still bot-specific (a news cluster).
Generalizing it to a plain `ref` needs a second real user — the monitor
does not need it, it finds its calls by `stage`. Revisit this when a
third agent shows up.
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

# Retrying makes sense on these HTTP statuses (transient problems)
RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504, 520, 522, 524}


class LLMError(RuntimeError):
    """A general error related to an LLM call."""


class CostLimitExceeded(LLMError):
    """The daily cost limit has been exceeded."""


class AllModelsFailed(LLMError):
    """Every model in the fallback chain failed."""


@dataclass(slots=True)
class LLMResponse:
    """An LLM response and its metadata."""

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
        """Parse the response text as JSON.

        Models sometimes wrap JSON in a ```json ... ``` block — that is stripped.
        """
        text = self.text.strip()
        if text.startswith("```"):
            lines = text.split("\n")
            # the first line is ```json or ```, the last one is ```
            if lines[-1].strip() == "```":
                lines = lines[:-1]
            text = "\n".join(lines[1:]).strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise LLMError(
                f"Could not parse the model response as JSON: {exc}. "
                f"Start of the response: {text[:200]!r}"
            ) from exc


def today_cost_usd(
    stages: tuple[str, ...] = (), *, include: bool = True
) -> float:
    """Today's (UTC) LLM cost.

    If `stages` is empty, everything counts. Otherwise `include=True`
    counts only those stages, while `include=False` excludes them
    (used for per-stage limits).
    """
    today = datetime.now(UTC).date().isoformat()
    sql = "SELECT COALESCE(SUM(cost_usd), 0.0) AS total FROM llm_calls WHERE created_at >= ?"
    params: tuple[Any, ...] = (today,)

    if stages:
        placeholders = ", ".join("?" for _ in stages)
        keyword = "IN" if include else "NOT IN"
        sql += f" AND stage {keyword} ({placeholders})"
        params += stages

    row = query_one(sql, params)
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
    """Write the call to the database. An error here must not stop the pipeline."""
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
        log.exception("Could not write the LLM call to the database")


class LLMClient:
    """Performs LLM calls through OpenRouter."""

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
        # To appear on the OpenRouter leaderboard page (optional)
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

    # ─────────────────────── Public API ───────────────────────

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
        """An LLM call using the stage's settings.

        `stage` is the stage name from models.yaml (rank, enrich, write).
        If a model fails, it walks down the fallback chain.
        """
        self._check_cost_limit(stage)

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
                log.warning("Model %s failed (%s), moving on to the next one", model, exc)

        raise AllModelsFailed(
            f"Every model failed for the '{stage}' stage:\n  " + "\n  ".join(errors)
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
        """A call against a specific model — no fallback chain.

        For model comparisons: if a fallback kicks in you cannot tell
        which model answered, and that is exactly what is being measured.
        """
        self._check_cost_limit(stage)

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

    # ─────────────────────── Internals ──────────────────────────

    def _check_cost_limit(self, stage: str) -> None:
        limits = self.models.limits
        limit, key = limits.limit_for(stage)
        stages, include = limits.counted_stages(stage)
        spent = today_cost_usd(stages, include=include)
        if spent >= limit:
            raise CostLimitExceeded(
                f"Daily cost limit exceeded for '{stage}': "
                f"${spent:.4f} / ${limit:.2f}. "
                f"Change the limit in models.yaml (limits.{key})."
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
                last_error = f"network error: {exc}"
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
                # 400/401/403/404 — retrying would be pointless
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

        raise LLMError(last_error or "unknown error")

    def _sleep_backoff(self, attempt: int, retry_after: str | None = None) -> None:
        """Exponential backoff plus jitter. Honors the Retry-After header if present."""
        if retry_after:
            try:
                delay = float(retry_after)
            except ValueError:
                delay = self.models.limits.retry_base_delay * (2 ** (attempt - 1))
        else:
            delay = self.models.limits.retry_base_delay * (2 ** (attempt - 1))
        delay += random.uniform(0, delay * 0.25)  # noqa: S311 — jitter, not cryptographic
        log.info("Waiting %.1f seconds before retrying (attempt %d)", delay, attempt)
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
        log.warning("LLM error (%s, %s, attempt %d): %s", stage, model, attempt, error)
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
        # OpenRouter can return an error even with a 200 status
        if "error" in data and not data.get("choices"):
            message = str(data["error"].get("message", data["error"]))
            self._record_failure(
                stage, model, requested_model, attempt, message, cluster_id, duration_ms
            )
            raise LLMError(f"OpenRouter error: {message}")

        choices = data.get("choices") or []
        if not choices:
            raise LLMError(f"'choices' is empty in the response: {str(data)[:300]}")

        text = (choices[0].get("message") or {}).get("content") or ""
        if not text.strip():
            finish = choices[0].get("finish_reason")
            raise LLMError(f"The model returned an empty response (finish_reason={finish})")

        usage = data.get("usage") or {}
        prompt_tokens = int(usage.get("prompt_tokens", 0))
        completion_tokens = int(usage.get("completion_tokens", 0))

        # The model that actually ran — it can differ due to OpenRouter routing
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
            "LLM ok: %s (%s) — %d+%d tokens, $%.5f, %d ms",
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
        """Cost: from the models.yaml prices, otherwise from OpenRouter's `usage.cost`."""
        price = self.models.price(model)
        if price is not None:
            return price.cost_usd(prompt_tokens, completion_tokens)
        if (reported := usage.get("cost")) is not None:
            return float(reported)
        log.warning("Price unknown for model %s — counting the cost as 0", model)
        return 0.0

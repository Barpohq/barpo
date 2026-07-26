"""LLM klienti testlari — haqiqiy API chaqirmasdan, mock transport orqali."""

from __future__ import annotations

import httpx
import pytest

from bot.llm.client import AllModelsFailed, CostLimitExceeded, LLMClient, LLMError
from core.config import Limits, ModelsConfig, Price, StageConfig


@pytest.fixture
def models_config() -> ModelsConfig:
    return ModelsConfig(
        stages={
            "rank": StageConfig(
                name="rank",
                model="cheap/model-a",
                fallbacks=("cheap/model-b",),
                max_tokens=100,
                temperature=0.0,
            )
        },
        pricing={
            "cheap/model-a": Price(input=1.0, output=2.0),
            "cheap/model-b": Price(input=0.5, output=1.0),
        },
        limits=Limits(daily_cost_usd=1.0, max_retries=3, retry_base_delay=0.0),
    )


def make_client(models_config: ModelsConfig, handler) -> LLMClient:
    """Mock transport bilan klient yasash."""
    client = LLMClient(models=models_config)
    client._client = httpx.Client(transport=httpx.MockTransport(handler))
    return client


def ok_response(model: str, text: str = "javob", prompt: int = 1000, completion: int = 500):
    return httpx.Response(
        200,
        json={
            "model": model,
            "choices": [{"message": {"content": text}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": prompt, "completion_tokens": completion},
        },
    )


def test_successful_call_records_cost(models_config, migrated_db):
    """Muvaffaqiyatli chaqiruv narxni to'g'ri hisoblaydi va bazaga yozadi."""
    client = make_client(models_config, lambda _req: ok_response("cheap/model-a"))
    result = client.complete("rank", prompt="salom")

    assert result.text == "javob"
    assert result.model == "cheap/model-a"
    assert not result.used_fallback
    # 1000 token * $1/1M + 500 * $2/1M = 0.001 + 0.001 = 0.002
    assert result.cost_usd == pytest.approx(0.002)

    from bot.db import query_one

    row = query_one(
        "SELECT stage, model, cost_usd, success FROM llm_calls ORDER BY id DESC LIMIT 1"
    )
    assert row["stage"] == "rank"
    assert row["model"] == "cheap/model-a"
    assert row["success"] == 1


def test_fallback_on_permanent_error(models_config, migrated_db):
    """Asosiy model 400 qaytarsa fallback modelga o'tadi."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _json

        model = _json.loads(request.content)["model"]
        calls.append(model)
        if model == "cheap/model-a":
            return httpx.Response(400, json={"error": {"message": "model mavjud emas"}})
        return ok_response(model)

    client = make_client(models_config, handler)
    result = client.complete("rank", prompt="salom")

    assert calls == ["cheap/model-a", "cheap/model-b"]
    assert result.model == "cheap/model-b"
    assert result.used_fallback


def test_retry_then_success(models_config, migrated_db):
    """429 dan keyin qayta urinadi va muvaffaqiyatga erishadi."""
    attempts = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        if attempts["n"] < 3:
            return httpx.Response(429, text="rate limit")
        return ok_response("cheap/model-a")

    client = make_client(models_config, handler)
    result = client.complete("rank", prompt="salom")

    assert attempts["n"] == 3
    assert result.text == "javob"


def test_all_models_fail(models_config, migrated_db):
    """Barcha modellar ishlamasa AllModelsFailed."""
    client = make_client(
        models_config,
        lambda _req: httpx.Response(400, json={"error": {"message": "yoq"}}),
    )
    with pytest.raises(AllModelsFailed) as exc:
        client.complete("rank", prompt="salom")
    assert "cheap/model-a" in str(exc.value)
    assert "cheap/model-b" in str(exc.value)


def test_cost_limit_blocks_call(models_config, migrated_db):
    """Kunlik limit oshgan bo'lsa chaqiruv umuman qilinmaydi."""
    from bot.db import execute, utc_now

    execute(
        "INSERT INTO llm_calls (created_at, stage, model, requested_model, cost_usd) "
        "VALUES (?, 'rank', 'm', 'm', ?)",
        (utc_now(), 1.5),  # limit 1.0
    )

    called = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        called["n"] += 1
        return ok_response("cheap/model-a")

    client = make_client(models_config, handler)
    with pytest.raises(CostLimitExceeded):
        client.complete("rank", prompt="salom")
    assert called["n"] == 0, "limit oshganda API chaqirilmasligi kerak"


def test_empty_response_is_error(models_config, migrated_db):
    """Bo'sh javob xato deb qaraladi (fallbackka o'tadi, keyin AllModelsFailed)."""
    client = make_client(
        models_config,
        lambda _req: httpx.Response(
            200,
            json={
                "model": "cheap/model-a",
                "choices": [{"message": {"content": "  "}, "finish_reason": "length"}],
                "usage": {},
            },
        ),
    )
    with pytest.raises(AllModelsFailed):
        client.complete("rank", prompt="salom")


@pytest.mark.parametrize(
    "text",
    [
        '{"score": 8}',
        '```json\n{"score": 8}\n```',
        '```\n{"score": 8}\n```',
    ],
)
def test_json_parsing_handles_code_fences(models_config, migrated_db, text):
    """Model JSON'ni ``` blokiga o'rasa ham o'qiladi."""
    client = make_client(models_config, lambda _req: ok_response("cheap/model-a", text=text))
    result = client.complete("rank", prompt="salom", json_mode=True)
    assert result.json() == {"score": 8}


def test_invalid_json_raises(models_config, migrated_db):
    client = make_client(models_config, lambda _req: ok_response("cheap/model-a", text="JSON emas"))
    result = client.complete("rank", prompt="salom")
    with pytest.raises(LLMError, match="JSON sifatida"):
        result.json()

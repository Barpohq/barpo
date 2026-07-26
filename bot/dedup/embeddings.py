"""Lokal embedding modeli — API xarajati nol.

`bge-small-en-v1.5` (384 o'lchov, ~130MB) sentence-transformers orqali.
Model birinchi ishga tushirishda yuklanadi va HF_HOME keshiga saqlanadi.

Vektorlar `embeddings` jadvalida BLOB sifatida keshlanadi — bir element
uchun ikki marta hisoblanmaydi.
"""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING, Any

import numpy as np

from bot.db import execute, query, utc_now
from core.logging_setup import get_logger

if TYPE_CHECKING:
    from sentence_transformers import SentenceTransformer

log = get_logger(__name__)

MODEL_NAME = "BAAI/bge-small-en-v1.5"
DIM = 384

_model: SentenceTransformer | None = None
_model_lock = threading.Lock()


def get_model() -> SentenceTransformer:
    """Modelni yuklash (bir marta, thread-safe)."""
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from sentence_transformers import SentenceTransformer

                log.info("Embedding modeli yuklanmoqda: %s (birinchi safar sekin)", MODEL_NAME)
                _model = SentenceTransformer(MODEL_NAME)
                log.info("Model tayyor")
    return _model


def embed_texts(texts: list[str]) -> np.ndarray:
    """Matnlarni vektorlarga aylantirish. Natija normallashtirilgan (L2=1).

    Normallashtirilgan vektorlarda cosine similarity = skalyar ko'paytma.
    """
    if not texts:
        return np.empty((0, DIM), dtype=np.float32)
    model = get_model()
    vectors = model.encode(
        texts,
        batch_size=32,
        show_progress_bar=False,
        normalize_embeddings=True,
        convert_to_numpy=True,
    )
    return np.asarray(vectors, dtype=np.float32)


def item_text(item: dict[str, Any]) -> str:
    """Element uchun embedding matni.

    Sarlavha eng muhim signal, shuning uchun matnning faqat boshi qo'shiladi —
    uzun maqola matni sarlavha signalini "cho'ktirib" yubormasligi uchun.
    """
    title = (item.get("title") or "").strip()
    body = (item.get("content") or item.get("summary") or "").strip()
    return f"{title}\n{body[:500]}" if body else title


# ─────────────────────────── Kesh ───────────────────────────


def load_cached(item_ids: list[int]) -> dict[int, np.ndarray]:
    """Bazadagi keshlangan vektorlarni o'qish."""
    if not item_ids:
        return {}
    placeholders = ",".join("?" * len(item_ids))
    rows = query(
        f"SELECT item_id, vector FROM embeddings WHERE item_id IN ({placeholders}) AND model = ?",
        (*item_ids, MODEL_NAME),
    )
    return {r["item_id"]: np.frombuffer(r["vector"], dtype=np.float32) for r in rows}


def save_embeddings(vectors: dict[int, np.ndarray]) -> None:
    """Vektorlarni keshga yozish."""
    now = utc_now()
    for item_id, vector in vectors.items():
        execute(
            "INSERT OR REPLACE INTO embeddings (item_id, model, dim, vector, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (item_id, MODEL_NAME, len(vector), vector.astype(np.float32).tobytes(), now),
        )


def embed_items(items: list[dict[str, Any]]) -> dict[int, np.ndarray]:
    """Elementlar uchun vektorlar — keshdan yoki yangi hisoblab.

    Kesh bilan ishlash bu yerda markazlashgan: chaqiruvchi kod keshni
    o'ylamaydi.
    """
    ids = [int(it["id"]) for it in items]
    cached = load_cached(ids)

    missing = [it for it in items if int(it["id"]) not in cached]
    if missing:
        log.info(
            "%d ta element uchun embedding hisoblanmoqda (%d keshdan)",
            len(missing),
            len(cached),
        )
        vectors = embed_texts([item_text(it) for it in missing])
        fresh = {int(it["id"]): vec for it, vec in zip(missing, vectors, strict=True)}
        save_embeddings(fresh)
        cached.update(fresh)
    else:
        log.debug("Barcha %d embedding keshdan olindi", len(cached))

    return cached

"""Deduplication qatlami — dublikatlarni klasterlarga birlashtirish."""

from bot.dedup.clustering import (
    SEMANTIC_THRESHOLD,
    TITLE_FUZZY_THRESHOLD,
    DedupReport,
    cluster_summary,
    run_dedup,
)
from bot.dedup.embeddings import MODEL_NAME, embed_items, embed_texts

__all__ = [
    "MODEL_NAME",
    "SEMANTIC_THRESHOLD",
    "TITLE_FUZZY_THRESHOLD",
    "DedupReport",
    "cluster_summary",
    "embed_items",
    "embed_texts",
    "run_dedup",
]

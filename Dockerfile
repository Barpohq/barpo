# syntax=docker/dockerfile:1

FROM python:3.12-slim AS base

# PYTHONUNBUFFERED: loglar Docker'da real vaqtda ko'rinishi uchun majburiy
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    # sentence-transformers modelini shu yerda keshlaydi (volume qilinadi)
    HF_HOME=/app/models_cache

WORKDIR /app

# uv — tez paket menejeri
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Bog'liqliklarni alohida qatlamda: kod o'zgarganda qayta o'rnatilmaydi
COPY pyproject.toml README.md ./
RUN uv pip install --system --no-cache .

COPY bot/ ./bot/
COPY config/ ./config/

# Baza va model keshi uchun kataloglar
RUN mkdir -p /app/data /app/models_cache

# Health check: baza yozilayotganini tekshiradi (24 soatda hech narsa
# yig'ilmasa nimadir buzilgan)
HEALTHCHECK --interval=30m --timeout=30s --start-period=2m --retries=2 \
    CMD python -m bot db status || exit 1

ENTRYPOINT ["python", "-m", "bot"]
CMD ["run"]

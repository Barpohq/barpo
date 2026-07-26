# syntax=docker/dockerfile:1

FROM python:3.12-slim AS base

# PYTHONUNBUFFERED: loglar Docker'da real vaqtda ko'rinishi uchun majburiy
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    # sentence-transformers modelini shu yerda keshlaydi (volume qilinadi)
    HF_HOME=/app/models_cache

WORKDIR /app

# openssh-client — monitor agenti serverlarga shu orqali ulanadi
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*

# uv — tez paket menejeri
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Bog'liqliklarni alohida qatlamda: kod o'zgarganda qayta o'rnatilmaydi
COPY pyproject.toml README.md ./

# PyTorch — faqat CPU varianti.
#
# `sentence-transformers` torch'ni tortadi, u esa default holda CUDA
# g'ildiraklarini oladi: nvidia-cublas 517MB, nvidia-cudnn 424MB,
# nvidia-cusolver 213MB va h.k. — jami ~2.5GB. Bot embeddingni CPU'da
# hisoblaydi va serverda GPU yo'q, ya'ni bularning hammasi keraksiz yuk:
# build sekinlashadi, image ~3GB ga shishadi.
#
# CPU indeksi o'sha torch'ni CUDA'siz beradi (~200MB). Embedding tezligi
# o'zgarmaydi — u baribir CPU'da ishlaydi.
RUN uv pip install --system --no-cache \
        --index-url https://download.pytorch.org/whl/cpu \
        --index-strategy unsafe-best-match \
        torch \
    && uv pip install --system --no-cache .

COPY core/ ./core/
COPY bot/ ./bot/
COPY monitor/ ./monitor/
COPY config/ ./config/

# Baza va model keshi uchun kataloglar
RUN mkdir -p /app/data /app/models_cache

# Health check: baza yozilayotganini tekshiradi (24 soatda hech narsa
# yig'ilmasa nimadir buzilgan)
HEALTHCHECK --interval=30m --timeout=30s --start-period=2m --retries=2 \
    CMD python -m bot db status || exit 1

ENTRYPOINT ["python", "-m", "bot"]
CMD ["run"]

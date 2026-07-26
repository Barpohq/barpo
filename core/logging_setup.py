"""Loglashni sozlash.

Muhim: barcha log stdout'ga chiqadi va darhol flush qilinadi — Docker
loglarida va uzoq ishlaydigan jarayonlarda real vaqtda ko'rinishi uchun.
"""

from __future__ import annotations

import logging
import sys


class _FlushingStreamHandler(logging.StreamHandler):
    """Har yozuvdan keyin flush qiladigan handler."""

    def emit(self, record: logging.LogRecord) -> None:
        super().emit(record)
        self.flush()


def setup_logging(level: str = "INFO") -> None:
    """Ildiz loggerni sozlash. Bir necha marta chaqirilsa qayta sozlaydi."""
    root = logging.getLogger()
    root.setLevel(level)

    for handler in list(root.handlers):
        root.removeHandler(handler)

    handler = _FlushingStreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s %(levelname)-7s %(name)-22s %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    root.addHandler(handler)

    # Kutubxonalarning shovqinli loglarini bosish
    for noisy in ("httpx", "httpcore", "apscheduler.executors.default"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)

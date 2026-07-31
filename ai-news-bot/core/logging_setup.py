"""Logging setup.

Important: all logs go to stdout and are flushed immediately — so they
show up in real time in Docker logs and in long-running processes.
"""

from __future__ import annotations

import logging
import sys


class _FlushingStreamHandler(logging.StreamHandler):
    """Handler that flushes after every record."""

    def emit(self, record: logging.LogRecord) -> None:
        super().emit(record)
        self.flush()


def setup_logging(level: str = "INFO") -> None:
    """Configure the root logger. Reconfigures if called more than once."""
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

    # Quiet down noisy library logs
    for noisy in ("httpx", "httpcore", "apscheduler.executors.default"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)

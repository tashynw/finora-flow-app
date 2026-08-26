"""Log configuration.

Configured explicitly rather than left to structlog's defaults, for three
reasons that all showed up as real failures.

Logging must not be able to break a request. structlog's default logger writes
through the interpreter's chosen encoding, which on a Windows host is a legacy
code page. A single non-ASCII character in an exception message then raises
inside the error handler, so a failure that was already being handled turns into
a dropped connection with no explanation anywhere. The stream is forced to UTF-8
here so that cannot happen.

Logs from a financial system are evidence. Outside development they are emitted
as one JSON object per line, with a UTC timestamp and the level, so they can be
shipped and queried rather than read by eye. Development keeps the human-readable
renderer, because a person is watching.

Correlation travels with the request. The context variables bound by the API
middleware are merged into every event, so an error and the request that caused
it can be tied together without threading an identifier through every call.
"""

from __future__ import annotations

import logging
import sys
from typing import Any, TextIO

import structlog

from finora.config import Environment


def _utf8(stream: TextIO) -> TextIO:
    """Force UTF-8 on a text stream, where the platform allows it.

    A log line is not worth losing a request over, so a stream that cannot be
    reconfigured is returned unchanged and the replacement error handler below
    keeps it from raising.
    """
    reconfigure = getattr(stream, "reconfigure", None)
    if reconfigure is not None:
        try:
            reconfigure(encoding="utf-8", errors="backslashreplace")
        except (OSError, ValueError):
            pass
    return stream


def configure_logging(*, environment: Environment, level: str = "INFO") -> None:
    """Install the log configuration. Safe to call more than once."""
    stream = _utf8(sys.stdout)
    development = environment is Environment.development

    shared: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        # Renders the traceback into the event itself. Without it, an exception
        # logged as JSON arrives as an unreadable repr.
        structlog.processors.format_exc_info,
    ]

    renderer: Any = (
        structlog.dev.ConsoleRenderer(colors=False)
        if development
        # `sort_keys` keeps a diff between two log lines readable.
        else structlog.processors.JSONRenderer(sort_keys=True)
    )

    structlog.configure(
        processors=[*shared, renderer],
        wrapper_class=structlog.make_filtering_bound_logger(
            logging.getLevelNamesMapping().get(level.upper(), logging.INFO)
        ),
        logger_factory=structlog.WriteLoggerFactory(file=stream),
        cache_logger_on_first_use=True,
    )

    # Uvicorn and SQLAlchemy log through the standard library. Left at their own
    # levels, but pointed at the same stream so ordering in a terminal or a log
    # collector reflects what actually happened.
    logging.basicConfig(
        format="%(message)s",
        stream=stream,
        level=logging.INFO,
        force=True,
    )

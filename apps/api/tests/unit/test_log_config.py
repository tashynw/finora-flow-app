"""Logging must not be able to break a request.

These exist because of a real failure. structlog's default logger writes through
the interpreter's chosen encoding, which on a Windows host is a legacy code page.
An exception message containing a typographic quote then raised `UnicodeEncodeError`
inside the API's error handler, so a fault that was already being handled turned
into a dropped connection with nothing recorded anywhere. The 500 the caller should
have received never arrived, and the log line explaining why was the thing that
failed to be written.
"""

from __future__ import annotations

import io
import json

import pytest
import structlog

from finora.config import Environment
from finora.log_config import configure_logging

#: Characters a legacy code page cannot represent. An em dash and curly quotes are
#: not exotic: they arrive in real subject lines and vendor names, and they reach
#: the log through exception messages that quote them.
AWKWARD = "vendor \u201cAcme\u201d \u2014 caf\u00e9 \u20ac50 \u2713"


@pytest.fixture(autouse=True)
def _restore_logging():
    """Put the shared structlog configuration back after each test."""
    yield
    configure_logging(environment=Environment.development)


class _LegacyStream(io.TextIOBase):
    """A stream that cannot represent anything outside cp1252, like a Windows console.

    Deliberately has no `reconfigure`, so it stands in for the case the production
    code cannot fix by asking for UTF-8 and has to survive anyway.
    """

    def __init__(self) -> None:
        self.written: list[str] = []

    def write(self, text: str) -> int:
        text.encode("cp1252")
        self.written.append(text)
        return len(text)


class TestEncoding:
    def test_a_message_a_legacy_console_cannot_encode_does_not_raise(self, capsys):
        configure_logging(environment=Environment.development)
        logger = structlog.get_logger("test")

        # The original failure: the log call itself raised.
        logger.error("test.event", detail=AWKWARD)

        assert AWKWARD in capsys.readouterr().out

    def test_an_exception_is_logged_with_its_traceback(self, capsys):
        configure_logging(environment=Environment.production)
        logger = structlog.get_logger("test")

        try:
            raise ValueError(AWKWARD)
        except ValueError:
            logger.exception("test.failure")

        record = json.loads(capsys.readouterr().out.strip())
        # Rendered into the event rather than left as a repr, or a JSON log would
        # arrive with the one piece of information anybody needs missing.
        assert "Traceback" in record["exception"]
        assert AWKWARD in record["exception"]

    def test_an_unencodable_stream_degrades_instead_of_failing(self):
        """A log line is not worth losing a request over."""
        stream = _LegacyStream()
        structlog.configure(
            processors=[structlog.processors.JSONRenderer()],
            logger_factory=structlog.WriteLoggerFactory(file=stream),  # type: ignore[arg-type]
            cache_logger_on_first_use=False,
        )

        # JSON escapes non-ASCII by default, which is what keeps this writable on a
        # stream that could not otherwise represent it.
        structlog.get_logger("test").error("test.event", detail=AWKWARD)

        assert stream.written
        assert AWKWARD in json.loads(stream.written[0])["detail"]


class TestRendering:
    def test_production_logs_are_one_json_object_per_line(self, capsys):
        configure_logging(environment=Environment.production)
        logger = structlog.get_logger("test")

        logger.info("first.event", amount_minor=1250, currency="JMD")
        logger.info("second.event")

        lines = capsys.readouterr().out.strip().splitlines()
        assert len(lines) == 2
        first = json.loads(lines[0])
        assert first["event"] == "first.event"
        assert first["amount_minor"] == 1250
        assert first["level"] == "info"
        # UTC and ISO 8601, so entries from different hosts sort and compare.
        assert first["timestamp"].endswith("Z")

    def test_development_logs_stay_readable_for_a_person(self, capsys):
        configure_logging(environment=Environment.development)
        structlog.get_logger("test").info("readable.event", detail="plain")

        out = capsys.readouterr().out
        assert "readable.event" in out
        # Not JSON: someone is watching this scroll past.
        with pytest.raises(json.JSONDecodeError):
            json.loads(out.strip())

    def test_request_context_is_attached_without_being_passed_in(self, capsys):
        """The API binds the correlation id once per request; every event carries it."""
        configure_logging(environment=Environment.production)
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(correlation_id="abc-123", path="/intake")

        try:
            structlog.get_logger("test").info("deep.in.the.call.stack")
        finally:
            structlog.contextvars.clear_contextvars()

        record = json.loads(capsys.readouterr().out.strip())
        assert record["correlation_id"] == "abc-123"
        assert record["path"] == "/intake"


class TestLevels:
    def test_debug_is_dropped_at_info(self, capsys):
        configure_logging(environment=Environment.production, level="INFO")
        logger = structlog.get_logger("test")

        logger.debug("noisy.event")
        logger.info("kept.event")

        lines = capsys.readouterr().out.strip().splitlines()
        assert len(lines) == 1
        assert json.loads(lines[0])["event"] == "kept.event"

    def test_an_unrecognised_level_falls_back_to_info(self, capsys):
        """A typo in configuration must not silence the logs."""
        configure_logging(environment=Environment.production, level="chatty")
        logger = structlog.get_logger("test")

        logger.debug("dropped.event")
        logger.info("kept.event")

        lines = capsys.readouterr().out.strip().splitlines()
        assert len(lines) == 1
        assert json.loads(lines[0])["event"] == "kept.event"

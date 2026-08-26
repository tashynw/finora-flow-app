"""The scanner must never turn "I don't know" into "it's fine"."""

from __future__ import annotations

import socket
import threading
from typing import Any

import pytest

from finora.config import ScannerSettings
from finora.domain.intake import ScanVerdict
from finora.infrastructure.scanner import (
    MalwareScanner,
    ScannerUnavailableError,
    interpret_clamd_response,
)


class TestInterpretResponse:
    def test_a_clean_stream_is_clean(self) -> None:
        assert interpret_clamd_response("stream: OK").verdict is ScanVerdict.clean

    def test_a_detection_is_infected_and_names_the_signature(self) -> None:
        result = interpret_clamd_response("stream: Eicar-Test-Signature FOUND")
        assert result.verdict is ScanVerdict.infected
        assert result.detail == "Eicar-Test-Signature"

    def test_an_unnamed_detection_is_still_infected(self) -> None:
        result = interpret_clamd_response("stream: FOUND")
        assert result.verdict is ScanVerdict.infected

    @pytest.mark.parametrize(
        "reply",
        [
            "stream: File is encrypted ERROR",
            "stream: Heuristics.Encrypted.Zip ERROR",
            "stream: size limit exceeded ERROR",
            "stream: recursion limit exceeded ERROR",
            "stream: max files reached ERROR",
        ],
    )
    def test_a_refusal_to_inspect_is_unscannable_not_clean(self, reply: str) -> None:
        # An encrypted archive is the standard delivery vehicle. Reading this as
        # "clean" is precisely how it gets through.
        result = interpret_clamd_response(reply)
        assert result.verdict is ScanVerdict.unscannable

    def test_an_engine_error_is_an_error(self) -> None:
        result = interpret_clamd_response("stream: database load failed ERROR")
        assert result.verdict is ScanVerdict.error

    @pytest.mark.parametrize(
        "reply",
        ["", "   ", "something entirely unexpected", "OK but also FOUND", "\x00"],
    )
    def test_anything_unrecognised_is_an_error_never_clean(self, reply: str) -> None:
        assert interpret_clamd_response(reply).verdict is not ScanVerdict.clean

    def test_a_reply_mentioning_found_is_never_read_as_ok(self) -> None:
        # Guards the ordering of the checks: a naive `endswith("OK")` on a
        # multi-result reply would release an infected file.
        assert (
            interpret_clamd_response("stream: Trojan FOUND\nstream: OK").verdict
            is not ScanVerdict.clean
        )

    def test_only_a_clean_result_is_releasable(self) -> None:
        assert interpret_clamd_response("stream: OK").is_releasable
        assert not interpret_clamd_response("stream: X FOUND").is_releasable
        assert not interpret_clamd_response("stream: encrypted ERROR").is_releasable
        assert not interpret_clamd_response("garbage").is_releasable


def _settings(**overrides: Any) -> ScannerSettings:
    defaults: dict[str, Any] = {
        "host": "127.0.0.1",
        # Port 1 is reserved and refuses connections immediately, which is a
        # faithful stand-in for "the scanner is not there".
        "port": 1,
        "timeout_seconds": 1,
        "max_attachment_bytes": 1024,
        "fail_closed": True,
    }
    return ScannerSettings(**{**defaults, **overrides})


class TestUnreachableScanner:
    def test_an_unreachable_scanner_yields_an_error_verdict(self) -> None:
        result = MalwareScanner(_settings()).scan(b"anything")
        assert result.verdict is ScanVerdict.error
        assert result.detail

    def test_fail_closed_refuses_the_file(self) -> None:
        with pytest.raises(ScannerUnavailableError):
            MalwareScanner(_settings(fail_closed=True)).scan_or_refuse(b"anything")

    def test_fail_open_returns_the_error_verdict_without_raising(self) -> None:
        # Permitted only outside production; `assert_production_ready` refuses to
        # boot with fail_closed disabled.
        result = MalwareScanner(_settings(fail_closed=False)).scan_or_refuse(b"anything")
        assert result.verdict is ScanVerdict.error
        assert not result.is_releasable

    def test_ping_reports_false_rather_than_raising(self) -> None:
        assert MalwareScanner(_settings()).ping() is False

    def test_version_reports_none_rather_than_raising(self) -> None:
        assert MalwareScanner(_settings()).version() is None


class TestSizeLimit:
    def test_a_file_above_the_limit_is_unscannable_not_clean(self) -> None:
        result = MalwareScanner(_settings(max_attachment_bytes=10)).scan(b"x" * 100)
        assert result.verdict is ScanVerdict.unscannable
        assert "limit" in (result.detail or "")

    def test_an_oversized_file_is_refused_when_failing_closed(self) -> None:
        scanner = MalwareScanner(_settings(max_attachment_bytes=10))
        with pytest.raises(ScannerUnavailableError):
            scanner.scan_or_refuse(b"x" * 100)

    def test_the_limit_is_checked_before_any_connection_is_attempted(self) -> None:
        # Port 1 refuses connections, so reaching the socket would give `error`
        # rather than `unscannable`.
        result = MalwareScanner(_settings(max_attachment_bytes=1)).scan(b"xx")
        assert result.verdict is ScanVerdict.unscannable


class _FakeClamd:
    """A minimal clamd that replies with a fixed line."""

    def __init__(self, reply: bytes):
        self._reply = reply
        self._listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen(1)
        self.port: int = self._listener.getsockname()[1]
        self.received = bytearray()

    def serve_once(self) -> None:
        connection, _ = self._listener.accept()
        with connection:
            connection.settimeout(2)
            while True:
                try:
                    chunk = connection.recv(4096)
                except TimeoutError:
                    break
                if not chunk:
                    break
                self.received.extend(chunk)
                # The upload ends with a zero-length chunk marker.
                if self.received.endswith(b"\x00\x00\x00\x00"):
                    break
            connection.sendall(self._reply)

    def close(self) -> None:
        self._listener.close()


class TestInstreamExchange:
    @pytest.mark.parametrize(
        ("reply", "expected"),
        [
            (b"stream: OK\x00", ScanVerdict.clean),
            (b"stream: Eicar-Test-Signature FOUND\x00", ScanVerdict.infected),
            (b"stream: encrypted ERROR\x00", ScanVerdict.unscannable),
        ],
    )
    def test_reads_a_verdict_off_the_wire(self, reply: bytes, expected: ScanVerdict) -> None:
        server = _FakeClamd(reply)
        thread = threading.Thread(target=server.serve_once, daemon=True)
        thread.start()
        try:
            scanner = MalwareScanner(_settings(port=server.port, timeout_seconds=3))
            result = scanner.scan(b"%PDF-1.7 content")
            assert result.verdict is expected
        finally:
            thread.join(timeout=3)
            server.close()

    def test_sends_the_instream_command_and_terminates_the_upload(self) -> None:
        server = _FakeClamd(b"stream: OK\x00")
        thread = threading.Thread(target=server.serve_once, daemon=True)
        thread.start()
        try:
            scanner = MalwareScanner(_settings(port=server.port, timeout_seconds=3))
            scanner.scan(b"payload bytes")
        finally:
            thread.join(timeout=3)
            server.close()

        assert bytes(server.received).startswith(b"zINSTREAM\x00")
        assert b"payload bytes" in bytes(server.received)
        assert bytes(server.received).endswith(b"\x00\x00\x00\x00")

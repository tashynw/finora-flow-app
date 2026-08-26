"""Malware scanning via clamd.

The single rule this module exists to enforce: an absent answer is not a clean
answer. If the scanner is unreachable, times out, or replies with something this
client does not understand, the result is `error` and the file is withheld. When
`fail_closed` is set, intake stops rather than passing unscanned bytes onward.

Speaking clamd's INSTREAM protocol directly avoids a dependency on a client
library for what is a short, well-specified exchange, and keeps the timeout and
size behaviour explicit rather than inherited.
"""

from __future__ import annotations

import socket
import struct
from dataclasses import dataclass
from functools import lru_cache

import structlog

from finora.config import ScannerSettings, get_settings
from finora.domain.intake import ScanVerdict

logger = structlog.get_logger(__name__)

#: clamd reads INSTREAM in length-prefixed chunks. 32 KiB is comfortably below
#: the default StreamMaxLength and keeps memory flat for large files.
_CHUNK_BYTES = 32 * 1024

#: Terminator for a length-prefixed INSTREAM upload.
_STREAM_END = struct.pack("!L", 0)


class ScannerUnavailableError(Exception):
    """The scanner could not be consulted.

    Raised only when the caller has asked to fail closed. Otherwise the failure
    is reported as an `error` verdict so it is recorded rather than raised.
    """


@dataclass(frozen=True, slots=True)
class ScanResult:
    verdict: ScanVerdict
    #: Signature name when infected, or the reason when unscannable or errored.
    detail: str | None = None
    #: Scanner version, recorded so a verdict can be re-evaluated later against
    #: a newer signature database.
    engine: str | None = None

    @property
    def is_releasable(self) -> bool:
        return self.verdict is ScanVerdict.clean


class MalwareScanner:
    def __init__(self, settings: ScannerSettings):
        self._settings = settings

    def _connect(self) -> socket.socket:
        connection = socket.create_connection(
            (self._settings.host, self._settings.port),
            timeout=self._settings.timeout_seconds,
        )
        connection.settimeout(self._settings.timeout_seconds)
        return connection

    def version(self) -> str | None:
        try:
            with self._connect() as connection:
                connection.sendall(b"zVERSION\x00")
                return _read_response(connection).strip() or None
        except OSError:
            return None

    def scan(self, data: bytes) -> ScanResult:
        """Scan one buffer and report a verdict.

        Never raises for a scanner problem: the failure becomes a verdict so it
        is written to the record, and the decision about whether to stop belongs
        to `scan_or_refuse`.
        """
        if len(data) > self._settings.max_attachment_bytes:
            return ScanResult(
                verdict=ScanVerdict.unscannable,
                detail=(
                    f"The file is {len(data):,} bytes, above the "
                    f"{self._settings.max_attachment_bytes:,} byte scanning limit."
                ),
            )

        try:
            with self._connect() as connection:
                connection.sendall(b"zINSTREAM\x00")
                for offset in range(0, len(data), _CHUNK_BYTES):
                    chunk = data[offset : offset + _CHUNK_BYTES]
                    connection.sendall(struct.pack("!L", len(chunk)) + chunk)
                connection.sendall(_STREAM_END)
                raw = _read_response(connection)
        except TimeoutError:
            logger.warning("scanner.timeout", timeout=self._settings.timeout_seconds)
            return ScanResult(
                verdict=ScanVerdict.error,
                detail="The malware scanner did not respond in time.",
            )
        except OSError as error:
            logger.warning("scanner.unreachable", error=str(error))
            return ScanResult(
                verdict=ScanVerdict.error,
                detail="The malware scanner could not be reached.",
            )

        return interpret_clamd_response(raw)

    def scan_or_refuse(self, data: bytes) -> ScanResult:
        """Scan, and raise if a non-answer must stop the operation.

        This is what intake calls. A clean verdict returns; an infected verdict
        returns so the caller can quarantine it; anything else raises when
        `fail_closed` is configured, because continuing would mean storing a file
        that nothing has vouched for.
        """
        result = self.scan(data)
        if result.verdict in {ScanVerdict.error, ScanVerdict.unscannable}:
            if self._settings.fail_closed:
                raise ScannerUnavailableError(
                    result.detail or "The file could not be scanned, so it has not been accepted."
                )
            logger.warning(
                "scanner.fail_open",
                verdict=str(result.verdict),
                detail=result.detail,
            )
        return result

    def ping(self) -> bool:
        try:
            with self._connect() as connection:
                connection.sendall(b"zPING\x00")
                return _read_response(connection).strip() == "PONG"
        except OSError:
            return False


def _read_response(connection: socket.socket) -> str:
    chunks: list[bytes] = []
    while True:
        received = connection.recv(4096)
        if not received:
            break
        chunks.append(received)
        if received.endswith(b"\x00") or received.endswith(b"\n"):
            break
    return b"".join(chunks).rstrip(b"\x00\n").decode("utf-8", errors="replace")


def interpret_clamd_response(raw: str) -> ScanResult:
    """Turn a clamd reply into a verdict.

    Anything unrecognised becomes `error`, never `clean`. A parser that guesses
    optimistically at an unfamiliar reply is how an infected file gets released.
    """
    reply = raw.strip()
    if not reply:
        return ScanResult(
            verdict=ScanVerdict.error,
            detail="The malware scanner returned an empty response.",
        )

    # clamd replies as "stream: OK", "stream: <Signature> FOUND", or
    # "stream: <reason> ERROR".
    if reply.endswith("OK") and "FOUND" not in reply:
        return ScanResult(verdict=ScanVerdict.clean)

    if reply.endswith("FOUND"):
        _, _, remainder = reply.partition(":")
        signature = remainder.strip().removesuffix("FOUND").strip()
        return ScanResult(
            verdict=ScanVerdict.infected,
            detail=signature or "An unnamed signature matched.",
        )

    if reply.endswith("ERROR"):
        _, _, remainder = reply.partition(":")
        reason = remainder.strip().removesuffix("ERROR").strip().lower()
        # These are refusals to look, not statements that the file is safe.
        if any(
            marker in reason for marker in ("encrypted", "size limit", "recursion", "max files")
        ):
            return ScanResult(
                verdict=ScanVerdict.unscannable,
                detail=f"The scanner could not inspect the file: {reason}.",
            )
        return ScanResult(
            verdict=ScanVerdict.error,
            detail=f"The malware scanner reported an error: {reason}.",
        )

    return ScanResult(
        verdict=ScanVerdict.error,
        detail="The malware scanner returned a response that was not understood.",
    )


@lru_cache(maxsize=1)
def get_scanner() -> MalwareScanner:
    return MalwareScanner(get_settings().scanner)

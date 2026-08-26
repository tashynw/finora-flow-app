"""IMAPS client for the controlled mailbox.

The platform reads a mailbox that a forwarding rule outside this system delivers
into. It never connects to a provider-specific API, and it never sends mail on
this connection.

Two behaviours are load-bearing:

UIDs are only meaningful inside a UIDVALIDITY. The server is free to renumber a
folder, and when it does, every stored UID points at a different message. The
worker reads UIDVALIDITY on every select and discards its checkpoint when it
changes, because resuming from a stale UID silently skips real invoices while
reporting that the mailbox is up to date.

Messages are moved, not deleted. A processed message goes to a Processed folder
and a failure goes to Exception, so the mailbox itself is a recoverable record of
what the platform saw. Nothing is ever expunged before it has been durably
stored, and the copy-based fallback for servers without MOVE defers its expunge
to the end of a committed batch rather than doing it inline.
"""

from __future__ import annotations

import imaplib
import re
import ssl
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Final

import structlog

from finora.config import ImapSettings

logger = structlog.get_logger(__name__)

#: Server responses are bounded to keep a hostile or broken server from
#: exhausting memory. 40 MB comfortably exceeds any legitimate invoice mail.
MAX_MESSAGE_BYTES: Final[int] = 40 * 1024 * 1024

_UIDVALIDITY = re.compile(rb"UIDVALIDITY\s+(\d+)", re.IGNORECASE)
_UID_IN_FETCH = re.compile(rb"UID\s+(\d+)", re.IGNORECASE)
_STORAGE_QUOTA = re.compile(rb"STORAGE\s+(\d+)\s+(\d+)", re.IGNORECASE)


class ImapError(Exception):
    """A mailbox operation failed and must not be reported as success."""


@dataclass(frozen=True, slots=True)
class FolderState:
    name: str
    uid_validity: int
    message_count: int


@dataclass(frozen=True, slots=True)
class FetchedMessage:
    uid: int
    raw: bytes


@dataclass(frozen=True, slots=True)
class MailboxQuota:
    """Storage usage reported by the server, in kilobytes.

    `supported` is false when the server does not advertise the QUOTA extension.
    That is not a failure, but it does mean the platform cannot warn before the
    mailbox fills, so it is reported rather than presented as healthy.
    """

    supported: bool
    used_kb: int | None = None
    limit_kb: int | None = None

    @property
    def used_ratio(self) -> float | None:
        if not self.limit_kb or self.used_kb is None:
            return None
        return self.used_kb / self.limit_kb


class ImapMailbox:
    """A thin, explicit wrapper over `imaplib`.

    Deliberately not a general-purpose client. It exposes only the operations
    intake needs, which keeps the trust boundary small and makes every network
    call auditable.
    """

    def __init__(self, settings: ImapSettings):
        self._settings = settings
        self._connection: imaplib.IMAP4 | None = None

    # ------------------------------------------------------------- connection

    def connect(self) -> None:
        settings = self._settings
        try:
            if settings.use_tls:
                context = ssl.create_default_context()
                if not settings.verify_certificate:
                    # Only ever acceptable against a local test server. A real
                    # mailbox connection that skips verification is a
                    # man-in-the-middle waiting to happen.
                    logger.warning("imap.certificate_verification_disabled")
                    context.check_hostname = False
                    context.verify_mode = ssl.CERT_NONE
                connection: imaplib.IMAP4 = imaplib.IMAP4_SSL(
                    settings.host, settings.port, ssl_context=context
                )
            else:
                connection = imaplib.IMAP4(settings.host, settings.port)

            connection.login(settings.username, settings.password.get_secret_value())
        except (OSError, imaplib.IMAP4.error, ssl.SSLError) as error:
            raise ImapError(
                f"Could not connect to the mailbox at {settings.host}:{settings.port}."
            ) from error

        self._connection = connection

    def close(self) -> None:
        if self._connection is None:
            return
        try:
            self._connection.logout()
        except (OSError, imaplib.IMAP4.error):
            # Already gone. Nothing useful to do, and raising here would mask
            # whatever the caller was actually doing.
            logger.debug("imap.logout_failed")
        finally:
            self._connection = None

    @property
    def _active(self) -> imaplib.IMAP4:
        if self._connection is None:
            raise ImapError("The mailbox connection is not open.")
        return self._connection

    # ----------------------------------------------------------------- folders

    def ensure_folder(self, name: str) -> None:
        """Create a folder if the server does not already have it.

        An existing folder is not an error: two workers starting together will
        both try, and only one can win.
        """
        status, response = self._active.create(_quote(name))
        if status == "OK":
            return
        text = b" ".join(part for part in response if isinstance(part, bytes)).lower()
        if b"already exists" in text or b"alreadyexists" in text:
            return
        raise ImapError(f"Could not create the mailbox folder '{name}'.")

    def select(self, name: str, *, readonly: bool = False) -> FolderState:
        """Select a folder and read its UIDVALIDITY.

        UIDVALIDITY is read on every select rather than cached, because that is
        the only signal that stored UIDs have become meaningless.
        """
        status, response = self._active.select(_quote(name), readonly=readonly)
        if status != "OK":
            raise ImapError(f"Could not open the mailbox folder '{name}'.")

        count = _first_int(response) or 0

        status, uid_response = self._active.status(_quote(name), "(UIDVALIDITY)")
        if status != "OK":
            raise ImapError(f"The server did not report UIDVALIDITY for '{name}'.")

        uid_validity = _extract_uid_validity(uid_response)
        if uid_validity is None:
            raise ImapError(
                f"The server returned an unreadable UIDVALIDITY for '{name}'. "
                "Refusing to fetch, because UIDs cannot be trusted without it."
            )

        return FolderState(name=name, uid_validity=uid_validity, message_count=count)

    def quota(self, folder: str) -> MailboxQuota:
        """Storage quota for the folder's quota root, where the server reports one.

        A full mailbox stops delivery silently from this platform's point of view:
        the forwarding rule fails outside the system and nothing arrives, which
        looks identical to a quiet day. Reporting usage is the only way that
        becomes visible before invoices are lost.
        """
        connection = self._active
        if "QUOTA" not in _capabilities(connection):
            return MailboxQuota(supported=False)

        try:
            status, response = connection.getquotaroot(_quote(folder))
        except imaplib.IMAP4.error:
            return MailboxQuota(supported=False)
        if status != "OK":
            return MailboxQuota(supported=False)

        for group in response:
            parts = group if isinstance(group, list) else [group]
            for part in parts:
                if not isinstance(part, bytes):
                    continue
                match = _STORAGE_QUOTA.search(part)
                if match:
                    return MailboxQuota(
                        supported=True,
                        used_kb=int(match.group(1)),
                        limit_kb=int(match.group(2)),
                    )

        # The extension is advertised but no STORAGE resource was returned, which
        # some servers do when the quota root is unlimited.
        return MailboxQuota(supported=True)

    # ----------------------------------------------------------------- fetching

    def search_uids(self, uid_range: str) -> list[int]:
        """UIDs in a range, oldest first.

        Ordering matters: processing oldest-first means the checkpoint only ever
        advances past messages that have actually been stored.
        """
        status, response = self._active.uid("SEARCH", "UID", uid_range)
        if status != "OK":
            raise ImapError(f"Could not search the mailbox for UIDs {uid_range}.")

        uids: list[int] = []
        for part in response:
            if not isinstance(part, bytes):
                continue
            for token in part.split():
                try:
                    uids.append(int(token))
                except ValueError:
                    continue
        return sorted(uids)

    def fetch(self, uid: int) -> FetchedMessage | None:
        """Fetch one message by UID, as raw bytes.

        `BODY.PEEK[]` rather than `BODY[]`, so fetching does not set the Seen
        flag. A crash mid-ingest must leave the message looking untouched, or the
        next run will skip it.
        """
        status, response = self._active.uid("FETCH", str(uid), "(BODY.PEEK[])")
        if status != "OK":
            raise ImapError(f"Could not fetch message UID {uid}.")

        for part in response:
            if isinstance(part, tuple) and len(part) >= 2:
                raw = part[1]
                if not isinstance(raw, bytes):
                    continue
                if len(raw) > MAX_MESSAGE_BYTES:
                    raise ImapError(
                        f"Message UID {uid} is {len(raw):,} bytes, above the "
                        f"{MAX_MESSAGE_BYTES:,} byte limit."
                    )
                return FetchedMessage(uid=uid, raw=raw)

        # A UID that searched but did not fetch has been moved or deleted by
        # something else. Not an error; the caller skips it.
        logger.info("imap.message_vanished", uid=uid)
        return None

    # ------------------------------------------------------------------ moving

    def move(self, uid: int, destination: str) -> None:
        """Move a message to another folder.

        Prefers the server-side MOVE extension, which is atomic. Falls back to
        copy-then-flag, and never expunges: a message that has been copied is
        safe to leave marked in place, whereas an expunge that races a failure
        destroys the only remaining copy.
        """
        connection = self._active

        if "MOVE" in _capabilities(connection):
            status, _ = connection.uid("MOVE", str(uid), _quote(destination))
            if status == "OK":
                return
            logger.warning("imap.move_failed_falling_back", uid=uid)

        status, _ = connection.uid("COPY", str(uid), _quote(destination))
        if status != "OK":
            raise ImapError(f"Could not copy message UID {uid} to '{destination}'.")

        status, _ = connection.uid("STORE", str(uid), "+FLAGS", "(\\Deleted)")
        if status != "OK":
            # The copy succeeded, so the message is not lost. Flagging failed,
            # which means it will be seen again and deduplicated on identity.
            logger.warning("imap.flag_failed_after_copy", uid=uid)

    def expunge(self) -> None:
        """Remove messages already flagged deleted.

        Called only after every message in the batch has been durably stored, so
        an interrupted run leaves mail in the mailbox rather than losing it.
        """
        status, _ = self._active.expunge()
        if status != "OK":
            raise ImapError("Could not expunge the mailbox.")


def _quote(name: str) -> str:
    """Quote a folder name for the IMAP wire format.

    Folder names come from configuration rather than from user input, but they
    are still interpolated into a command, so quoting is not optional.
    """
    escaped = name.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _capabilities(connection: imaplib.IMAP4) -> frozenset[str]:
    return frozenset(capability.upper() for capability in connection.capabilities)


def _extract_uid_validity(response: list[bytes | None]) -> int | None:
    for part in response:
        if not isinstance(part, bytes):
            continue
        match = _UIDVALIDITY.search(part)
        if match:
            return int(match.group(1))
    return None


def _first_int(response: list[bytes | None]) -> int | None:
    for part in response:
        if isinstance(part, bytes):
            try:
                return int(part)
            except ValueError:
                continue
    return None


@contextmanager
def open_mailbox(settings: ImapSettings) -> Iterator[ImapMailbox]:
    """Open a mailbox and always close it, even on failure."""
    mailbox = ImapMailbox(settings)
    mailbox.connect()
    try:
        yield mailbox
    finally:
        mailbox.close()

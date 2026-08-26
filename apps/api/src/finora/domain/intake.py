"""Intake policy.

Everything arriving here is untrusted. A forwarded message is attacker-influenced
input: the sender, the display name, the subject, the filenames and the file
bytes are all chosen by someone outside the organization, and a forwarding rule
does not make any of it trustworthy.

This module holds the decisions that must not vary by call site: what may be
stored, what a file is actually allowed to be, how a filename is made safe, and
when intake must stop rather than guess.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Final


class IntakeSource(StrEnum):
    """How a message entered the platform."""

    imap = "imap"
    manual_upload = "manual_upload"


class IntakeStatus(StrEnum):
    """Lifecycle of an inbound message.

    Nothing reaches `ready` until every attachment has a scan verdict, so a
    downstream module cannot open a file that was never checked.
    """

    received = "received"
    scanning = "scanning"
    quarantined = "quarantined"
    ready = "ready"
    failed = "failed"


TERMINAL_INTAKE_STATUSES: Final[frozenset[IntakeStatus]] = frozenset(
    {IntakeStatus.quarantined, IntakeStatus.ready, IntakeStatus.failed}
)


class ScanVerdict(StrEnum):
    clean = "clean"
    infected = "infected"
    # The scanner answered, but could not reach a conclusion: an encrypted
    # archive, a nesting limit, or a size refusal. Not the same as `clean`.
    unscannable = "unscannable"
    # The scanner itself failed or was unreachable.
    error = "error"


#: Verdicts that permit a file to be opened by a person or a later stage.
RELEASABLE_VERDICTS: Final[frozenset[ScanVerdict]] = frozenset({ScanVerdict.clean})


class IntakeRejection(StrEnum):
    """Why intake refused a file, in terms a user can act on."""

    empty_file = "empty_file"
    too_large = "too_large"
    disallowed_type = "disallowed_type"
    content_type_mismatch = "content_type_mismatch"
    encrypted_document = "encrypted_document"
    archive_too_many_entries = "archive_too_many_entries"
    archive_expansion_ratio = "archive_expansion_ratio"
    malformed = "malformed"


class IntakeError(Exception):
    """Base class for refusals that must be reported, not swallowed."""


class AttachmentRejectedError(IntakeError):
    def __init__(self, reason: IntakeRejection, message: str) -> None:
        super().__init__(message)
        self.reason = reason


# --------------------------------------------------------------- content types

# Allow-list, not a block-list. A block-list of dangerous extensions is a losing
# game: the set of executable containers grows faster than the list.
ALLOWED_CONTENT_TYPES: Final[frozenset[str]] = frozenset(
    {
        "application/pdf",
        "image/jpeg",
        "image/png",
        "image/tiff",
        "image/heic",
        # Office formats are genuinely used for estimates and statements.
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/msword",
        "text/csv",
        "text/plain",
        # A forwarded message may itself be attached as a file.
        "message/rfc822",
    }
)

#: Magic-byte signatures, checked against the declared content type. A sender
#: controls the declared type and the filename; they do not control what the
#: bytes actually are.
_SIGNATURES: Final[tuple[tuple[bytes, frozenset[str]], ...]] = (
    (b"%PDF-", frozenset({"application/pdf"})),
    (b"\xff\xd8\xff", frozenset({"image/jpeg"})),
    (b"\x89PNG\r\n\x1a\n", frozenset({"image/png"})),
    (b"II*\x00", frozenset({"image/tiff"})),
    (b"MM\x00*", frozenset({"image/tiff"})),
    (
        b"PK\x03\x04",
        frozenset(
            {
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            }
        ),
    ),
    (
        b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1",
        frozenset({"application/vnd.ms-excel", "application/msword"}),
    ),
)

#: Types whose bytes carry no reliable signature. These are verified by the
#: scanner and by downstream parsing rather than by a magic-byte check.
_UNSIGNED_TYPES: Final[frozenset[str]] = frozenset(
    {"text/csv", "text/plain", "message/rfc822", "image/heic"}
)

#: Extension shown to the user, derived from the verified type rather than from
#: the sender-supplied filename.
CANONICAL_EXTENSIONS: Final[dict[str, str]] = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/tiff": ".tif",
    "image/heic": ".heic",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/msword": ".doc",
    "text/csv": ".csv",
    "text/plain": ".txt",
    "message/rfc822": ".eml",
}


def sniff_content_type(data: bytes) -> str | None:
    """The content type implied by the leading bytes, if any is recognised."""
    for signature, types in _SIGNATURES:
        if data.startswith(signature):
            # A signature can be shared by several types, so the caller decides
            # which of them was declared. Returning the first is only a hint.
            return next(iter(sorted(types)))
    return None


def content_type_matches_bytes(declared: str, data: bytes) -> bool:
    """Whether the declared type is consistent with the actual bytes.

    A mismatch is treated as hostile rather than as a client mistake: renaming an
    executable to `.pdf` is the oldest trick in the set, and a legitimate mail
    client does not do it.
    """
    if declared in _UNSIGNED_TYPES:
        return True
    for signature, types in _SIGNATURES:
        if data.startswith(signature):
            return declared in types
    return False


# ------------------------------------------------------------------- filenames

_UNSAFE_CHARS = re.compile(r'[\x00-\x1f\x7f<>:"/\\|?*]')
_COLLAPSE_DOTS = re.compile(r"\.{2,}")
_COLLAPSE_SPACE = re.compile(r"\s+")

#: Bidirectional overrides and other invisible formatting characters. These are
#: not control characters and survive NFKC normalisation, but they let a sender
#: make `invoice\u202Efdp.exe` render to a human as `invoice exe.pdf`. Removing
#: them is the only way a displayed filename can be trusted to match the file.
_INVISIBLE_CHARS = re.compile(
    "["
    "\u200b-\u200f"  # zero-width space through RTL mark
    "\u202a-\u202e"  # embedding and override controls
    "\u2060-\u2064"  # word joiner and invisible operators
    "\u2066-\u2069"  # isolate controls
    "\ufeff"  # byte order mark
    "]"
)

#: Reserved on Windows even with an extension. The platform does not run on
#: Windows, but an exported archive may be opened there.
_RESERVED_STEMS: Final[frozenset[str]] = frozenset(
    {"con", "prn", "aux", "nul"}
    | {f"com{i}" for i in range(1, 10)}
    | {f"lpt{i}" for i in range(1, 10)}
)

MAX_FILENAME_LENGTH: Final[int] = 120


def safe_filename(raw: str, *, content_type: str | None = None) -> str:
    """Reduce a sender-supplied filename to something safe to store and display.

    Path separators, control characters and traversal sequences are removed
    rather than escaped, and the extension is taken from the verified content
    type where one is known, so a display name can never disagree with what the
    file actually is.
    """
    # Normalise first: a decomposed or full-width character can otherwise slip
    # past the character filter and still render as a separator.
    name = unicodedata.normalize("NFKC", raw or "").strip()

    # Before anything else, so a bidi override cannot hide a separator or make
    # the extension read differently from what it is.
    name = _INVISIBLE_CHARS.sub("", name)

    # Discard any directory component the sender included.
    name = name.replace("\\", "/").rsplit("/", 1)[-1]

    name = _UNSAFE_CHARS.sub("_", name)
    name = _COLLAPSE_DOTS.sub(".", name)
    name = _COLLAPSE_SPACE.sub(" ", name).strip(" .")

    stem, _, extension = name.rpartition(".")
    if not stem:
        stem, extension = name, ""

    if stem.lower() in _RESERVED_STEMS:
        stem = f"{stem}_file"

    if content_type and content_type in CANONICAL_EXTENSIONS:
        extension = CANONICAL_EXTENSIONS[content_type].lstrip(".")

    stem = stem[:MAX_FILENAME_LENGTH] or "attachment"
    return f"{stem}.{extension}" if extension else stem


# ---------------------------------------------------------------------- hashing


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --------------------------------------------------------------- validation


@dataclass(frozen=True, slots=True)
class AttachmentLimits:
    """Resource limits, supplied from configuration rather than hard-coded."""

    max_bytes: int
    max_archive_entries: int
    max_archive_expansion_ratio: int


@dataclass(frozen=True, slots=True)
class ValidatedAttachment:
    """An attachment that passed structural validation.

    Passing validation says nothing about whether the file is safe; it only means
    the file is the type it claims to be and is within resource limits. The scan
    verdict decides safety.
    """

    filename: str
    content_type: str
    size_bytes: int
    sha256: str
    original_filename: str


def validate_attachment(
    *,
    filename: str,
    declared_content_type: str | None,
    data: bytes,
    limits: AttachmentLimits,
) -> ValidatedAttachment:
    """Check one attachment against policy, or refuse it with a reason.

    Refusal is always explicit. There is no path here that quietly drops a file,
    because a silently discarded invoice looks identical to an invoice that was
    never sent.
    """
    if not data:
        raise AttachmentRejectedError(
            IntakeRejection.empty_file,
            "The file is empty. Ask the sender to resend the attachment.",
        )

    if len(data) > limits.max_bytes:
        raise AttachmentRejectedError(
            IntakeRejection.too_large,
            f"The file is {len(data):,} bytes, above the "
            f"{limits.max_bytes:,} byte limit. Ask the sender to split it.",
        )

    content_type = (declared_content_type or "").split(";")[0].strip().lower()
    if content_type not in ALLOWED_CONTENT_TYPES:
        sniffed = sniff_content_type(data)
        if sniffed in ALLOWED_CONTENT_TYPES:
            # The declaration was wrong but the bytes are an accepted type. Trust
            # the bytes, which the sender cannot misrepresent as easily.
            content_type = sniffed
        else:
            raise AttachmentRejectedError(
                IntakeRejection.disallowed_type,
                f"Files of type '{content_type or 'unknown'}' are not accepted. "
                "Send a PDF, image, or Office document.",
            )

    if not content_type_matches_bytes(content_type, data):
        raise AttachmentRejectedError(
            IntakeRejection.content_type_mismatch,
            "The file contents do not match the file type it claims to be. It has not been stored.",
        )

    return ValidatedAttachment(
        filename=safe_filename(filename, content_type=content_type),
        content_type=content_type,
        size_bytes=len(data),
        sha256=sha256_hex(data),
        original_filename=filename,
    )


# ------------------------------------------------------------- idempotency keys


@dataclass(frozen=True, slots=True)
class MessageIdentity:
    """What makes an inbound message unique.

    A forwarding rule can deliver the same message twice, a mailbox can be
    re-synchronised after a UIDVALIDITY change, and a user can upload the same
    file twice. All three must land on the same identity so the platform records
    one invoice rather than three.
    """

    #: RFC 822 Message-ID, when the message has a usable one.
    message_id: str | None
    #: Hash of the complete raw message, which every message has.
    raw_sha256: str

    @property
    def idempotency_key(self) -> str:
        """Stable key for duplicate detection.

        The raw hash is always included. A Message-ID alone is not sufficient:
        it is sender-controlled and may be duplicated or absent, and two
        different forwards of one message have different raw bytes but should
        still be recognised by Message-ID.
        """
        if self.message_id:
            return f"mid:{_normalise_message_id(self.message_id)}"
        return f"raw:{self.raw_sha256}"


def _normalise_message_id(value: str) -> str:
    return value.strip().strip("<>").lower()


# ------------------------------------------------------------ IMAP checkpoints


class CheckpointResetReason(StrEnum):
    """Why a mailbox checkpoint had to be discarded."""

    uidvalidity_changed = "uidvalidity_changed"
    folder_recreated = "folder_recreated"
    manual_reset = "manual_reset"


@dataclass(frozen=True, slots=True)
class MailboxCheckpoint:
    """Where the IMAP worker had reached in one folder.

    UIDs are only meaningful within a given UIDVALIDITY. If the server reports a
    different UIDVALIDITY, every stored UID refers to a different message and
    must be discarded, or the worker will skip real mail while believing it is
    up to date.
    """

    folder: str
    uid_validity: int
    last_seen_uid: int
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def advance(self, uid: int) -> MailboxCheckpoint:
        if uid <= self.last_seen_uid:
            # Going backwards would cause the same message to be fetched
            # forever, so this is a programming error rather than a data case.
            raise ValueError(f"UID {uid} is not ahead of the checkpoint at {self.last_seen_uid}.")
        return MailboxCheckpoint(
            folder=self.folder,
            uid_validity=self.uid_validity,
            last_seen_uid=uid,
            updated_at=datetime.now(UTC),
        )

    def accepts(self, *, uid_validity: int) -> bool:
        return uid_validity == self.uid_validity


def next_uid_range(
    checkpoint: MailboxCheckpoint | None,
    *,
    uid_validity: int,
    batch_size: int,
) -> tuple[str, CheckpointResetReason | None]:
    """The IMAP UID range to fetch next, and whether a reset is required.

    Returns an open-ended range. An upper bound would silently skip anything
    that arrived after it was computed.
    """
    if batch_size < 1:
        raise ValueError("batch_size must be at least 1.")

    if checkpoint is None:
        return "1:*", None

    if not checkpoint.accepts(uid_validity=uid_validity):
        # Start again from the beginning. Duplicate detection prevents this from
        # re-ingesting anything already recorded, so a full re-scan is safe and
        # is far better than missing mail.
        return "1:*", CheckpointResetReason.uidvalidity_changed

    return f"{checkpoint.last_seen_uid + 1}:*", None

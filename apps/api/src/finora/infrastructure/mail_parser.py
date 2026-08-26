"""RFC 822 parsing.

The raw bytes are the evidence and are stored untouched. What this module
produces is a *derived* view used to populate the workspace, and it is derived
defensively: a malformed message yields a partial result with a recorded reason
rather than an exception that strands the message in the mailbox forever.

Nothing here interprets message content as instructions. Body text is extracted
for display and for later extraction, never evaluated.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email import message_from_bytes, policy
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.utils import getaddresses, parsedate_to_datetime
from typing import Final

from finora.domain.intake import (
    MessageIdentity,
    safe_filename,
    sha256_hex,
)
from finora.domain.mail_correlation import parse_references

#: Depth limit for nested `message/rfc822` parts. A message forwarded through a
#: chain of mailboxes nests legitimately, but unbounded recursion on
#: attacker-supplied input is a denial-of-service primitive.
MAX_NESTING_DEPTH: Final[int] = 8

#: Cap on extracted attachments per message, independent of the size limit. A
#: message with 10,000 one-byte parts passes every size check.
MAX_ATTACHMENTS: Final[int] = 100

#: Body text kept for display. The full body remains in the raw message.
MAX_BODY_CHARS: Final[int] = 200_000

_WHITESPACE = re.compile(r"[ \t]*\r?\n[ \t]*")


@dataclass(frozen=True, slots=True)
class ParsedAttachment:
    """One candidate attachment, before intake policy has judged it."""

    filename: str
    declared_content_type: str
    data: bytes
    #: Where in the MIME tree this was found, for evidence and debugging.
    part_path: str
    #: True when the part had no explicit disposition, for example an inline
    #: image. Kept distinct because signature logos arrive this way.
    inline: bool


@dataclass(slots=True)
class ParsedMessage:
    """The derived view of one inbound message."""

    raw_sha256: str
    raw_size_bytes: int

    message_id: str | None
    subject: str
    from_address: str | None
    from_display_name: str | None
    to_addresses: list[str] = field(default_factory=list)
    cc_addresses: list[str] = field(default_factory=list)
    reply_to_address: str | None = None
    sent_at: datetime | None = None

    #: Threading headers, kept raw. These are the evidence that correlation
    #: reasons from, so they are stored as they arrived rather than as whatever
    #: conclusion was drawn from them — a reviewer looking at a surprising match
    #: needs to see what was actually in the message.
    in_reply_to: str | None = None
    references: list[str] = field(default_factory=list)

    #: Everything that says a machine sent this. Gathered here rather than
    #: re-parsed later, because by the time a claim is being considered the raw
    #: message is in object storage and nobody is going to fetch it back.
    delivered_to: list[str] = field(default_factory=list)
    auto_submitted: str | None = None
    precedence: str | None = None
    return_path: str | None = None
    autoreply_markers: list[str] = field(default_factory=list)
    content_type: str | None = None

    #: Set when the message appears to be a forward, and the original sender
    #: could be recovered from the attached or quoted original.
    forwarded_from_address: str | None = None
    forwarded_shape: str | None = None

    body_text: str = ""
    attachments: list[ParsedAttachment] = field(default_factory=list)

    #: Non-fatal problems encountered while parsing. Surfaced to the operator so
    #: a partially understood message is visibly partial.
    warnings: list[str] = field(default_factory=list)

    @property
    def identity(self) -> MessageIdentity:
        return MessageIdentity(message_id=self.message_id, raw_sha256=self.raw_sha256)


def _decode_header_value(raw: str | None) -> str:
    """Decode an RFC 2047 header into text, without ever raising.

    A header is sender-controlled and frequently malformed. A decode failure must
    not lose the whole message, so the undecoded value is returned instead.
    """
    if not raw:
        return ""
    try:
        decoded = str(make_header(decode_header(raw)))
    except (UnicodeDecodeError, LookupError, ValueError):
        decoded = raw
    # Folded headers arrive with embedded newlines, which would break both
    # display and any log line the value appears in.
    return _WHITESPACE.sub(" ", decoded).strip()


def _addresses(message: EmailMessage, header: str) -> list[str]:
    values = message.get_all(header, [])
    if not values:
        return []
    try:
        pairs = getaddresses([_decode_header_value(str(v)) for v in values])
    except (ValueError, AttributeError):
        return []
    return [address.lower() for _, address in pairs if address and "@" in address]


def _first_address(message: EmailMessage, header: str) -> tuple[str | None, str | None]:
    """The first address and display name from a header."""
    values = message.get_all(header, [])
    if not values:
        return None, None
    try:
        pairs = getaddresses([_decode_header_value(str(v)) for v in values])
    except (ValueError, AttributeError):
        return None, None
    for display_name, address in pairs:
        if address and "@" in address:
            return address.lower(), _decode_header_value(display_name) or None
    return None, None


def _sent_at(message: EmailMessage, warnings: list[str]) -> datetime | None:
    raw = message.get("Date")
    if raw is None:
        return None

    # Under `policy.default` a malformed Date renders as an empty string and
    # records a defect instead of raising, so an unreadable date would otherwise
    # look identical to no date at all.
    if getattr(raw, "defects", ()):
        warnings.append("The Date header could not be read.")
        return None

    if not str(raw):
        return None

    try:
        parsed = parsedate_to_datetime(str(raw))
    except (TypeError, ValueError):
        warnings.append("The Date header could not be read.")
        return None

    # A naive Date means the sender omitted the offset. Treating it as UTC is a
    # stated assumption rather than a silent one.
    if parsed.tzinfo is None:
        warnings.append("The Date header had no timezone and was read as UTC.")
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _payload_bytes(part: EmailMessage, warnings: list[str], path: str) -> bytes | None:
    try:
        payload = part.get_payload(decode=True)
    except Exception:
        # A malformed transfer encoding raises a range of types from deep inside
        # the email package. Any of them means this part is undecodable, and
        # losing one part must not lose the message.
        warnings.append(f"Part {path} could not be decoded and was skipped.")
        return None
    # `get_payload(decode=True)` yields bytes for a leaf part, but returns the
    # nested Message for a `message/rfc822` part, which callers handle
    # separately.
    return payload if isinstance(payload, bytes) else None


def _serialise_nested(payload: object, warnings: list[str], path: str) -> bytes | None:
    """Re-render an embedded `message/rfc822` payload back to bytes."""
    if not isinstance(payload, list):
        return None
    for child in payload:
        if isinstance(child, EmailMessage):
            try:
                return child.as_bytes()
            except Exception:
                # Re-serialising mail that the parser accepted but cannot render
                # again. The outer message is still usable without it.
                warnings.append(
                    f"The forwarded original at part {path} could not be "
                    "re-read and was not stored separately."
                )
                return None
    return None


def _extract_body(part: EmailMessage, warnings: list[str], path: str) -> str:
    data = _payload_bytes(part, warnings, path)
    if data is None:
        return ""
    charset = part.get_content_charset() or "utf-8"
    try:
        text = data.decode(charset, errors="replace")
    except LookupError:
        text = data.decode("utf-8", errors="replace")
    return text


def _walk(
    part: EmailMessage,
    *,
    path: str,
    depth: int,
    result: ParsedMessage,
) -> None:
    """Collect attachments and body text from one MIME part and its children."""
    if depth > MAX_NESTING_DEPTH:
        result.warnings.append(
            f"Part {path} is nested deeper than {MAX_NESTING_DEPTH} levels and was not opened."
        )
        return

    content_type = (part.get_content_type() or "application/octet-stream").lower()
    disposition = (part.get_content_disposition() or "").lower()
    raw_filename = part.get_filename()

    if content_type == "message/rfc822":
        # A forwarded original. Keep it as an attachment in its own right, since
        # it is evidence, and also look inside it for the real invoice.
        nested = part.get_payload()
        payload_list = nested if isinstance(nested, list) else []

        # A `message/rfc822` part reports itself as multipart, so `get_payload`
        # with decoding returns nothing. The original has to be re-serialised to
        # be stored as the evidence it is.
        raw_nested = _serialise_nested(payload_list, result.warnings, path)
        if raw_nested:
            _add_attachment(
                result,
                filename=raw_filename or "forwarded-message.eml",
                content_type="message/rfc822",
                data=raw_nested,
                path=path,
                inline=disposition != "attachment",
            )

        if result.forwarded_from_address is None:
            for child in payload_list:
                if isinstance(child, EmailMessage):
                    address, _ = _first_address(child, "From")
                    if address:
                        result.forwarded_from_address = address
                        result.forwarded_shape = "attached_original"
                    break

        for index, child in enumerate(payload_list):
            if isinstance(child, EmailMessage):
                _walk(child, path=f"{path}.{index}", depth=depth + 1, result=result)
        return

    if part.is_multipart():
        payload = part.get_payload()
        children = payload if isinstance(payload, list) else []
        for index, child in enumerate(children):
            if isinstance(child, EmailMessage):
                _walk(child, path=f"{path}.{index}", depth=depth + 1, result=result)
        return

    is_body_text = content_type in {"text/plain", "text/html"} and not raw_filename
    if is_body_text and disposition != "attachment":
        if content_type == "text/plain" and len(result.body_text) < MAX_BODY_CHARS:
            text = _extract_body(part, result.warnings, path)
            remaining = MAX_BODY_CHARS - len(result.body_text)
            result.body_text += text[:remaining]
        return

    data = _payload_bytes(part, result.warnings, path)
    if data is None:
        return

    _add_attachment(
        result,
        filename=raw_filename or "attachment",
        content_type=content_type,
        data=data,
        path=path,
        inline=disposition != "attachment",
    )


def _add_attachment(
    result: ParsedMessage,
    *,
    filename: str,
    content_type: str,
    data: bytes,
    path: str,
    inline: bool,
) -> None:
    if len(result.attachments) >= MAX_ATTACHMENTS:
        warning = (
            f"The message has more than {MAX_ATTACHMENTS} attachments. "
            "The remainder were not extracted."
        )
        if warning not in result.warnings:
            result.warnings.append(warning)
        return

    result.attachments.append(
        ParsedAttachment(
            filename=safe_filename(_decode_header_value(filename)),
            declared_content_type=content_type,
            data=data,
            part_path=path,
            inline=inline,
        )
    )


_FORWARD_SUBJECT = re.compile(r"^\s*(fw|fwd|forward(ed)?)\s*:", re.IGNORECASE)
_QUOTED_FROM = re.compile(
    r"^\s*(?:>\s*)?(?:from|de|von)\s*:\s*.*?([\w.+-]+@[\w-]+\.[\w.-]+)",
    re.IGNORECASE | re.MULTILINE,
)


def _detect_forward(result: ParsedMessage) -> None:
    """Recover the original sender from a forward, where possible.

    This is a convenience for the reviewer, never an authority. The vendor of
    record is decided by a person against the vendor master, because the "From"
    line of a quoted forward is trivially forged and is exactly the lever used in
    a payment-redirection attempt.
    """
    if result.forwarded_from_address:
        return

    looks_forwarded = bool(_FORWARD_SUBJECT.match(result.subject))
    match = _QUOTED_FROM.search(result.body_text)
    if match:
        candidate = match.group(1).lower()
        if candidate != result.from_address:
            result.forwarded_from_address = candidate
            result.forwarded_shape = "quoted_inline"
            return

    if looks_forwarded:
        result.forwarded_shape = "subject_only"


def parse_message(raw: bytes) -> ParsedMessage:
    """Parse raw RFC 822 bytes into the derived view.

    Never raises for malformed input. A message that cannot be parsed at all
    still produces a record carrying the raw hash, so the evidence is preserved
    and the failure is visible in the workspace.
    """
    result = ParsedMessage(
        raw_sha256=sha256_hex(raw),
        raw_size_bytes=len(raw),
        message_id=None,
        subject="",
        from_address=None,
        from_display_name=None,
    )

    try:
        # `policy.default` yields an EmailMessage rather than a legacy Message,
        # which is what gives the typed header access used below.
        message = message_from_bytes(raw, policy=policy.default)
    except Exception:
        # The email package raises a wide range of types on hostile input. The
        # raw bytes and their hash are already recorded above, so the message
        # survives as evidence and surfaces for manual review.
        result.warnings.append(
            "The message could not be parsed. The original has been stored and needs manual review."
        )
        return result

    message_id = _decode_header_value(message.get("Message-ID"))
    result.message_id = message_id or None
    result.subject = _decode_header_value(message.get("Subject"))
    result.from_address, result.from_display_name = _first_address(message, "From")
    result.to_addresses = _addresses(message, "To")
    result.cc_addresses = _addresses(message, "Cc")
    reply_to, _ = _first_address(message, "Reply-To")
    result.reply_to_address = reply_to
    result.sent_at = _sent_at(message, result.warnings)

    result.in_reply_to = _decode_header_value(message.get("In-Reply-To")) or None
    result.references = list(parse_references(_decode_header_value(message.get("References"))))
    # Both are searched for a tag, because which one carries the address the
    # message was actually delivered to varies by relay.
    result.delivered_to = _addresses(message, "Delivered-To") + _addresses(message, "X-Original-To")
    result.auto_submitted = _decode_header_value(message.get("Auto-Submitted")) or None
    result.precedence = _decode_header_value(message.get("Precedence")) or None
    result.return_path = _decode_header_value(message.get("Return-Path")) or None
    result.autoreply_markers = [
        value
        for value in (
            _decode_header_value(message.get(name))
            for name in ("X-Autoreply", "X-Autorespond", "X-Auto-Response-Suppress")
        )
        if value
    ]
    result.content_type = (message.get_content_type() or "").lower() or None

    _walk(message, path="0", depth=0, result=result)
    _detect_forward(result)

    return result

"""Working out which conversation an incoming email belongs to.

The platform sends a supplier a question and hopes for an answer. The answer
arrives in the same mailbox as everything else — invoices, statements, spam, and
the automatic reply of everybody currently on leave — carrying no field that says
"this is about payment package PAY-000042". Matching it up is guesswork made
disciplined, and this module is the discipline.

## Four ways to match, in order, and never on the subject alone

`In-Reply-To` is what a conforming mail client sets to the `Message-ID` of the
message being answered. When it is there it is close to conclusive, and it is
there most of the time.

`References` is the whole thread. Slightly weaker, because a long-running thread
may reference a message that is not the one being answered, but it catches the
clients that thread without setting `In-Reply-To`.

A tag in the address they replied to survives both. The platform sends from an
address carrying a per-check-in tag, so a reply addressed back to it identifies
the conversation whatever the client did with the headers. This is the one that
rescues the replies forwarded through a shared inbox, which is how a
surprising share of supplier mail actually travels.

A tag in the subject line is the last resort, and it is a *tag* rather than the
subject text. The master prompt forbids relying on the subject, and rightly:
subjects are edited, truncated, translated, prefixed by five different clients,
and reused for the next month's query. An opaque marker inside the subject is a
different thing from the subject — it is a token that happens to be travelling in
a field people can see, and matching on it is matching on the token.

## The tag is not a secret, and that is deliberate

A correlation tag identifies a conversation. It does not open anything. Somebody
who learns one can, at most, cause an email of their choosing to be filed against
a check-in, where a member of staff will read it. That is a nuisance and it is
not an escalation, because a correlated reply is evidence somebody reads and
never an instruction anything obeys.

The alternative — reusing the link token, which does open the supplier's page —
would put a credential in a `Reply-To` address and a subject line, where it would
be quoted into every downstream forward of the thread. Two identifiers with two
jobs is the cheap fix and this is it.

## Machines answering machines

An out-of-office reply is not a supplier saying anything about a payment, and
answering one is how two mail systems talk to each other for a weekend. Anything
this module recognises as automatic is filed and never treated as a claim, and
nothing generated in response.
"""

from __future__ import annotations

import re
import secrets
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Final

#: The tag's alphabet and length. Lower-case and digits only: it travels through
#: mail systems that lower-case addresses, and a tag that stops matching because
#: a relay changed its case is a tag that fails in exactly the situations it was
#: added for.
TAG_ALPHABET: Final[str] = "abcdefghijklmnopqrstuvwxyz0123456789"
TAG_LENGTH: Final[int] = 16

#: How the tag appears in a subject line. Short, bracketed and prefixed, so a
#: person forwarding the thread can see it is a reference rather than deleting it
#: as noise, and so the pattern cannot match ordinary prose.
SUBJECT_PREFIX: Final[str] = "FNR"
_SUBJECT_PATTERN: Final[re.Pattern[str]] = re.compile(
    rf"\[{SUBJECT_PREFIX}-([{TAG_ALPHABET}]{{{TAG_LENGTH}}})\]"
)

#: How the tag appears in an address, using the sub-addressing convention that
#: every mainstream mail server understands: `payments+<tag>@example.com`.
_ADDRESS_PATTERN: Final[re.Pattern[str]] = re.compile(
    rf"\+({SUBJECT_PREFIX.lower()}[{TAG_ALPHABET}]{{{TAG_LENGTH}}})@"
)

_MESSAGE_ID_PATTERN: Final[re.Pattern[str]] = re.compile(r"<[^<>@\s]+@[^<>@\s]+>")


class CorrelationBasis(StrEnum):
    """How a reply was matched, kept so a reviewer can weigh it.

    Not decoration. "Matched by In-Reply-To" and "matched by a tag in the
    subject" are different degrees of confidence, and a reviewer looking at a
    surprising reply deserves to know which one they are relying on.
    """

    in_reply_to = "in_reply_to"
    references = "references"
    reply_address_tag = "reply_address_tag"
    subject_tag = "subject_tag"


BASIS_LABELS: Final[dict[CorrelationBasis, str]] = {
    CorrelationBasis.in_reply_to: "Threaded directly onto our message",
    CorrelationBasis.references: "Part of the same thread as our message",
    CorrelationBasis.reply_address_tag: "Sent back to the address we asked for",
    CorrelationBasis.subject_tag: "Carries our reference in the subject",
}

#: Weakest last. A caller trying candidates in this order stops at the strongest
#: match available rather than at whichever happened to be checked first.
BASIS_ORDER: Final[tuple[CorrelationBasis, ...]] = (
    CorrelationBasis.in_reply_to,
    CorrelationBasis.references,
    CorrelationBasis.reply_address_tag,
    CorrelationBasis.subject_tag,
)


class AutomaticKind(StrEnum):
    """What sort of machine sent this, when a machine did."""

    #: Out of office, holiday, "I have left the company".
    vacation = "vacation"
    #: The message did not arrive. Address wrong, mailbox full, domain gone.
    bounce = "bounce"
    #: Newsletters, list traffic, anything marked bulk.
    bulk = "bulk"


AUTOMATIC_LABELS: Final[dict[AutomaticKind, str]] = {
    AutomaticKind.vacation: "An out-of-office reply",
    AutomaticKind.bounce: "A delivery failure",
    AutomaticKind.bulk: "Bulk or list mail",
}

#: Subject openings that mean a machine wrote it, in the languages this mailbox
#: plausibly receives. Matched at the start only: an email whose subject *begins*
#: "Automatic reply:" is one, whereas one that mentions the phrase halfway
#: through is a person talking about them.
_AUTOMATIC_SUBJECTS: Final[tuple[str, ...]] = (
    "auto:",
    "automatic reply",
    "autoreply",
    "auto-reply",
    "out of office",
    "out-of-office",
    "away from the office",
    "on leave",
    "undeliverable",
    "undelivered mail",
    "delivery status notification",
    "delivery has failed",
    "mail delivery failed",
    "returned mail",
    "réponse automatique",
    "respuesta automática",
)

_BOUNCE_SUBJECTS: Final[tuple[str, ...]] = (
    "undeliverable",
    "undelivered mail",
    "delivery status notification",
    "delivery has failed",
    "mail delivery failed",
    "returned mail",
)

#: `Precedence` values that mark mail nothing should answer. `list` is included
#: because a supplier's ticketing system announcing itself as a list is still a
#: robot, and answering it threads our question into their queue forever.
_QUIET_PRECEDENCE: Final[frozenset[str]] = frozenset({"bulk", "list", "junk", "auto_reply"})


@dataclass(frozen=True, slots=True)
class ReplyHeaders:
    """The headers correlation and auto-reply detection need.

    A narrow view of a message on purpose. Everything here is a header a hostile
    sender controls, so keeping the surface small keeps the number of things that
    can lie small too.
    """

    message_id: str | None = None
    in_reply_to: str | None = None
    references: tuple[str, ...] = ()
    subject: str = ""
    from_address: str | None = None
    to_addresses: tuple[str, ...] = ()
    #: Every address the message was addressed to, including `Delivered-To` and
    #: the envelope recipient where the server exposed them. The tag lives in one
    #: of these and which one varies by relay.
    delivered_to: tuple[str, ...] = ()
    auto_submitted: str | None = None
    precedence: str | None = None
    return_path: str | None = None
    #: Any `X-Autoreply`, `X-Autorespond` or `X-Auto-Response-Suppress` header.
    autoreply_markers: tuple[str, ...] = field(default_factory=tuple)
    content_type: str | None = None


@dataclass(frozen=True, slots=True)
class Candidate:
    """One way this message might be matched to a conversation."""

    basis: CorrelationBasis
    value: str


def new_tag() -> str:
    """A fresh correlation tag, prefixed and ready to store.

    The random part is never allowed to begin with the prefix itself, so a tag
    can be recognised and stripped without ambiguity about whether it was already
    prefixed. Losing three combinations out of thirty-six cubed is cheaper than
    the one confusing bug that would otherwise be waiting.
    """
    prefix = SUBJECT_PREFIX.lower()
    while True:
        raw = "".join(secrets.choice(TAG_ALPHABET) for _ in range(TAG_LENGTH))
        if not raw.startswith(prefix):
            return format_tag(raw)


def format_tag(raw: str) -> str:
    """A correlation tag as it is stored and as it appears in mail."""
    return f"{SUBJECT_PREFIX.lower()}{raw}"


def subject_marker(tag: str) -> str:
    """The bracketed marker to append to an outgoing subject."""
    return f"[{SUBJECT_PREFIX}-{_strip_prefix(tag)}]"


def reply_address(base_address: str, tag: str) -> str:
    """The `Reply-To` address for a conversation, tagged by sub-addressing.

    `payments@example.com` with tag `abc…` becomes `payments+fnrabc…@example.com`.
    Requires the receiving server to deliver sub-addressed mail to the base
    mailbox, which is the default nearly everywhere and is a deployment
    prerequisite rather than something the platform can check.
    """
    local, _, domain = base_address.partition("@")
    if not domain:
        raise ValueError("A reply address needs a domain to tag.")
    return f"{local}+{format_tag(_strip_prefix(tag))}@{domain}"


def _strip_prefix(tag: str) -> str:
    lowered = tag.strip().lower()
    prefix = SUBJECT_PREFIX.lower()
    return lowered[len(prefix) :] if lowered.startswith(prefix) else lowered


def normalise_message_id(value: str) -> str:
    """A `Message-ID` in the one shape comparisons are made in.

    Angle brackets and surrounding whitespace stripped, case preserved. The
    domain part is case-insensitive in principle and the local part is not, and
    lower-casing the whole thing is the kind of helpfulness that stops two ids
    matching when they should.
    """
    return value.strip().strip("<>").strip()


def parse_references(value: str | None) -> tuple[str, ...]:
    """Every `Message-ID` in a `References` or `In-Reply-To` header.

    Parsed by pattern rather than by splitting on whitespace, because the header
    is routinely folded, comma-separated by clients that should not, and padded
    with comments. Newest last, as the header is ordered, and de-duplicated
    keeping that order: a thread that quotes the same id twice is not two
    matches.
    """
    if not value:
        return ()
    found = [normalise_message_id(match) for match in _MESSAGE_ID_PATTERN.findall(value)]
    seen: set[str] = set()
    ordered: list[str] = []
    for item in found:
        if item and item not in seen:
            seen.add(item)
            ordered.append(item)
    return tuple(ordered)


def tag_in_subject(subject: str) -> str | None:
    """The correlation tag carried in a subject line, if there is one."""
    match = _SUBJECT_PATTERN.search(subject or "")
    return format_tag(match.group(1)) if match else None


def tag_in_addresses(addresses: tuple[str, ...]) -> str | None:
    """The correlation tag carried in any of the addresses this was sent to."""
    for address in addresses:
        match = _ADDRESS_PATTERN.search((address or "").lower())
        if match:
            return match.group(1)
    return None


def candidates(headers: ReplyHeaders) -> tuple[Candidate, ...]:
    """Every way this message might be matched, strongest first.

    Returns candidates rather than a match: which conversation each value belongs
    to is a database question, and keeping it out of here is what makes the
    precedence rules testable against a handful of header dictionaries.

    `References` is walked newest first. A long thread names every message in it,
    and the most recent of ours is the one being answered.
    """
    found: list[Candidate] = []

    if headers.in_reply_to:
        for value in parse_references(headers.in_reply_to):
            found.append(Candidate(CorrelationBasis.in_reply_to, value))

    for value in reversed(headers.references):
        found.append(Candidate(CorrelationBasis.references, normalise_message_id(value)))

    address_tag = tag_in_addresses(headers.to_addresses + headers.delivered_to)
    if address_tag:
        found.append(Candidate(CorrelationBasis.reply_address_tag, address_tag))

    subject_tag = tag_in_subject(headers.subject)
    if subject_tag:
        found.append(Candidate(CorrelationBasis.subject_tag, subject_tag))

    return tuple(found)


def automatic_kind(headers: ReplyHeaders) -> AutomaticKind | None:
    """Whether a machine sent this, and what sort.

    Checked against headers first and the subject last, because the headers are
    what conforming senders set and the subject list is a net for the ones that
    do not. A false positive here costs a supplier's genuine reply being filed
    without being treated as a claim — it is still on the timeline for a person
    to read — and a false negative costs a mail loop, so the net is cast wide on
    purpose.
    """
    subject = (headers.subject or "").strip().lower()

    # An empty return path is the convention for a message nothing should reply
    # to, and is how a bounce announces itself.
    if headers.return_path is not None and headers.return_path.strip() in {"", "<>"}:
        return AutomaticKind.bounce

    content_type = (headers.content_type or "").lower()
    if "multipart/report" in content_type and "delivery-status" in content_type:
        return AutomaticKind.bounce

    if any(subject.startswith(prefix) for prefix in _BOUNCE_SUBJECTS):
        return AutomaticKind.bounce

    submitted = (headers.auto_submitted or "").strip().lower()
    if submitted and not submitted.startswith("no"):
        return AutomaticKind.vacation

    if headers.autoreply_markers:
        return AutomaticKind.vacation

    precedence = (headers.precedence or "").strip().lower()
    if precedence in _QUIET_PRECEDENCE:
        return AutomaticKind.bulk

    if any(subject.startswith(prefix) for prefix in _AUTOMATIC_SUBJECTS):
        return AutomaticKind.vacation

    return None


def is_automatic(headers: ReplyHeaders) -> bool:
    """Whether nothing should be inferred from this message and nothing sent back."""
    return automatic_kind(headers) is not None

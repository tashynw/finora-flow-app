"""Outbound messages, and the rules for getting them sent exactly once.

Mail is sent through an outbox rather than from the code that decides to send it,
because the two things fail differently and must not fail together. Handing a
message to an SMTP server inside a business transaction gives two bad outcomes and
no good one: the transaction rolls back after the mail has gone, so somebody is
chased about a sign-off that was never recorded, or the send blocks and a slow
mail server becomes a slow approval screen.

So the decision to send writes a row, the transaction commits, and a separate
worker does the talking. The cost is that a message can be attempted more than
once, which is why every row carries an idempotency key: the same reminder for the
same record at the same point in its cycle is one row however many times the
scheduler runs.
"""

from __future__ import annotations

from datetime import timedelta
from enum import StrEnum
from typing import Final


class MessageKind(StrEnum):
    """What a message is for.

    Named at this granularity because the template, the recipient rule and the
    suppression rule all differ, and because "how many escalations went out last
    month" is a question the operations screen has to answer without parsing
    subject lines.
    """

    sign_off_request = "sign_off_request"
    sign_off_reminder = "sign_off_reminder"
    sign_off_escalation = "sign_off_escalation"
    approval_request = "approval_request"
    approval_reminder = "approval_reminder"
    approval_escalation = "approval_escalation"
    decision_notice = "decision_notice"
    #: The only two that leave the organisation. Kept apart from the internal
    #: kinds because everything about them is different: the recipient is a
    #: supplier, the reply is expected and has to be correlated back, and the
    #: rate limits that stop a month-end run arriving as forty emails apply to
    #: these and to nothing else.
    vendor_check_in_request = "vendor_check_in_request"
    vendor_check_in_reminder = "vendor_check_in_reminder"


class OutboxState(StrEnum):
    pending = "pending"
    #: Claimed by a worker. A row left here after a crash is recovered by the
    #: claim timeout rather than by a human, because a stuck reminder is
    #: indistinguishable from a silent one to the person waiting on it.
    sending = "sending"
    sent = "sent"
    #: Attempts remain. Distinguished from `abandoned` so an operations screen can
    #: show what is still going to be retried without a person having to work out
    #: the attempt arithmetic.
    failed = "failed"
    abandoned = "abandoned"


#: States from which a worker may pick a message up.
SENDABLE_STATES: Final[frozenset[OutboxState]] = frozenset(
    {OutboxState.pending, OutboxState.failed}
)

#: States that will never be attempted again.
FINAL_STATES: Final[frozenset[OutboxState]] = frozenset({OutboxState.sent, OutboxState.abandoned})

STATE_LABELS: Final[dict[OutboxState, str]] = {
    OutboxState.pending: "Queued",
    OutboxState.sending: "Sending",
    OutboxState.sent: "Sent",
    OutboxState.failed: "Retrying",
    OutboxState.abandoned: "Given up",
}

KIND_LABELS: Final[dict[MessageKind, str]] = {
    MessageKind.sign_off_request: "Sign-off requested",
    MessageKind.sign_off_reminder: "Sign-off reminder",
    MessageKind.sign_off_escalation: "Sign-off escalated",
    MessageKind.approval_request: "Approval requested",
    MessageKind.approval_reminder: "Approval reminder",
    MessageKind.approval_escalation: "Approval escalated",
    MessageKind.decision_notice: "Decision notice",
    MessageKind.vendor_check_in_request: "Asked the supplier",
    MessageKind.vendor_check_in_reminder: "Asked the supplier again",
}

#: Messages addressed outside the organisation. These are the ones that need a
#: per-recipient rate limit, a correlation tag and a reply-to that can be
#: threaded, and the ones a mail-loop is possible on at all.
EXTERNAL_KINDS: Final[frozenset[MessageKind]] = frozenset(
    {MessageKind.vendor_check_in_request, MessageKind.vendor_check_in_reminder}
)

#: How long a worker may hold a claim before the message is considered orphaned.
#: Longer than any reasonable SMTP conversation, short enough that a crashed
#: worker does not strand a reminder for the rest of the day.
CLAIM_TIMEOUT: Final[timedelta] = timedelta(minutes=15)

#: First retry delay. Each subsequent attempt doubles it, so a mail server that is
#: briefly unreachable is retried quickly and one that is genuinely down is not
#: hammered.
BASE_RETRY_DELAY: Final[timedelta] = timedelta(seconds=30)

#: Ceiling on the doubling, so the last attempt of a long-failing message still
#: happens within a working day rather than a week later.
MAX_RETRY_DELAY: Final[timedelta] = timedelta(minutes=30)


def retry_delay(attempts: int) -> timedelta:
    """How long to wait before attempt number `attempts + 1`."""
    if attempts < 1:
        return BASE_RETRY_DELAY
    doubled: timedelta = BASE_RETRY_DELAY * (2 ** min(attempts - 1, 16))
    return min(doubled, MAX_RETRY_DELAY)


def is_escalation(kind: MessageKind) -> bool:
    return kind in {MessageKind.sign_off_escalation, MessageKind.approval_escalation}

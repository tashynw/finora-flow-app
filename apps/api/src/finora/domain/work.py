"""Unified work queue: everything waiting on this person, across record kinds.

An approver, a requester confirming receipt, and a clerk reviewing a document
reading each have their own register filters. Asking "what needs me" three times
and merging by eye is how the oldest thing gets missed. This module is the one
answer, ordered by how long each item has waited.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Final
from uuid import UUID


class WorkKind(StrEnum):
    """What kind of action this row is asking for."""

    approval = "approval"
    sign_off = "sign_off"
    document_review = "document_review"
    vendor_review = "vendor_review"
    intake = "intake"


WORK_KIND_LABELS: Final[dict[WorkKind, str]] = {
    WorkKind.approval: "Approval",
    WorkKind.sign_off: "Receipt confirmation",
    WorkKind.document_review: "Document review",
    WorkKind.vendor_review: "Vendor confirmation",
    WorkKind.intake: "Inbox",
}


@dataclass(frozen=True, slots=True)
class WorkItem:
    """One thing waiting on the caller."""

    kind: WorkKind
    kind_label: str
    record_id: UUID
    record_path: str
    reference: str
    title: str
    subtitle: str
    waiting_since: datetime
    waiting_hours: int
    amount_formatted: str | None = None
    detail: str | None = None


@dataclass(frozen=True, slots=True)
class WorkBadges:
    """Counts keyed to the navigation badge slots."""

    my_work: int
    awaiting_my_approval: int
    documents_needing_review: int
    intake_unprocessed: int
    vendor_needing_review: int
    operational_alerts: int

    def as_map(self) -> dict[str, int]:
        return {
            "myWork": self.my_work,
            "awaitingMyApproval": self.awaiting_my_approval,
            "documentsNeedingReview": self.documents_needing_review,
            "intakeUnprocessed": self.intake_unprocessed,
            "vendorNeedingReview": self.vendor_needing_review,
            "operationalAlerts": self.operational_alerts,
        }

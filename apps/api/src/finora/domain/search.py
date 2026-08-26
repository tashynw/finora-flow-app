"""Cross-register search: find a record by what a person actually remembers.

Registers already search their own columns. Asking three of them and merging by
eye is how the right invoice is missed while staring at an estimate with a
similar vendor name. This module is the one query surface, permission-gated per
kind, capped so a short query cannot dump the whole ledger.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Final
from uuid import UUID

from finora.domain.roles import Permission


class SearchRecordType(StrEnum):
    estimate = "estimate"
    invoice = "invoice"
    purchase_order = "purchase_order"
    payment_package = "payment_package"
    document = "document"
    vendor_check_in = "vendor_check_in"


SEARCH_TYPE_PERMISSIONS: Final[dict[SearchRecordType, Permission]] = {
    SearchRecordType.estimate: Permission.estimate_view,
    SearchRecordType.invoice: Permission.invoice_view,
    SearchRecordType.purchase_order: Permission.purchase_order_view,
    SearchRecordType.payment_package: Permission.payment_view,
    SearchRecordType.document: Permission.document_view,
    SearchRecordType.vendor_check_in: Permission.invoice_view,
}

SEARCH_TYPE_LABELS: Final[dict[SearchRecordType, str]] = {
    SearchRecordType.estimate: "Estimate",
    SearchRecordType.invoice: "Invoice",
    SearchRecordType.purchase_order: "Purchase order",
    SearchRecordType.payment_package: "Payment package",
    SearchRecordType.document: "Document",
    SearchRecordType.vendor_check_in: "Vendor confirmation",
}

# Soft floor: shorter than this returns nothing rather than scanning half the
# catalogue on a single letter.
MIN_QUERY_LENGTH: Final[int] = 2

DEFAULT_LIMIT: Final[int] = 25
MAX_LIMIT: Final[int] = 40
PER_TYPE_CAP: Final[int] = 8


@dataclass(frozen=True, slots=True)
class SearchHit:
    record_type: SearchRecordType
    type_label: str
    record_id: UUID
    record_path: str
    reference: str
    title: str
    subtitle: str
    state: str | None = None
    amount_formatted: str | None = None

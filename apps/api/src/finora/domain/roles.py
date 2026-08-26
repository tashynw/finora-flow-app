"""Roles, permissions and segregation of duties.

Authorization is deny by default: a permission is held only when a role grants
it explicitly. Separately, some permission pairs must never rest with the same
person on the same record, which is enforced as a distinct check because role
membership alone cannot express it.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Final


class Role(StrEnum):
    requester = "requester"
    approver = "approver"
    payment_coordinator = "payment_coordinator"
    finance = "finance"
    administrator = "administrator"
    operations = "operations"
    auditor = "auditor"


class ApprovalLevel(StrEnum):
    """Approval matrix tiers named by the master prompt. The amount bands that
    map to each tier are configuration, pending the requirements document."""

    unit_head = "unit_head"
    manager = "manager"
    hod = "hod"
    coo = "coo"


class Permission(StrEnum):
    # Intake and documents
    intake_view = "intake:view"
    intake_upload = "intake:upload"
    intake_retry = "intake:retry"
    intake_view_raw_headers = "intake:view_raw_headers"
    document_view = "document:view"
    document_download = "document:download"
    quarantine_view = "quarantine:view"
    quarantine_release = "quarantine:release"

    # Extraction review
    extraction_view = "extraction:view"
    extraction_edit = "extraction:edit"
    extraction_accept = "extraction:accept"

    # Estimates
    estimate_view = "estimate:view"
    estimate_create = "estimate:create"
    estimate_edit = "estimate:edit"
    estimate_submit = "estimate:submit"

    # Invoices
    invoice_view = "invoice:view"
    invoice_create = "invoice:create"
    invoice_edit = "invoice:edit"
    invoice_submit = "invoice:submit"
    invoice_sign_off = "invoice:sign_off"

    # Approvals
    approval_view = "approval:view"
    approval_decide = "approval:decide"
    approval_delegate = "approval:delegate"
    approval_override = "approval:override"

    # Purchase requisition and orders
    requisition_view = "requisition:view"
    requisition_create = "requisition:create"
    purchase_order_view = "purchase_order:view"
    purchase_order_manage = "purchase_order:manage"

    # Payments
    payment_view = "payment:view"
    payment_package_manage = "payment:package_manage"
    payment_submit = "payment:submit"
    payment_mark_paid = "payment:mark_paid"

    # Vendor confirmation
    vendor_view = "vendor:view"
    vendor_manage = "vendor:manage"
    vendor_confirmation_review = "vendor:confirmation_review"

    # Credit cards
    credit_card_view = "credit_card:view"
    credit_card_code = "credit_card:code"
    credit_card_close_period = "credit_card:close_period"

    # Accruals
    accrual_view = "accrual:view"
    accrual_edit = "accrual:edit"
    accrual_finalize = "accrual:finalize"
    accrual_lock_period = "accrual:lock_period"
    accrual_export = "accrual:export"

    # Reporting
    report_view = "report:view"
    report_export = "report:export"

    # Administration
    admin_users = "admin:users"
    admin_roles = "admin:roles"
    admin_approval_matrix = "admin:approval_matrix"
    admin_thresholds = "admin:thresholds"
    admin_reference_data = "admin:reference_data"
    admin_templates = "admin:templates"
    admin_mail_config = "admin:mail_config"
    admin_ai_config = "admin:ai_config"
    admin_retention = "admin:retention"

    # Operations and audit
    operations_view = "operations:view"
    operations_retry = "operations:retry"
    audit_view = "audit:view"


ROLE_PERMISSIONS: Final[dict[Role, frozenset[Permission]]] = {
    Role.requester: frozenset(
        {
            Permission.intake_view,
            Permission.intake_upload,
            Permission.document_view,
            Permission.estimate_view,
            Permission.estimate_create,
            Permission.estimate_edit,
            Permission.estimate_submit,
            Permission.invoice_view,
            Permission.invoice_sign_off,
            Permission.requisition_view,
            Permission.requisition_create,
            Permission.report_view,
        }
    ),
    Role.approver: frozenset(
        {
            Permission.document_view,
            Permission.estimate_view,
            Permission.invoice_view,
            Permission.approval_view,
            Permission.approval_decide,
            Permission.approval_delegate,
            Permission.requisition_view,
            Permission.purchase_order_view,
            Permission.report_view,
        }
    ),
    Role.payment_coordinator: frozenset(
        {
            Permission.document_view,
            Permission.invoice_view,
            Permission.payment_view,
            Permission.payment_package_manage,
            Permission.payment_submit,
            Permission.vendor_view,
            Permission.vendor_confirmation_review,
            Permission.purchase_order_view,
            Permission.report_view,
        }
    ),
    Role.finance: frozenset(
        {
            Permission.intake_view,
            Permission.intake_upload,
            Permission.document_view,
            Permission.document_download,
            Permission.extraction_view,
            Permission.extraction_edit,
            Permission.extraction_accept,
            Permission.estimate_view,
            Permission.invoice_view,
            Permission.invoice_create,
            Permission.invoice_edit,
            Permission.invoice_submit,
            Permission.approval_view,
            Permission.requisition_view,
            Permission.purchase_order_view,
            Permission.purchase_order_manage,
            Permission.payment_view,
            Permission.payment_mark_paid,
            Permission.vendor_view,
            Permission.vendor_confirmation_review,
            Permission.credit_card_view,
            Permission.credit_card_code,
            Permission.credit_card_close_period,
            Permission.accrual_view,
            Permission.accrual_edit,
            Permission.accrual_finalize,
            Permission.accrual_lock_period,
            Permission.accrual_export,
            Permission.report_view,
            Permission.report_export,
        }
    ),
    Role.operations: frozenset(
        {
            Permission.intake_view,
            Permission.intake_retry,
            Permission.intake_view_raw_headers,
            Permission.quarantine_view,
            Permission.operations_view,
            Permission.operations_retry,
            Permission.report_view,
        }
    ),
    Role.administrator: frozenset(
        {
            Permission.admin_users,
            Permission.admin_roles,
            Permission.admin_approval_matrix,
            Permission.admin_thresholds,
            Permission.admin_reference_data,
            Permission.admin_templates,
            Permission.admin_mail_config,
            Permission.admin_ai_config,
            Permission.admin_retention,
            Permission.operations_view,
            Permission.quarantine_view,
            Permission.quarantine_release,
            Permission.report_view,
        }
    ),
    # Read-only by design. An auditor who could alter records would defeat the
    # purpose of the role.
    Role.auditor: frozenset(
        {
            Permission.audit_view,
            Permission.intake_view,
            Permission.document_view,
            Permission.estimate_view,
            Permission.invoice_view,
            Permission.approval_view,
            Permission.requisition_view,
            Permission.purchase_order_view,
            Permission.payment_view,
            Permission.vendor_view,
            Permission.credit_card_view,
            Permission.accrual_view,
            Permission.report_view,
            Permission.operations_view,
        }
    ),
}


# Permission pairs that must not be exercised by one person on one record.
# Role assignment cannot express this, because a user legitimately holding both
# roles across the organisation still must not self-approve a single invoice.
SEGREGATION_OF_DUTIES: Final[frozenset[frozenset[Permission]]] = frozenset(
    {
        # Raising and approving the same request.
        frozenset({Permission.estimate_submit, Permission.approval_decide}),
        frozenset({Permission.invoice_submit, Permission.approval_decide}),
        frozenset({Permission.requisition_create, Permission.approval_decide}),
        # Approving a payment and then declaring it paid.
        frozenset({Permission.payment_submit, Permission.payment_mark_paid}),
        # Confirming receipt and approving the spend.
        frozenset({Permission.invoice_sign_off, Permission.approval_decide}),
        # Coding a transaction and closing the period it sits in.
        frozenset({Permission.credit_card_code, Permission.credit_card_close_period}),
        # Editing an accrual and locking it beyond further review.
        frozenset({Permission.accrual_edit, Permission.accrual_lock_period}),
    }
)


# Permission pairs that must never rest with the same person at all — not merely
# on one record. SEGREGATION_OF_DUTIES cannot express these: editing the approval
# matrix is not an action on a payment request, so a per-record check never sees
# both sides. Refused at role grant time instead (threat model T5 residual risk).
ROLE_COMPOSITION_CONFLICTS: Final[frozenset[frozenset[Permission]]] = frozenset(
    {
        frozenset({Permission.admin_approval_matrix, Permission.approval_decide}),
    }
)


class AuthorizationError(Exception):
    """Raised when a subject lacks a permission or breaches segregation."""


class SegregationOfDutiesError(AuthorizationError):
    def __init__(self, first: Permission, second: Permission) -> None:
        self.first = first
        self.second = second
        super().__init__(
            "Segregation of duties prevents the same person from performing "
            f"both {first.value} and {second.value} on one record. "
            "Another authorized user must complete this step."
        )


class RoleCompositionError(AuthorizationError):
    """Raised when a proposed set of roles would grant incompatible permissions."""

    def __init__(self, first: Permission, second: Permission) -> None:
        self.first = first
        self.second = second
        super().__init__(
            "These roles cannot be held together: "
            f"{first.value} and {second.value} must sit with different people. "
            "Give one of them to somebody else."
        )


def permissions_for(roles: frozenset[Role] | set[Role] | list[Role]) -> frozenset[Permission]:
    """Union of everything the supplied roles grant."""
    granted: set[Permission] = set()
    for role in roles:
        granted |= ROLE_PERMISSIONS[role]
    return frozenset(granted)


def has_permission(roles: frozenset[Role] | set[Role] | list[Role], permission: Permission) -> bool:
    return permission in permissions_for(roles)


def role_composition_conflict(
    roles: frozenset[Role] | set[Role] | list[Role],
) -> tuple[Permission, Permission] | None:
    """Return an incompatible permission pair granted by these roles, if any."""
    held = permissions_for(roles)
    for pair in ROLE_COMPOSITION_CONFLICTS:
        if pair <= held:
            ordered = sorted(pair, key=lambda permission: permission.value)
            return ordered[0], ordered[1]
    return None


def assert_roles_compatible(roles: frozenset[Role] | set[Role] | list[Role]) -> None:
    """Refuse a role set that would put incompatible permissions on one person."""
    conflict = role_composition_conflict(roles)
    if conflict is not None:
        raise RoleCompositionError(*conflict)


def conflicting_permission(
    candidate: Permission, already_exercised: frozenset[Permission] | set[Permission]
) -> Permission | None:
    """Return the prior action that blocks `candidate`, if any.

    `already_exercised` is the set of permissions this same user has already
    used against this specific record.
    """
    for pair in SEGREGATION_OF_DUTIES:
        if candidate not in pair:
            continue
        other = next(p for p in pair if p != candidate)
        if other in already_exercised:
            return other
    return None


def assert_can_act(
    *,
    roles: frozenset[Role] | set[Role] | list[Role],
    permission: Permission,
    already_exercised_on_record: frozenset[Permission] | set[Permission] | None = None,
) -> None:
    """Deny-by-default authorization check for a single action."""
    if not has_permission(roles, permission):
        raise AuthorizationError(f"You do not have permission to perform {permission.value}.")
    if already_exercised_on_record:
        blocker = conflicting_permission(permission, already_exercised_on_record)
        if blocker is not None:
            raise SegregationOfDutiesError(permission, blocker)

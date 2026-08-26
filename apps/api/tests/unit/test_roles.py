"""Authorization must deny by default and hold the line on segregation."""

from __future__ import annotations

import pytest

from finora.domain.roles import (
    ROLE_COMPOSITION_CONFLICTS,
    ROLE_PERMISSIONS,
    SEGREGATION_OF_DUTIES,
    AuthorizationError,
    Permission,
    Role,
    RoleCompositionError,
    SegregationOfDutiesError,
    assert_can_act,
    assert_roles_compatible,
    conflicting_permission,
    has_permission,
    permissions_for,
    role_composition_conflict,
)


class TestRoleDefinitions:
    def test_every_role_is_defined(self) -> None:
        for role in Role:
            assert role in ROLE_PERMISSIONS

    def test_no_role_is_empty(self) -> None:
        for role, perms in ROLE_PERMISSIONS.items():
            assert perms, f"{role} grants nothing"

    def test_auditor_is_read_only(self) -> None:
        """An auditor who could mutate records would defeat the role.

        The action segment is compared exactly rather than by substring,
        because names like `credit_card:view` contain mutating words by
        coincidence.
        """
        read_only_actions = {"view"}
        for permission in ROLE_PERMISSIONS[Role.auditor]:
            _, _, action = permission.value.partition(":")
            assert action in read_only_actions, f"auditor must not hold {permission.value}"

    def test_only_administrator_holds_admin_permissions(self) -> None:
        admin_perms = {p for p in Permission if p.value.startswith("admin:")}
        for role, perms in ROLE_PERMISSIONS.items():
            if role is Role.administrator:
                continue
            assert not (perms & admin_perms), f"{role} must not hold admin rights"

    def test_administrator_cannot_approve_or_pay(self) -> None:
        """Configuration authority must not carry transactional authority."""
        admin = ROLE_PERMISSIONS[Role.administrator]
        assert Permission.approval_decide not in admin
        assert Permission.payment_submit not in admin
        assert Permission.payment_mark_paid not in admin


class TestDenyByDefault:
    def test_unknown_permission_is_denied(self) -> None:
        assert not has_permission({Role.requester}, Permission.payment_submit)

    def test_no_roles_grants_nothing(self) -> None:
        assert permissions_for(set()) == frozenset()

    def test_missing_permission_raises(self) -> None:
        with pytest.raises(AuthorizationError, match="do not have permission"):
            assert_can_act(roles={Role.requester}, permission=Permission.approval_decide)

    def test_granted_permission_passes(self) -> None:
        assert_can_act(roles={Role.approver}, permission=Permission.approval_decide)

    def test_union_across_multiple_roles(self) -> None:
        combined = permissions_for({Role.requester, Role.approver})
        assert Permission.estimate_create in combined
        assert Permission.approval_decide in combined


class TestSegregationOfDuties:
    def test_pairs_are_all_two_distinct_permissions(self) -> None:
        for pair in SEGREGATION_OF_DUTIES:
            assert len(pair) == 2

    def test_submitter_cannot_approve_same_record(self) -> None:
        with pytest.raises(SegregationOfDutiesError, match="Segregation of duties"):
            assert_can_act(
                roles={Role.requester, Role.approver},
                permission=Permission.approval_decide,
                already_exercised_on_record={Permission.invoice_submit},
            )

    def test_signer_off_cannot_also_approve(self) -> None:
        with pytest.raises(SegregationOfDutiesError):
            assert_can_act(
                roles={Role.requester, Role.approver},
                permission=Permission.approval_decide,
                already_exercised_on_record={Permission.invoice_sign_off},
            )

    def test_payment_submitter_cannot_mark_paid(self) -> None:
        with pytest.raises(SegregationOfDutiesError):
            assert_can_act(
                roles={Role.payment_coordinator, Role.finance},
                permission=Permission.payment_mark_paid,
                already_exercised_on_record={Permission.payment_submit},
            )

    def test_coder_cannot_close_the_period(self) -> None:
        with pytest.raises(SegregationOfDutiesError):
            assert_can_act(
                roles={Role.finance},
                permission=Permission.credit_card_close_period,
                already_exercised_on_record={Permission.credit_card_code},
            )

    def test_conflict_is_symmetric(self) -> None:
        assert (
            conflicting_permission(Permission.invoice_submit, {Permission.approval_decide})
            is Permission.approval_decide
        )
        assert (
            conflicting_permission(Permission.approval_decide, {Permission.invoice_submit})
            is Permission.invoice_submit
        )

    def test_different_record_history_does_not_block(self) -> None:
        """Holding both roles is legitimate; only the same record conflicts."""
        assert_can_act(
            roles={Role.requester, Role.approver},
            permission=Permission.approval_decide,
            already_exercised_on_record=set(),
        )

    def test_unrelated_prior_action_does_not_block(self) -> None:
        assert_can_act(
            roles={Role.approver},
            permission=Permission.approval_decide,
            already_exercised_on_record={Permission.invoice_view},
        )


class TestRoleComposition:
    def test_administrator_and_approver_conflict(self) -> None:
        conflict = role_composition_conflict({Role.administrator, Role.approver})
        assert conflict is not None
        a, b = conflict
        assert {a, b} == {
            Permission.admin_approval_matrix,
            Permission.approval_decide,
        }

    def test_assert_roles_compatible_refuses_admin_approver(self) -> None:
        with pytest.raises(RoleCompositionError) as exc:
            assert_roles_compatible({Role.administrator, Role.approver})
        assert Permission.admin_approval_matrix in {
            exc.value.first,
            exc.value.second,
        }
        assert Permission.approval_decide in {exc.value.first, exc.value.second}

    def test_stock_roles_are_compatible(self) -> None:
        for role in Role:
            assert_roles_compatible({role})
        assert_roles_compatible({Role.finance, Role.payment_coordinator})
        assert_roles_compatible({Role.requester, Role.auditor})

    def test_composition_conflicts_mirror_threat_model_t5(self) -> None:
        assert (
            frozenset(
                {
                    Permission.admin_approval_matrix,
                    Permission.approval_decide,
                }
            )
            in ROLE_COMPOSITION_CONFLICTS
        )

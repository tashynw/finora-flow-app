"""Work queue kinds and badge keys stay aligned with the navigation."""

from finora.domain.work import WORK_KIND_LABELS, WorkBadges, WorkKind


def test_every_kind_has_a_label() -> None:
    assert set(WORK_KIND_LABELS) == set(WorkKind)


def test_badge_map_uses_nav_keys() -> None:
    badges = WorkBadges(
        my_work=3,
        awaiting_my_approval=1,
        documents_needing_review=1,
        intake_unprocessed=2,
        vendor_needing_review=1,
        operational_alerts=0,
    )
    assert badges.as_map() == {
        "myWork": 3,
        "awaitingMyApproval": 1,
        "documentsNeedingReview": 1,
        "intakeUnprocessed": 2,
        "vendorNeedingReview": 1,
        "operationalAlerts": 0,
    }

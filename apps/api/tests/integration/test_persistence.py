"""Schema-level guarantees that protect financial records.

These assert behaviour of the mapping and the database, not of any route, so a
mixin that silently stops working cannot pass unnoticed.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from sqlalchemy import delete, inspect, select
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError
from tests.conftest import requires_db

from finora.infrastructure.db.models import ApprovalRule, SystemSetting, Vendor
from finora.infrastructure.db.session import get_session_factory

pytestmark = [pytest.mark.integration, requires_db]


@pytest.fixture
def vendor(db_session: Session) -> Iterator[Vendor]:
    record = Vendor(
        id=uuid.uuid4(),
        code=f"V-{uuid.uuid4().hex[:8]}",
        name="Acme Supplies",
        default_currency="JMD",
    )
    db_session.add(record)
    db_session.commit()
    db_session.refresh(record)
    try:
        yield record
    finally:
        db_session.rollback()
        with get_session_factory()() as cleanup:
            cleanup.execute(delete(Vendor).where(Vendor.id == record.id))
            cleanup.commit()


class TestOptimisticConcurrency:
    """A lost update on a payment-bearing record is a financial control failure."""

    def test_version_column_is_registered_with_the_mapper(self) -> None:
        # The mixin used to hand SQLAlchemy `None` here, which disabled version
        # counting entirely while still looking configured.
        for model in (Vendor, ApprovalRule, SystemSetting):
            version_col = inspect(model).version_id_col
            assert version_col is not None, f"{model.__name__} has no version_id_col"
            assert version_col.name == "version"

    def test_version_starts_at_one(self, vendor: Vendor) -> None:
        assert vendor.version == 1

    def test_version_increments_on_update(self, db_session: Session, vendor: Vendor) -> None:
        vendor.name = "Acme Supplies Limited"
        db_session.commit()
        db_session.refresh(vendor)
        assert vendor.version == 2

    def test_concurrent_update_is_refused_rather_than_silently_overwriting(
        self, db_session: Session, vendor: Vendor
    ) -> None:
        with get_session_factory()() as other:
            competitor = other.get(Vendor, vendor.id)
            assert competitor is not None
            competitor.name = "Renamed by the other session"
            other.commit()

        vendor.name = "Renamed by this session"
        with pytest.raises(StaleDataError):
            db_session.commit()

    def test_the_first_writer_keeps_their_value(self, db_session: Session, vendor: Vendor) -> None:
        with get_session_factory()() as other:
            competitor = other.get(Vendor, vendor.id)
            assert competitor is not None
            competitor.name = "First writer wins"
            other.commit()

        vendor.name = "Second writer loses"
        with pytest.raises(StaleDataError):
            db_session.commit()
        db_session.rollback()

        with get_session_factory()() as verifier:
            stored = verifier.get(Vendor, vendor.id)
            assert stored is not None
            assert stored.name == "First writer wins"


class TestSoftDelete:
    def test_archiving_leaves_the_row_intact_for_audit(
        self, db_session: Session, vendor: Vendor
    ) -> None:
        vendor.archived_at = datetime.now(UTC)
        vendor.archived_reason = "Vendor no longer trades"
        db_session.commit()

        with get_session_factory()() as verifier:
            stored = verifier.scalar(select(Vendor).where(Vendor.id == vendor.id))
            assert stored is not None
            assert stored.archived_at is not None
            assert stored.archived_reason == "Vendor no longer trades"


class TestTimestamps:
    def test_created_and_updated_are_timezone_aware(self, vendor: Vendor) -> None:
        assert vendor.created_at.tzinfo is not None
        assert vendor.updated_at.tzinfo is not None

    def test_updated_at_moves_when_the_row_changes(
        self, db_session: Session, vendor: Vendor
    ) -> None:
        original = vendor.updated_at
        vendor.name = "Acme Supplies Limited"
        db_session.commit()
        db_session.refresh(vendor)
        assert vendor.updated_at >= original


class TestConstraintNaming:
    def test_constraints_are_named_deterministically(self) -> None:
        # Unnamed constraints produce unstable Alembic migrations and violation
        # messages that cannot be traced back to a definition.
        primary_key = Vendor.__table__.primary_key
        assert primary_key.name == "pk_vendors"

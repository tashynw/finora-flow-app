"""Declarative base, naming conventions and shared column types.

Constraint names are generated deterministically so Alembic produces stable
migrations and a constraint violation can be traced back to its definition.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any

from sqlalchemy import CHAR, BigInteger, DateTime, MetaData, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import (
    UUID as PgUUID,  # noqa: N811  SQLAlchemy dialect type, not a constant
)
from sqlalchemy.orm import DeclarativeBase, Mapped, declared_attr, mapped_column

NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

metadata = MetaData(naming_convention=NAMING_CONVENTION)


class Base(DeclarativeBase):
    metadata = metadata


# Money is a BIGINT count of minor units plus an ISO 4217 code. No float type
# appears anywhere near an amount.
MoneyMinorUnits = Annotated[int, mapped_column(BigInteger)]
CurrencyCode = Annotated[str, mapped_column(CHAR(3))]

# Every timestamp is stored with a timezone and held in UTC.
UtcTimestamp = Annotated[datetime, mapped_column(DateTime(timezone=True))]

Sha256Hex = Annotated[str, mapped_column(CHAR(64))]


class UuidPrimaryKey:
    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class VersionMixin:
    """Optimistic concurrency.

    SQLAlchemy increments this on flush and raises StaleDataError when the row
    changed underneath, which surfaces to the user as a reload prompt rather
    than a lost update.
    """

    version: Mapped[int] = mapped_column(default=1, nullable=False)

    @declared_attr.directive
    def __mapper_args__(cls) -> dict[str, Any]:  # noqa: N805
        # Must be a declared_attr: a plain dict on the mixin would be shared by
        # every subclass and could only ever name one class's column, which is
        # how version counting silently ends up disabled.
        return {"version_id_col": cls.version}


class SoftDeleteMixin:
    """Financial and audit records are never hard-deleted.

    A populated `archived_at` hides a row from ordinary queries while leaving it
    intact for audit.
    """

    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    archived_reason: Mapped[str | None] = mapped_column(String(500), default=None)


JsonDict = Annotated[dict, mapped_column(JSONB)]

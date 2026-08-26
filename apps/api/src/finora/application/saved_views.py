"""Create and maintain personal saved views."""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from finora.domain.work import WorkKind
from finora.infrastructure.db.models import SavedView, User

KNOWN_SCOPES = frozenset(
    {
        "work",
        "estimates",
        "invoices",
        "purchase_orders",
        "payments",
        "vendor_confirmations",
        "credit_cards",
        "accruals",
    }
)

WORK_KINDS = frozenset(kind.value for kind in WorkKind)


class SavedViewsError(Exception):
    pass


class NotFoundError(SavedViewsError):
    pass


class ValidationError(SavedViewsError):
    pass


class SavedViewsService:
    def __init__(self, session: Session) -> None:
        self._session = session

    def list_for(self, *, user: User, scope: str) -> list[SavedView]:
        cleaned = scope.strip()
        if cleaned not in KNOWN_SCOPES:
            raise ValidationError("That screen does not support saved views.")
        return list(
            self._session.execute(
                select(SavedView)
                .where(SavedView.user_id == user.id, SavedView.scope == cleaned)
                .order_by(SavedView.name)
            )
            .scalars()
            .all()
        )

    def create(
        self,
        *,
        user: User,
        scope: str,
        name: str,
        definition: dict[str, Any],
        is_default: bool = False,
    ) -> SavedView:
        cleaned_scope = scope.strip()
        cleaned_name = name.strip()
        if cleaned_scope not in KNOWN_SCOPES:
            raise ValidationError("That screen does not support saved views.")
        if not cleaned_name:
            raise ValidationError("Give the view a name.")
        if len(cleaned_name) > 120:
            raise ValidationError("Use a shorter name for the view.")

        normalised = _normalise_definition(cleaned_scope, definition)

        existing = self._session.execute(
            select(SavedView).where(
                SavedView.user_id == user.id,
                SavedView.scope == cleaned_scope,
                SavedView.name == cleaned_name,
            )
        ).scalar_one_or_none()
        if existing is not None:
            raise ValidationError("You already have a view with that name on this screen.")

        if is_default:
            self._clear_default(user_id=user.id, scope=cleaned_scope)

        row = SavedView(
            id=uuid4(),
            user_id=user.id,
            scope=cleaned_scope,
            name=cleaned_name,
            definition=normalised,
            is_default=is_default,
        )
        self._session.add(row)
        self._session.flush()
        self._session.refresh(row)
        return row

    def update(
        self,
        *,
        user: User,
        view_id: UUID,
        name: str | None = None,
        definition: dict[str, Any] | None = None,
        is_default: bool | None = None,
    ) -> SavedView:
        row = self._owned(user=user, view_id=view_id)
        if name is not None:
            cleaned_name = name.strip()
            if not cleaned_name:
                raise ValidationError("Give the view a name.")
            clash = self._session.execute(
                select(SavedView).where(
                    SavedView.user_id == user.id,
                    SavedView.scope == row.scope,
                    SavedView.name == cleaned_name,
                    SavedView.id != row.id,
                )
            ).scalar_one_or_none()
            if clash is not None:
                raise ValidationError("You already have a view with that name on this screen.")
            row.name = cleaned_name
        if definition is not None:
            row.definition = _normalise_definition(row.scope, definition)
        if is_default is True:
            self._clear_default(user_id=user.id, scope=row.scope)
            row.is_default = True
        elif is_default is False:
            row.is_default = False
        self._session.flush()
        self._session.refresh(row)
        return row

    def delete(self, *, user: User, view_id: UUID) -> None:
        row = self._owned(user=user, view_id=view_id)
        self._session.delete(row)
        self._session.flush()

    def _owned(self, *, user: User, view_id: UUID) -> SavedView:
        row = self._session.get(SavedView, view_id)
        if row is None or row.user_id != user.id:
            raise NotFoundError("That saved view was not found.")
        return row

    def _clear_default(self, *, user_id: UUID, scope: str) -> None:
        self._session.execute(
            update(SavedView)
            .where(
                SavedView.user_id == user_id,
                SavedView.scope == scope,
                SavedView.is_default.is_(True),
            )
            .values(is_default=False)
        )


def _normalise_definition(scope: str, definition: dict[str, Any]) -> dict[str, Any]:
    if scope != "work":
        # Other scopes accept a free-form object for now; registers will tighten
        # this when they switch from hardcoded VIEWS arrays.
        if not isinstance(definition, dict):
            raise ValidationError("The view definition must be an object.")
        return dict(definition)

    raw_kinds = definition.get("kinds")
    if not isinstance(raw_kinds, list) or not raw_kinds:
        raise ValidationError("Choose at least one kind of work for this view.")
    kinds: list[str] = []
    for item in raw_kinds:
        if not isinstance(item, str) or item not in WORK_KINDS:
            raise ValidationError(f"Unknown kind of work: {item!r}.")
        if item not in kinds:
            kinds.append(item)
    return {"kinds": kinds}

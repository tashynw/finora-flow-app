"""Deep links that go into email, and what they are and are not allowed to do.

The important decision in this module is a negative one: **a signed link confers no
authority.** It names a destination and proves the platform issued it. Following one
still requires signing in, and the action at the far end is authorised against that
session like any other. The link saves the recipient from hunting through a register
for the record somebody is chasing them about; it does not stand in for them.

That is not timidity. The master prompt is explicit that email replies cannot
approve internal financial actions, and a link that signed off an invoice on
possession alone would be exactly that with extra steps. Email is forwarded,
archived, quoted into ticketing systems, and synchronised to devices nobody
inventoried. Anything that treats holding a URL as proof of identity has made the
mailbox the authentication system.

What the signature and the stored row buy, then:

*Non-enumerability.* The token is 32 random bytes, so the link cannot be guessed
towards another invoice the way a sequential identifier could be.

*Revocability and expiry.* Facts about a link that a self-contained signed token
cannot carry, because nothing consults it. A row can be expired, spent and revoked.

*Single use.* The second use of a link is far more likely to be somebody who should
not have it than the intended recipient clicking twice, and by then the intended
recipient has the record open anyway.

*Attribution.* The link records who it was issued to and refuses anybody else. A
colleague who was forwarded it may well be entitled to see the invoice; they are
not entitled to see it *as the answer to somebody else's chaser*, and the
distinction is what keeps the sign-off trail honest about who was asked.

The token is stored only as a SHA-256 digest, exactly as a password would be. A
read of the database cannot be turned back into a working link.

## Links to somebody with no account

A supplier being asked whether our payment reached them has no session to check
anything against, so the rule above cannot be applied to them as written. Rather
than weaken it, the far end changes: the page a supplier's link opens records
their claim and can move nothing. Marking an invoice paid remains an act by a
named person inside the organisation, who can read the claim and is not bound by
it.

Stated as an invariant: *a link never carries authority, and where there is no
session behind it there is nothing at the far end that would need any.* Both
kinds of link are the same row, so expiry, revocation, single use and the audit
of every refusal are one implementation rather than two, one of which would
eventually be the weaker. See
[ADR 9](../../../../docs/adr/0009-a-vendor-link-records-a-claim.md).
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from urllib.parse import quote
from uuid import UUID

import structlog
from sqlalchemy import select
from sqlalchemy.orm import Session

from finora.domain.audit import ActorType, AuditAction
from finora.domain.reminders import ReminderPurpose
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import SignedLink, User

logger = structlog.get_logger(__name__)

#: 32 bytes of randomness, URL-safe. Long enough that guessing is not a strategy.
_TOKEN_BYTES = 32

#: Where a supplier's link lands. A path of its own rather than the internal
#: one, so the route that must never require a session is separable in the
#: router, in the reverse proxy and in a log.
VENDOR_LINK_PATH = "/payment-check-in"

#: Stands in for the subject of a refusal that names no record, because the audit
#: trail wants a UUID and an unknown token has nothing else to offer. The nil
#: UUID rather than a random one, so these group together instead of producing a
#: distinct subject per attempt.
_UNKNOWN_SUBJECT = UUID(int=0)


class LinkRefusal(StrEnum):
    """Why a presented link did not open anything.

    The caller is told only that the link is not usable; which of these it was is
    recorded but not disclosed. Telling a holder that a token was *valid but
    expired* confirms the token existed, which is a small oracle and an unnecessary
    one.
    """

    unknown = "unknown"
    expired = "expired"
    already_used = "already_used"
    revoked = "revoked"
    wrong_recipient = "wrong_recipient"


REFUSAL_REASONS: dict[LinkRefusal, str] = {
    LinkRefusal.unknown: "No such link.",
    LinkRefusal.expired: "The link has expired.",
    LinkRefusal.already_used: "The link has already been used.",
    LinkRefusal.revoked: "The link was withdrawn.",
    LinkRefusal.wrong_recipient: "The link was issued to somebody else.",
}

#: What the recipient is told, regardless of which refusal it was. One message, so
#: the response cannot be used to probe which tokens exist.
REFUSAL_MESSAGE = (
    "This link is no longer usable. It may have expired, or already been used. "
    "Open the invoice from your work queue instead; everything you need is there."
)

#: The same, for a supplier, who has no work queue to be sent to and no way to
#: reach the platform except by replying to the email. Says exactly as little
#: about which refusal it was.
VENDOR_REFUSAL_MESSAGE = (
    "This link is no longer usable. It may have expired, or the answer may "
    "already have been recorded. Replying to the email we sent you will reach "
    "the right people."
)


@dataclass(frozen=True, slots=True)
class IssuedLink:
    """A freshly minted link. The only moment the secret exists in memory."""

    record_id: UUID
    purpose: ReminderPurpose
    #: The full URL to put in an email. Never stored, never logged.
    url: str
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class ResolvedLink:
    """A link that checked out, and the record it points at."""

    record_type: str
    record_id: UUID
    purpose: ReminderPurpose
    #: Never null on a link resolved this way. `resolve` refuses any link whose
    #: recipient is not the signed-in user, and a link issued to a supplier has
    #: no user to match, so it is refused here and answered on its own path.
    issued_to_id: UUID


@dataclass(frozen=True, slots=True)
class ResolvedVendorLink:
    """A supplier's link that checked out.

    Deliberately not a `ResolvedLink`. That type promises a signed-in recipient,
    and a caller that could receive either would sooner or later treat one as the
    other. Two types means the compiler notices instead of a reviewer.
    """

    record_type: str
    record_id: UUID
    purpose: ReminderPurpose
    issued_to_vendor_id: UUID


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class SignedLinkService:
    def __init__(
        self,
        *,
        session: Session,
        audit: AuditRepository,
        web_base_url: str,
        ttl_hours: int = 72,
        vendor_ttl_hours: int = 720,
    ) -> None:
        self._session = session
        self._audit = audit
        self._base = web_base_url.rstrip("/")
        self._ttl = timedelta(hours=ttl_hours)
        # A month rather than three days. A colleague is being chased about work
        # they owe and is in the building; a supplier is doing us a favour, may
        # be a small business with one person handling the post, and is being
        # asked about a payment that itself takes days to clear. A link that dies
        # over their fortnight of leave costs a phone call and a re-send, and
        # the risk it buys back is small because the page it opens takes no
        # action.
        self._vendor_ttl = timedelta(hours=vendor_ttl_hours)

    def issue(
        self,
        *,
        record_type: str,
        record_id: UUID,
        purpose: ReminderPurpose,
        issued_to: User,
        correlation_id: UUID | None = None,
    ) -> IssuedLink:
        """Mint a link for one person to reach one record.

        Any live link for the same record, purpose and person is revoked first. A
        reminder supersedes the request it is chasing, and leaving the earlier link
        working would mean every reminder widened the window rather than moving it.
        """
        self._revoke_live(
            record_type=record_type,
            record_id=record_id,
            purpose=purpose,
            issued_to_id=issued_to.id,
        )

        token = secrets.token_urlsafe(_TOKEN_BYTES)
        expires_at = datetime.now(UTC) + self._ttl

        self._session.add(
            SignedLink(
                token_sha256=_digest(token),
                record_type=record_type,
                record_id=record_id,
                purpose=purpose,
                issued_to_id=issued_to.id,
                expires_at=expires_at,
            )
        )
        self._session.flush()

        self._audit.append(
            action=AuditAction.link_issued,
            actor_type=ActorType.service,
            actor_id=None,
            actor_label="link service",
            subject_type=record_type,
            subject_id=record_id,
            correlation_id=correlation_id,
            detail={
                "purpose": str(purpose),
                "issued_to": str(issued_to.id),
                "expires_at": expires_at.isoformat(),
            },
        )

        return IssuedLink(
            record_id=record_id,
            purpose=purpose,
            url=f"{self._base}/link/{quote(token, safe='')}",
            expires_at=expires_at,
        )

    def resolve(
        self,
        token: str,
        *,
        presented_by: User,
        correlation_id: UUID | None = None,
        spend: bool = True,
    ) -> ResolvedLink | LinkRefusal:
        """Check a presented token and, if it is good, spend it.

        `presented_by` is the signed-in user, which is the point: the token got
        them to this endpoint but their session is what says who they are. A token
        with no session behind it never reaches here.
        """
        link = self._lookup(token)
        if link is None:
            self._record_refusal(
                LinkRefusal.unknown,
                record_type=None,
                record_id=None,
                presented_by=presented_by,
                correlation_id=correlation_id,
            )
            return LinkRefusal.unknown

        refusal = self._check(link, presented_by=presented_by)
        if refusal is not None:
            self._record_refusal(
                refusal,
                record_type=link.record_type,
                record_id=link.record_id,
                presented_by=presented_by,
                correlation_id=correlation_id,
            )
            return refusal

        if spend:
            link.used_at = datetime.now(UTC)
            self._session.flush()

        self._audit.append(
            action=AuditAction.link_followed,
            actor_type=ActorType.user,
            actor_id=presented_by.id,
            actor_label=presented_by.display_name,
            subject_type=link.record_type,
            subject_id=link.record_id,
            correlation_id=correlation_id,
            detail={"purpose": str(link.purpose), "spent": spend},
        )

        return ResolvedLink(
            record_type=link.record_type,
            record_id=link.record_id,
            purpose=link.purpose,
            # Equal to `link.issued_to_id`, which `_check` has already insisted
            # on. Taken from the session because that is the value the type can
            # be sure of.
            issued_to_id=presented_by.id,
        )

    def issue_to_vendor(
        self,
        *,
        record_type: str,
        record_id: UUID,
        purpose: ReminderPurpose,
        vendor_id: UUID,
        vendor_label: str,
        correlation_id: UUID | None = None,
    ) -> IssuedLink:
        """Mint a link for a supplier, who has no account here.

        Identical to `issue` in everything the row does — random token, stored as
        a digest, expiring, revocable, single use — and different in one respect
        that is not visible from here: the destination is a page that records a
        claim rather than one that takes an action. That is what makes issuing a
        link to somebody with no session acceptable at all.
        """
        self._revoke_live_for_vendor(
            record_type=record_type,
            record_id=record_id,
            purpose=purpose,
            vendor_id=vendor_id,
        )

        token = secrets.token_urlsafe(_TOKEN_BYTES)
        expires_at = datetime.now(UTC) + self._vendor_ttl

        self._session.add(
            SignedLink(
                token_sha256=_digest(token),
                record_type=record_type,
                record_id=record_id,
                purpose=purpose,
                issued_to_vendor_id=vendor_id,
                expires_at=expires_at,
            )
        )
        self._session.flush()

        self._audit.append(
            action=AuditAction.link_issued,
            actor_type=ActorType.service,
            actor_id=None,
            actor_label="link service",
            subject_type=record_type,
            subject_id=record_id,
            correlation_id=correlation_id,
            detail={
                "purpose": str(purpose),
                "issued_to_vendor": str(vendor_id),
                "vendor_label": vendor_label,
                "expires_at": expires_at.isoformat(),
            },
        )

        return IssuedLink(
            record_id=record_id,
            purpose=purpose,
            url=f"{self._base}{VENDOR_LINK_PATH}/{quote(token, safe='')}",
            expires_at=expires_at,
        )

    def resolve_for_vendor(
        self,
        token: str,
        *,
        correlation_id: UUID | None = None,
        spend: bool = False,
    ) -> ResolvedVendorLink | LinkRefusal:
        """Check a supplier's token with no session behind it.

        `spend` defaults to false, the opposite of the internal path, and the
        difference matters. A colleague follows their link and is looking at the
        record a second later; a supplier opens theirs, reads it, goes to check
        their bank, and comes back. Spending the token on the first page view
        would burn it before they had answered, and the platform would have
        taught them that its links do not work.

        So the token is spent when the answer is recorded, not when the page is
        opened. The window that leaves is bounded by the expiry, and the thing at
        the end of it records a claim rather than authorising anything.
        """
        link = self._lookup(token)
        if link is None:
            self._record_vendor_refusal(
                LinkRefusal.unknown,
                record_type=None,
                record_id=None,
                vendor_id=None,
                correlation_id=correlation_id,
            )
            return LinkRefusal.unknown

        refusal = self._check_vendor(link)
        if refusal is not None:
            self._record_vendor_refusal(
                refusal,
                record_type=link.record_type,
                record_id=link.record_id,
                vendor_id=link.issued_to_vendor_id,
                correlation_id=correlation_id,
            )
            return refusal

        # Narrowed by `_check_vendor`, which refuses a link with no supplier on
        # it before we get here.
        vendor_id = link.issued_to_vendor_id
        assert vendor_id is not None  # noqa: S101  narrowing, guarded above

        if spend:
            link.used_at = datetime.now(UTC)
            self._session.flush()

        self._audit.append(
            action=AuditAction.link_followed,
            actor_type=ActorType.external_vendor,
            actor_id=None,
            actor_label=str(vendor_id),
            subject_type=link.record_type,
            subject_id=link.record_id,
            correlation_id=correlation_id,
            detail={"purpose": str(link.purpose), "spent": spend},
        )

        return ResolvedVendorLink(
            record_type=link.record_type,
            record_id=link.record_id,
            purpose=link.purpose,
            issued_to_vendor_id=vendor_id,
        )

    def revoke_for_record(
        self,
        *,
        record_type: str,
        record_id: UUID,
        purpose: ReminderPurpose,
    ) -> int:
        """Withdraw every live link for a record, once it no longer needs one.

        Called when an invoice is signed off or moves on. A link that still opens
        a sign-off screen for a record that has already been signed off is at best
        confusing and at worst a way to record a second one.
        """
        return self._revoke_live(
            record_type=record_type, record_id=record_id, purpose=purpose, issued_to_id=None
        )

    def _lookup(self, token: str) -> SignedLink | None:
        """Find the row for a token, comparing digests in constant time.

        The database lookup is by digest, which is already a constant-time-ish
        equality on a hash rather than on the secret. The explicit `compare_digest`
        below guards the case where a lookup somehow returned a near-match, and
        costs nothing.
        """
        candidate = _digest(token)
        link = self._session.execute(
            select(SignedLink).where(SignedLink.token_sha256 == candidate)
        ).scalar_one_or_none()
        if link is None:
            return None
        if not hmac.compare_digest(link.token_sha256, candidate):
            return None
        return link

    @staticmethod
    def _check(link: SignedLink, *, presented_by: User) -> LinkRefusal | None:
        """Every reason to refuse, in order of what matters most."""
        if link.revoked_at is not None:
            return LinkRefusal.revoked
        if link.used_at is not None:
            return LinkRefusal.already_used
        if link.expires_at <= datetime.now(UTC):
            return LinkRefusal.expired
        # A link issued to a supplier has no user on it, so this refuses it as
        # the wrong recipient without a special case: nobody's session matches
        # nobody, and the supplier's own path is elsewhere.
        if link.issued_to_id is None or link.issued_to_id != presented_by.id:
            return LinkRefusal.wrong_recipient
        return None

    @staticmethod
    def _check_vendor(link: SignedLink) -> LinkRefusal | None:
        """The same refusals, minus the one that needs a session.

        There is no recipient check here and there cannot be: the holder of the
        link is whoever opened it, and the platform has no way to tell whether
        that is the supplier, their colleague, or somebody who was forwarded the
        email. A link issued to a *user* is refused outright, so an internal link
        cannot be redeemed down the unauthenticated path.
        """
        if link.issued_to_vendor_id is None:
            return LinkRefusal.wrong_recipient
        if link.revoked_at is not None:
            return LinkRefusal.revoked
        if link.used_at is not None:
            return LinkRefusal.already_used
        if link.expires_at <= datetime.now(UTC):
            return LinkRefusal.expired
        return None

    def _revoke_live(
        self,
        *,
        record_type: str,
        record_id: UUID,
        purpose: ReminderPurpose,
        issued_to_id: UUID | None,
    ) -> int:
        conditions = [
            SignedLink.record_type == record_type,
            SignedLink.record_id == record_id,
            SignedLink.purpose == purpose,
            SignedLink.used_at.is_(None),
            SignedLink.revoked_at.is_(None),
        ]
        if issued_to_id is not None:
            conditions.append(SignedLink.issued_to_id == issued_to_id)

        live = list(self._session.execute(select(SignedLink).where(*conditions)).scalars().all())
        return self._revoke(live)

    def _revoke_live_for_vendor(
        self,
        *,
        record_type: str,
        record_id: UUID,
        purpose: ReminderPurpose,
        vendor_id: UUID,
    ) -> int:
        """Withdraw a supplier's earlier link before issuing the next one.

        A chaser supersedes the request it is chasing. Leaving the previous link
        working would mean every follow-up widened the window rather than moving
        it, and after three chasers a supplier would be holding four live ways
        into the same page.
        """
        live = list(
            self._session.execute(
                select(SignedLink).where(
                    SignedLink.record_type == record_type,
                    SignedLink.record_id == record_id,
                    SignedLink.purpose == purpose,
                    SignedLink.issued_to_vendor_id == vendor_id,
                    SignedLink.used_at.is_(None),
                    SignedLink.revoked_at.is_(None),
                )
            )
            .scalars()
            .all()
        )
        return self._revoke(live)

    def _revoke(self, live: list[SignedLink]) -> int:
        now = datetime.now(UTC)
        for link in live:
            link.revoked_at = now
        if live:
            self._session.flush()
        return len(live)

    def _record_refusal(
        self,
        refusal: LinkRefusal,
        *,
        record_type: str | None,
        record_id: UUID | None,
        presented_by: User,
        correlation_id: UUID | None,
    ) -> None:
        """Note a link that did not open.

        Recorded even for an unknown token, with no record to attach it to. A run
        of these from one account is what an attempt to guess or replay a link
        looks like from the inside, and it is invisible unless the misses are
        written down as well as the hits.
        """
        self._audit.append(
            action=AuditAction.link_refused,
            actor_type=ActorType.user,
            actor_id=presented_by.id,
            actor_label=presented_by.display_name,
            subject_type=record_type or "signed_link",
            subject_id=record_id or presented_by.id,
            correlation_id=correlation_id,
            detail={"refusal": str(refusal)},
        )
        logger.warning(
            "signed_link.refused",
            refusal=str(refusal),
            user_id=str(presented_by.id),
            record_id=str(record_id) if record_id else None,
        )

    def _record_vendor_refusal(
        self,
        refusal: LinkRefusal,
        *,
        record_type: str | None,
        record_id: UUID | None,
        vendor_id: UUID | None,
        correlation_id: UUID | None,
    ) -> None:
        """Note a supplier's link that did not open.

        Recorded more carefully than the internal equivalent rather than less.
        There is no account behind these, so a run of misses is the only signal
        that somebody is working through tokens, and it is the only page on the
        platform an unauthenticated stranger can reach at all.
        """
        self._audit.append(
            action=AuditAction.link_refused,
            actor_type=ActorType.external_vendor,
            actor_id=None,
            actor_label=str(vendor_id) if vendor_id else "unknown",
            subject_type=record_type or "signed_link",
            subject_id=record_id or _UNKNOWN_SUBJECT,
            correlation_id=correlation_id,
            detail={"refusal": str(refusal), "audience": "vendor"},
        )
        logger.warning(
            "signed_link.vendor_refused",
            refusal=str(refusal),
            record_id=str(record_id) if record_id else None,
        )

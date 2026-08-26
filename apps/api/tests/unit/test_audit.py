"""The audit chain must make tampering detectable, and must not leak secrets."""

from __future__ import annotations

import dataclasses
import itertools
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest

from finora.domain.audit import (
    GENESIS_HASH,
    ActorType,
    AuditAction,
    build_entry,
    redact,
    verify_chain,
)


def _chain(length: int = 5) -> list:
    entries = []
    previous = GENESIS_HASH
    base = datetime(2026, 8, 4, 12, 0, tzinfo=UTC)
    for i in range(1, length + 1):
        entry = build_entry(
            sequence=i,
            previous_hash=previous,
            action=AuditAction.state_changed,
            actor_type=ActorType.user,
            actor_id=uuid4(),
            actor_label=f"User {i}",
            subject_type="invoice",
            subject_id=uuid4(),
            detail={"step": i},
            occurred_at=base + timedelta(minutes=i),
        )
        entries.append(entry)
        previous = entry.entry_hash
    return entries


class TestChainConstruction:
    def test_first_entry_links_to_genesis(self) -> None:
        assert _chain(1)[0].previous_hash == GENESIS_HASH

    def test_each_entry_links_to_its_predecessor(self) -> None:
        entries = _chain(4)
        for earlier, later in itertools.pairwise(entries):
            assert later.previous_hash == earlier.entry_hash

    def test_entries_are_self_consistent(self) -> None:
        assert all(e.is_self_consistent for e in _chain(4))

    def test_sequence_must_start_at_one(self) -> None:
        with pytest.raises(ValueError, match="sequence starts at 1"):
            build_entry(
                sequence=0,
                previous_hash=GENESIS_HASH,
                action=AuditAction.sign_in,
                actor_type=ActorType.user,
                actor_label="x",
                subject_type="session",
            )

    def test_naive_timestamp_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="timezone aware"):
            build_entry(
                sequence=1,
                previous_hash=GENESIS_HASH,
                action=AuditAction.sign_in,
                actor_type=ActorType.user,
                actor_label="x",
                subject_type="session",
                occurred_at=datetime(2026, 8, 4, 12, 0),  # noqa: DTZ001
            )

    def test_hash_is_deterministic_regardless_of_detail_key_order(self) -> None:
        when = datetime(2026, 8, 4, 12, 0, tzinfo=UTC)
        common = {
            "sequence": 1,
            "previous_hash": GENESIS_HASH,
            "action": AuditAction.record_created,
            "actor_type": ActorType.user,
            "actor_label": "Alex",
            "subject_type": "invoice",
            "occurred_at": when,
        }
        first = build_entry(**common, detail={"a": 1, "b": 2})
        second = build_entry(**common, detail={"b": 2, "a": 1})
        assert first.entry_hash == second.entry_hash


class TestTamperDetection:
    def test_intact_chain_verifies(self) -> None:
        result = verify_chain(_chain(6))
        assert result.is_intact
        assert result.entries_checked == 6
        assert "intact across 6" in result.summary

    def test_empty_chain_is_intact(self) -> None:
        assert verify_chain([]).is_intact

    def test_modified_detail_is_detected(self) -> None:
        entries = _chain(5)
        entries[2] = dataclasses.replace(entries[2], detail={"step": 999})
        result = verify_chain(entries)
        assert not result.is_intact
        assert result.first_broken_sequence == 3
        assert "does not match its recorded hash" in result.summary

    def test_modified_actor_is_detected(self) -> None:
        entries = _chain(4)
        entries[1] = dataclasses.replace(entries[1], actor_label="Someone Else")
        assert not verify_chain(entries).is_intact

    def test_removed_entry_is_detected(self) -> None:
        entries = _chain(5)
        del entries[2]
        result = verify_chain(entries)
        assert not result.is_intact
        assert "missing or out of order" in result.summary

    def test_reordered_entries_are_detected(self) -> None:
        entries = _chain(5)
        entries[1], entries[3] = entries[3], entries[1]
        assert not verify_chain(entries).is_intact

    def test_relinked_entry_still_fails_on_content_hash(self) -> None:
        """Re-pointing previous_hash is not enough to hide an edit, because the
        entry's own hash still commits to its content."""
        entries = _chain(4)
        tampered = dataclasses.replace(entries[2], detail={"step": "edited"})
        entries[2] = tampered
        entries[3] = dataclasses.replace(entries[3], previous_hash=tampered.entry_hash)
        assert not verify_chain(entries).is_intact

    def test_partial_range_starting_mid_chain_is_allowed(self) -> None:
        """Auditors page through history, so a slice must verify on its own."""
        assert verify_chain(_chain(6)[2:]).is_intact

    def test_forged_first_entry_cannot_claim_sequence_one(self) -> None:
        entries = _chain(3)
        entries[0] = dataclasses.replace(entries[0], previous_hash="f" * 64)
        result = verify_chain(entries)
        assert not result.is_intact
        assert "genesis" in result.summary


class TestRedaction:
    def test_password_is_removed(self) -> None:
        assert redact({"password": "hunter2"})["password"] == "[redacted]"

    def test_matching_is_case_insensitive_and_partial(self) -> None:
        result = redact({"Client_Secret": "abc", "API_KEY": "def"})
        assert result["Client_Secret"] == "[redacted]"
        assert result["API_KEY"] == "[redacted]"

    def test_nested_values_are_removed(self) -> None:
        result = redact({"imap": {"host": "mail.example.com", "password": "x"}})
        assert result["imap"]["password"] == "[redacted]"
        assert result["imap"]["host"] == "mail.example.com"

    def test_values_inside_lists_are_removed(self) -> None:
        result = redact({"accounts": [{"user": "a", "token": "t"}]})
        assert result["accounts"][0]["token"] == "[redacted]"
        assert result["accounts"][0]["user"] == "a"

    def test_raw_message_body_is_not_recorded(self) -> None:
        assert redact({"raw_body": "..."})["raw_body"] == "[redacted]"

    def test_ordinary_business_values_are_preserved(self) -> None:
        detail = {"invoice_number": "INV-10056", "amount_minor_units": 1250000}
        assert redact(detail) == detail

    def test_built_entry_stores_redacted_detail(self) -> None:
        entry = build_entry(
            sequence=1,
            previous_hash=GENESIS_HASH,
            action=AuditAction.configuration_changed,
            actor_type=ActorType.user,
            actor_label="Admin",
            subject_type="imap_config",
            detail={"host": "mail.example.com", "password": "leaked"},
        )
        assert entry.detail["password"] == "[redacted]"
        assert entry.is_self_consistent


class TestActorTypes:
    def test_ai_actor_is_distinguishable(self) -> None:
        """A suggestion must never read back as a human decision."""
        entry = build_entry(
            sequence=1,
            previous_hash=GENESIS_HASH,
            action=AuditAction.ai_suggestion_produced,
            actor_type=ActorType.ai,
            actor_label="extraction model qwen2.5vl:7b",
            subject_type="invoice",
            detail={"confidence": 0.62},
        )
        assert entry.actor_type is ActorType.ai
        assert entry.actor_id is None

"""Intake treats everything it receives as attacker-controlled.

These tests exist to stop a later change from quietly widening what the platform
will accept or store.
"""

from __future__ import annotations

import pytest

from finora.domain.intake import (
    ALLOWED_CONTENT_TYPES,
    CANONICAL_EXTENSIONS,
    RELEASABLE_VERDICTS,
    TERMINAL_INTAKE_STATUSES,
    AttachmentLimits,
    AttachmentRejectedError,
    CheckpointResetReason,
    IntakeRejection,
    IntakeStatus,
    MailboxCheckpoint,
    MessageIdentity,
    ScanVerdict,
    content_type_matches_bytes,
    next_uid_range,
    safe_filename,
    sha256_hex,
    sniff_content_type,
    validate_attachment,
)

PDF = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\ntrailer<</Root 1 0 R>>"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 32
XLSX = b"PK\x03\x04" + b"\x00" * 32
ELF = b"\x7fELF\x02\x01\x01\x00" + b"\x00" * 32
MZ = b"MZ\x90\x00" + b"\x00" * 32

LIMITS = AttachmentLimits(
    max_bytes=1024,
    max_archive_entries=100,
    max_archive_expansion_ratio=50,
)


class TestScanVerdicts:
    def test_only_a_clean_verdict_releases_a_file(self) -> None:
        assert RELEASABLE_VERDICTS == {ScanVerdict.clean}

    def test_an_unreachable_scanner_is_not_a_clean_result(self) -> None:
        assert ScanVerdict.error not in RELEASABLE_VERDICTS

    def test_an_unscannable_file_is_not_a_clean_result(self) -> None:
        # An encrypted archive is the classic delivery vehicle. Treating "could
        # not look inside" as "nothing wrong inside" is how it succeeds.
        assert ScanVerdict.unscannable not in RELEASABLE_VERDICTS


class TestIntakeStatus:
    def test_ready_is_reachable_and_terminal(self) -> None:
        assert IntakeStatus.ready in TERMINAL_INTAKE_STATUSES

    def test_in_flight_states_are_not_terminal(self) -> None:
        assert IntakeStatus.received not in TERMINAL_INTAKE_STATUSES
        assert IntakeStatus.scanning not in TERMINAL_INTAKE_STATUSES


class TestContentTypeAllowList:
    def test_no_executable_or_script_type_is_accepted(self) -> None:
        for forbidden in (
            "application/x-msdownload",
            "application/x-dosexec",
            "application/x-sh",
            "application/javascript",
            "text/html",
            "application/x-msi",
            "application/vnd.ms-excel.sheet.macroEnabled.12",
        ):
            assert forbidden not in ALLOWED_CONTENT_TYPES

    def test_every_allowed_type_has_a_canonical_extension(self) -> None:
        # A stored file with no known extension cannot be handed to a viewer or
        # an export without guessing.
        assert set(ALLOWED_CONTENT_TYPES) == set(CANONICAL_EXTENSIONS)


class TestSniffing:
    @pytest.mark.parametrize(
        ("data", "expected"),
        [
            (PDF, "application/pdf"),
            (PNG, "image/png"),
            (JPEG, "image/jpeg"),
        ],
    )
    def test_recognises_known_signatures(self, data: bytes, expected: str) -> None:
        assert sniff_content_type(data) == expected

    def test_returns_nothing_for_an_unrecognised_signature(self) -> None:
        assert sniff_content_type(ELF) is None
        assert sniff_content_type(b"") is None


class TestContentTypeMatching:
    def test_accepts_bytes_that_match_the_declaration(self) -> None:
        assert content_type_matches_bytes("application/pdf", PDF)
        assert content_type_matches_bytes("image/png", PNG)

    def test_rejects_a_declaration_that_contradicts_the_bytes(self) -> None:
        assert not content_type_matches_bytes("application/pdf", PNG)
        assert not content_type_matches_bytes("image/png", PDF)

    def test_rejects_an_executable_dressed_as_a_document(self) -> None:
        assert not content_type_matches_bytes("application/pdf", MZ)
        assert not content_type_matches_bytes("application/pdf", ELF)

    def test_allows_one_signature_shared_by_several_office_types(self) -> None:
        docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        assert content_type_matches_bytes(docx, XLSX)
        assert content_type_matches_bytes(xlsx, XLSX)

    def test_permits_types_that_have_no_signature_to_check(self) -> None:
        assert content_type_matches_bytes("text/csv", b"vendor,amount\nAcme,100\n")
        assert content_type_matches_bytes("text/plain", b"anything at all")


class TestSafeFilename:
    @pytest.mark.parametrize(
        "hostile",
        [
            "../../../etc/passwd",
            "..\\..\\windows\\system32\\config",
            "/absolute/path/invoice.pdf",
            "C:\\Users\\finance\\invoice.pdf",
        ],
    )
    def test_strips_every_path_component(self, hostile: str) -> None:
        result = safe_filename(hostile)
        assert "/" not in result
        assert "\\" not in result
        assert ".." not in result

    def test_removes_control_characters_including_null(self) -> None:
        result = safe_filename("invoice\x00\x1f\n.pdf")
        assert "\x00" not in result
        assert "\n" not in result

    @pytest.mark.parametrize(
        "invisible",
        ["\u202e", "\u200b", "\u2066", "\ufeff", "\u200f", "\u2060"],
    )
    def test_strips_invisible_and_bidi_characters(self, invisible: str) -> None:
        # "invoice\u202Efdp.exe" renders to a human as "invoice exe.pdf".
        result = safe_filename(f"invoice{invisible}fdp.exe", content_type="application/pdf")
        assert result.endswith(".pdf")
        assert invisible not in result

    def test_extension_comes_from_the_verified_type_not_the_sender(self) -> None:
        assert (
            safe_filename("totally_a_document.exe", content_type="application/pdf")
            == "totally_a_document.pdf"
        )

    def test_renames_windows_reserved_names(self) -> None:
        assert safe_filename("CON.pdf").lower().startswith("con_file")
        assert safe_filename("lpt1.pdf").lower().startswith("lpt1_file")

    def test_caps_the_length(self) -> None:
        result = safe_filename("a" * 500 + ".pdf", content_type="application/pdf")
        assert len(result) <= 130
        assert result.endswith(".pdf")

    def test_always_produces_a_usable_name(self) -> None:
        for empty in ("", "   ", "...", "/", "\\"):
            assert safe_filename(empty)

    def test_keeps_an_ordinary_name_readable(self) -> None:
        assert (
            safe_filename("Invoice 4471 - Acme Ltd.pdf", content_type="application/pdf")
            == "Invoice 4471 - Acme Ltd.pdf"
        )


class TestValidateAttachment:
    def test_accepts_a_well_formed_pdf(self) -> None:
        result = validate_attachment(
            filename="invoice.pdf",
            declared_content_type="application/pdf",
            data=PDF,
            limits=LIMITS,
        )
        assert result.content_type == "application/pdf"
        assert result.size_bytes == len(PDF)
        assert result.sha256 == sha256_hex(PDF)

    def test_preserves_the_original_filename_for_the_audit_trail(self) -> None:
        result = validate_attachment(
            filename="../../invoice.pdf",
            declared_content_type="application/pdf",
            data=PDF,
            limits=LIMITS,
        )
        assert result.original_filename == "../../invoice.pdf"
        assert "/" not in result.filename

    def test_refuses_an_empty_file(self) -> None:
        with pytest.raises(AttachmentRejectedError) as caught:
            validate_attachment(
                filename="invoice.pdf",
                declared_content_type="application/pdf",
                data=b"",
                limits=LIMITS,
            )
        assert caught.value.reason is IntakeRejection.empty_file

    def test_refuses_a_file_above_the_size_limit(self) -> None:
        with pytest.raises(AttachmentRejectedError) as caught:
            validate_attachment(
                filename="invoice.pdf",
                declared_content_type="application/pdf",
                data=PDF + b"\x00" * 2048,
                limits=LIMITS,
            )
        assert caught.value.reason is IntakeRejection.too_large

    def test_refuses_a_disallowed_type(self) -> None:
        with pytest.raises(AttachmentRejectedError) as caught:
            validate_attachment(
                filename="setup.exe",
                declared_content_type="application/x-msdownload",
                data=MZ,
                limits=LIMITS,
            )
        assert caught.value.reason is IntakeRejection.disallowed_type

    def test_refuses_an_executable_renamed_as_a_pdf(self) -> None:
        # The declared type is on the allow-list, so this is caught by the
        # byte-signature check rather than by the allow-list.
        with pytest.raises(AttachmentRejectedError) as caught:
            validate_attachment(
                filename="invoice.pdf",
                declared_content_type="application/pdf",
                data=MZ,
                limits=LIMITS,
            )
        assert caught.value.reason is IntakeRejection.content_type_mismatch

    def test_trusts_the_bytes_when_a_client_declares_a_vague_type(self) -> None:
        # Some clients send everything as application/octet-stream. The bytes are
        # a real PDF, so the file is accepted under its true type.
        result = validate_attachment(
            filename="invoice.pdf",
            declared_content_type="application/octet-stream",
            data=PDF,
            limits=LIMITS,
        )
        assert result.content_type == "application/pdf"

    def test_ignores_content_type_parameters(self) -> None:
        result = validate_attachment(
            filename="notes.txt",
            declared_content_type="text/plain; charset=utf-8",
            data=b"hello",
            limits=LIMITS,
        )
        assert result.content_type == "text/plain"

    def test_a_missing_content_type_is_resolved_from_the_bytes(self) -> None:
        result = validate_attachment(
            filename="invoice.pdf",
            declared_content_type=None,
            data=PDF,
            limits=LIMITS,
        )
        assert result.content_type == "application/pdf"

    def test_every_refusal_explains_what_to_do_next(self) -> None:
        cases: list[tuple[str, str | None, bytes]] = [
            ("a.pdf", "application/pdf", b""),
            ("a.pdf", "application/pdf", PDF + b"\x00" * 2048),
            ("a.exe", "application/x-msdownload", MZ),
        ]
        for filename, declared, data in cases:
            with pytest.raises(AttachmentRejectedError) as caught:
                validate_attachment(
                    filename=filename,
                    declared_content_type=declared,
                    data=data,
                    limits=LIMITS,
                )
            message = str(caught.value)
            assert message.endswith("."), message
            assert len(message) > 30, message


class TestMessageIdentity:
    def test_two_forwards_of_one_message_share_an_identity(self) -> None:
        first = MessageIdentity(message_id="<abc@vendor.example>", raw_sha256="a" * 64)
        second = MessageIdentity(message_id="<abc@vendor.example>", raw_sha256="b" * 64)
        assert first.idempotency_key == second.idempotency_key

    def test_message_id_comparison_ignores_case_and_brackets(self) -> None:
        bare = MessageIdentity(message_id="ABC@Vendor.Example", raw_sha256="a" * 64)
        wrapped = MessageIdentity(message_id="<abc@vendor.example>", raw_sha256="a" * 64)
        assert bare.idempotency_key == wrapped.idempotency_key

    def test_falls_back_to_the_raw_hash_when_there_is_no_message_id(self) -> None:
        identity = MessageIdentity(message_id=None, raw_sha256="c" * 64)
        assert identity.idempotency_key == f"raw:{'c' * 64}"

    def test_an_empty_message_id_is_treated_as_absent(self) -> None:
        identity = MessageIdentity(message_id="", raw_sha256="d" * 64)
        assert identity.idempotency_key.startswith("raw:")

    def test_different_messages_do_not_collide(self) -> None:
        first = MessageIdentity(message_id=None, raw_sha256="e" * 64)
        second = MessageIdentity(message_id=None, raw_sha256="f" * 64)
        assert first.idempotency_key != second.idempotency_key


class TestMailboxCheckpoint:
    def test_advances_only_forwards(self) -> None:
        checkpoint = MailboxCheckpoint(folder="INBOX", uid_validity=7, last_seen_uid=10)
        assert checkpoint.advance(11).last_seen_uid == 11

    def test_refuses_to_move_backwards(self) -> None:
        checkpoint = MailboxCheckpoint(folder="INBOX", uid_validity=7, last_seen_uid=10)
        with pytest.raises(ValueError, match="not ahead"):
            checkpoint.advance(10)
        with pytest.raises(ValueError, match="not ahead"):
            checkpoint.advance(3)

    def test_rejects_a_checkpoint_from_a_different_uidvalidity(self) -> None:
        checkpoint = MailboxCheckpoint(folder="INBOX", uid_validity=7, last_seen_uid=10)
        assert checkpoint.accepts(uid_validity=7)
        assert not checkpoint.accepts(uid_validity=8)


class TestNextUidRange:
    def test_a_fresh_mailbox_is_read_from_the_beginning(self) -> None:
        assert next_uid_range(None, uid_validity=1, batch_size=25) == ("1:*", None)

    def test_resumes_immediately_after_the_last_seen_uid(self) -> None:
        checkpoint = MailboxCheckpoint(folder="INBOX", uid_validity=4, last_seen_uid=42)
        uid_range, reset = next_uid_range(checkpoint, uid_validity=4, batch_size=25)
        assert uid_range == "43:*"
        assert reset is None

    def test_a_changed_uidvalidity_forces_a_full_rescan(self) -> None:
        # Every stored UID now refers to a different message. Resuming from the
        # old UID would skip real mail while reporting success.
        checkpoint = MailboxCheckpoint(folder="INBOX", uid_validity=4, last_seen_uid=42)
        uid_range, reset = next_uid_range(checkpoint, uid_validity=9, batch_size=25)
        assert uid_range == "1:*"
        assert reset is CheckpointResetReason.uidvalidity_changed

    def test_the_range_is_open_ended_so_new_mail_is_never_missed(self) -> None:
        checkpoint = MailboxCheckpoint(folder="INBOX", uid_validity=4, last_seen_uid=42)
        uid_range, _ = next_uid_range(checkpoint, uid_validity=4, batch_size=1)
        assert uid_range.endswith(":*")

    def test_rejects_a_nonsensical_batch_size(self) -> None:
        with pytest.raises(ValueError, match="at least 1"):
            next_uid_range(None, uid_validity=1, batch_size=0)

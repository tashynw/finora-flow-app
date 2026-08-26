"""Matching a reply to a conversation, and knowing when a machine sent it.

Two rules are being defended here and the tests are shaped around them.

The subject line is never a basis on its own. What may be matched on is an
opaque tag that happens to travel in the subject, which is a different thing: it
survives translation, it cannot be produced by somebody writing a plausible
subject, and a subject with no tag in it produces no candidate at all. The tests
for this are the ones that would fail if somebody later added a helpful "or match
on the invoice number in the subject".

Nothing answers a machine. The auto-reply net is cast deliberately wide, because
a false positive costs one genuine reply being filed for a person to read while a
false negative costs two mail systems talking to each other over a weekend. Every
test below that asserts something *is* automatic is asserting a cost we chose.
"""

from __future__ import annotations

import pytest

from finora.domain.mail_correlation import (
    BASIS_LABELS,
    BASIS_ORDER,
    SUBJECT_PREFIX,
    TAG_LENGTH,
    AutomaticKind,
    CorrelationBasis,
    ReplyHeaders,
    automatic_kind,
    candidates,
    format_tag,
    is_automatic,
    new_tag,
    normalise_message_id,
    parse_references,
    reply_address,
    subject_marker,
    tag_in_addresses,
    tag_in_subject,
)

OURS = "<9f4c1a2e-0000-4000-8000-000000000001@finora.example>"
THEIRS = "<CAF=abc123@mail.supplier.example>"
EARLIER = "<9f4c1a2e-0000-4000-8000-000000000000@finora.example>"


class TestTags:
    def test_a_tag_is_prefixed(self) -> None:
        assert new_tag().startswith(SUBJECT_PREFIX.lower())

    def test_a_tag_is_the_expected_length(self) -> None:
        assert len(new_tag()) == len(SUBJECT_PREFIX) + TAG_LENGTH

    def test_tags_differ(self) -> None:
        assert len({new_tag() for _ in range(200)}) == 200

    def test_the_random_part_never_begins_with_the_prefix(self) -> None:
        """Keeps prefixing unambiguous.

        If the random part could itself start with `fnr`, stripping the prefix
        from an already-stripped tag would silently remove three real characters
        and produce a tag that matches nothing.
        """
        prefix = SUBJECT_PREFIX.lower()
        for _ in range(500):
            assert not new_tag()[len(prefix) :].startswith(prefix)

    def test_formatting_is_idempotent(self) -> None:
        tag = new_tag()
        assert format_tag(tag[len(SUBJECT_PREFIX) :]) == tag

    def test_a_subject_marker_round_trips(self) -> None:
        tag = new_tag()
        assert tag_in_subject(f"Re: Did our payment reach you? {subject_marker(tag)}") == tag

    def test_a_reply_address_round_trips(self) -> None:
        tag = new_tag()
        address = reply_address("payments@example.com", tag)
        assert address == f"payments+{tag}@example.com"
        assert tag_in_addresses((address,)) == tag

    def test_a_reply_address_survives_a_relay_changing_case(self) -> None:
        """Addresses are lower-cased in transit often enough to matter.

        The tag alphabet has no upper case in it for this reason, and this is the
        test that would catch somebody widening the alphabet later.
        """
        tag = new_tag()
        address = reply_address("Payments@Example.COM", tag).upper()
        assert tag_in_addresses((address,)) == tag

    def test_a_reply_address_needs_a_domain(self) -> None:
        with pytest.raises(ValueError, match="domain"):
            reply_address("payments", new_tag())

    def test_an_untagged_subject_yields_nothing(self) -> None:
        assert tag_in_subject("Re: your payment") is None

    def test_a_malformed_marker_yields_nothing(self) -> None:
        """A tag of the wrong length is not a tag.

        Truncation by a mail client that shortened the subject must not produce a
        near-miss that matches some other conversation.
        """
        assert tag_in_subject(f"Re: payment [{SUBJECT_PREFIX}-abc123]") is None


class TestMessageIds:
    def test_brackets_are_stripped(self) -> None:
        assert normalise_message_id(" <a@b> ") == "a@b"

    def test_case_is_preserved(self) -> None:
        """The local part of a Message-ID is case-sensitive.

        Lower-casing the whole thing is the kind of helpfulness that stops two
        genuinely identical ids from matching.
        """
        assert normalise_message_id("<AbC@d.example>") == "AbC@d.example"

    def test_a_folded_references_header_parses(self) -> None:
        header = f"{EARLIER}\r\n\t{OURS}"
        assert parse_references(header) == (
            normalise_message_id(EARLIER),
            normalise_message_id(OURS),
        )

    def test_comma_separated_references_parse(self) -> None:
        """Clients that should not use commas, do."""
        assert len(parse_references(f"{EARLIER}, {OURS}")) == 2

    def test_repeats_collapse(self) -> None:
        assert parse_references(f"{OURS} {OURS}") == (normalise_message_id(OURS),)

    def test_nothing_parses_to_nothing(self) -> None:
        assert parse_references(None) == ()
        assert parse_references("") == ()

    def test_prose_yields_no_ids(self) -> None:
        assert parse_references("thanks, will check with accounts") == ()


class TestCandidates:
    def test_in_reply_to_comes_first(self) -> None:
        found = candidates(
            ReplyHeaders(
                in_reply_to=OURS,
                references=(EARLIER,),
                subject=f"Re: payment {subject_marker(new_tag())}",
            )
        )
        assert found[0].basis is CorrelationBasis.in_reply_to
        assert found[0].value == normalise_message_id(OURS)

    def test_references_are_walked_newest_first(self) -> None:
        """A long thread names every message in it.

        The most recent of ours is the one being answered, so trying the oldest
        first would attach a reply to a conversation from two months ago that
        happens to share a thread.
        """
        found = candidates(ReplyHeaders(references=(EARLIER, OURS)))
        values = [item.value for item in found]
        assert values.index(normalise_message_id(OURS)) < values.index(
            normalise_message_id(EARLIER)
        )

    def test_an_address_tag_is_found_when_headers_are_missing(self) -> None:
        """The case that rescues mail forwarded by hand through a shared inbox.

        No threading headers survive that journey, and this is the only basis
        left.
        """
        tag = new_tag()
        found = candidates(ReplyHeaders(to_addresses=(reply_address("payments@example.com", tag),)))
        assert [item.basis for item in found] == [CorrelationBasis.reply_address_tag]
        assert found[0].value == tag

    def test_delivered_to_is_searched_as_well(self) -> None:
        """Which header carries the tagged address varies by relay."""
        tag = new_tag()
        found = candidates(ReplyHeaders(delivered_to=(reply_address("payments@example.com", tag),)))
        assert found[0].value == tag

    def test_a_subject_tag_is_last(self) -> None:
        tag = new_tag()
        found = candidates(
            ReplyHeaders(
                references=(OURS,),
                subject=f"Re: payment {subject_marker(tag)}",
            )
        )
        assert found[-1].basis is CorrelationBasis.subject_tag

    def test_a_plausible_subject_alone_matches_nothing(self) -> None:
        """The rule the master prompt states, as an executable assertion.

        A reply whose subject reads exactly like ours but carries no tag produces
        no candidates. Somebody who can guess what we call our emails cannot,
        by that alone, get a message filed against a payment.
        """
        assert candidates(ReplyHeaders(subject="Re: Did our payment reach you?")) == ()

    def test_a_message_with_nothing_to_go_on_yields_nothing(self) -> None:
        assert candidates(ReplyHeaders()) == ()

    def test_every_basis_is_ordered_and_labelled(self) -> None:
        assert set(BASIS_ORDER) == set(CorrelationBasis)
        assert set(BASIS_LABELS) == set(CorrelationBasis)

    def test_candidates_never_exceed_the_declared_order(self) -> None:
        """Guards against a fifth basis appearing without a place in the ranking."""
        tag = new_tag()
        found = candidates(
            ReplyHeaders(
                in_reply_to=OURS,
                references=(EARLIER,),
                to_addresses=(reply_address("payments@example.com", tag),),
                subject=subject_marker(tag),
            )
        )
        ranks = [BASIS_ORDER.index(item.basis) for item in found]
        assert ranks == sorted(ranks)


class TestAutomaticReplies:
    def test_an_empty_return_path_is_a_bounce(self) -> None:
        assert automatic_kind(ReplyHeaders(return_path="<>")) is AutomaticKind.bounce

    def test_a_delivery_status_report_is_a_bounce(self) -> None:
        headers = ReplyHeaders(
            content_type='multipart/report; report-type=delivery-status; boundary="x"'
        )
        assert automatic_kind(headers) is AutomaticKind.bounce

    def test_an_undeliverable_subject_is_a_bounce(self) -> None:
        assert automatic_kind(ReplyHeaders(subject="Undeliverable: payment")) is (
            AutomaticKind.bounce
        )

    def test_auto_submitted_marks_a_vacation_reply(self) -> None:
        assert automatic_kind(ReplyHeaders(auto_submitted="auto-replied")) is (
            AutomaticKind.vacation
        )

    def test_auto_submitted_no_is_a_person(self) -> None:
        """`Auto-Submitted: no` is what a conforming human message says.

        Treating the presence of the header as proof of a robot would suppress
        every reply from a mail system that sets it correctly.
        """
        assert automatic_kind(ReplyHeaders(auto_submitted="no")) is None

    def test_an_autoreply_marker_counts(self) -> None:
        assert automatic_kind(ReplyHeaders(autoreply_markers=("yes",))) is AutomaticKind.vacation

    def test_bulk_precedence_is_bulk(self) -> None:
        assert automatic_kind(ReplyHeaders(precedence="bulk")) is AutomaticKind.bulk

    def test_list_precedence_is_bulk(self) -> None:
        """A supplier's ticketing system announcing itself as a list is a robot.

        Answering it threads our question into their queue forever.
        """
        assert automatic_kind(ReplyHeaders(precedence="list")) is AutomaticKind.bulk

    @pytest.mark.parametrize(
        "subject",
        [
            "Automatic reply: payment",
            "Out of Office: back Monday",
            "AUTO: away",
            "Réponse automatique : paiement",
        ],
    )
    def test_known_automatic_subjects(self, subject: str) -> None:
        assert is_automatic(ReplyHeaders(subject=subject))

    def test_a_person_mentioning_out_of_office_is_not_automatic(self) -> None:
        """Matched at the start only, so prose about auto-replies is prose."""
        headers = ReplyHeaders(subject="Re: payment - sorry, I was out of office last week")
        assert automatic_kind(headers) is None

    def test_an_ordinary_reply_is_not_automatic(self) -> None:
        headers = ReplyHeaders(
            subject="Re: Did our payment reach you?",
            in_reply_to=OURS,
            from_address="marcia@supplier.example",
        )
        assert not is_automatic(headers)

    def test_a_bounce_beats_a_vacation_marker(self) -> None:
        """Both can be set at once, and which it is changes what happens next.

        A bounce means the address is wrong and the supplier should be reached
        another way; a vacation reply means the address is fine and the person is
        out. Filing one as the other sends somebody chasing the wrong problem.
        """
        headers = ReplyHeaders(return_path="<>", auto_submitted="auto-replied")
        assert automatic_kind(headers) is AutomaticKind.bounce

    def test_an_automatic_reply_can_still_be_correlated(self) -> None:
        """Being automatic suppresses the claim, not the filing.

        An out-of-office that threads correctly still belongs on the check-in's
        timeline: "we asked, and their accounts clerk is on leave until the
        third" is exactly what somebody chasing this needs to know.
        """
        headers = ReplyHeaders(in_reply_to=OURS, subject="Out of Office", auto_submitted="auto")
        assert is_automatic(headers)
        assert candidates(headers)[0].basis is CorrelationBasis.in_reply_to

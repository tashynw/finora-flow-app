"""A kind is claimed only when the document says so in its own title.

Getting the kind wrong is not cosmetic: a quotation misread as an invoice enters
the payment path, and an invoice misread as a quotation is never paid until the
vendor calls. `classification` is therefore deliberately conservative — the title
must sit near the top of page one, it must be short, supporting words can raise a
reading but never create one, and two equally evidenced titles produce `unknown`
rather than a coin toss dressed as a decision.

These tests describe documents as layouts rather than as geometry arithmetic, so
that what is being asserted is where the words sit on the page.
"""

from __future__ import annotations

import pytest

from finora.domain.classification import classify
from finora.domain.extraction import DocumentKind, MatchQuality, combine_confidence
from finora.domain.text_layout import (
    Box,
    DocumentText,
    PageText,
    TextSource,
    Word,
    build_lines,
)

#: A US Letter page in points. The title band is the top 38%, so anything at or
#: above y = 300 is somewhere a document could reasonably print its own name.
PAGE_WIDTH = 612.0
PAGE_HEIGHT = 792.0

LABELLED = combine_confidence(MatchQuality.labelled)
NEARBY_LABEL = combine_confidence(MatchQuality.nearby_label)


def _document(
    placements: list[tuple[str, float, float]],
    *,
    height: float = PAGE_HEIGHT,
    source: TextSource = TextSource.text_layer,
) -> DocumentText:
    """One page built from `(text, x, y)` placements, in points from the top-left.

    Each placement may hold several words; they are laid out along the same line
    so that a caller writes a document the way it reads.
    """
    words: list[Word] = []
    for text, x, y in placements:
        offset = x
        for token in text.split():
            width = len(token) * 7.0
            words.append(Word(text=token, box=Box(x=offset, y=y, width=width, height=12.0)))
            offset += width + 5.0
    page = PageText(
        number=1,
        width=PAGE_WIDTH,
        height=height,
        words=tuple(words),
        lines=build_lines(words),
    )
    return DocumentText(source=source, pages=(page,))


class TestInvoiceTitle:
    def test_a_short_invoice_heading_near_the_top_identifies_an_invoice(self) -> None:
        result = classify(_document([("INVOICE", 40.0, 60.0)]))
        assert result.kind is DocumentKind.invoice

    def test_supporting_wording_raises_the_reading_to_a_labelled_match(self) -> None:
        result = classify(
            _document(
                [
                    ("INVOICE", 40.0, 60.0),
                    ("Balance due 115,000.00", 40.0, 500.0),
                    ("Due date 3 May 2026", 40.0, 540.0),
                ]
            )
        )
        assert result.kind is DocumentKind.invoice
        assert result.confidence == LABELLED

    def test_a_title_with_nothing_corroborating_it_is_trusted_less(self) -> None:
        result = classify(_document([("INVOICE", 40.0, 60.0)]))
        assert result.confidence == NEARBY_LABEL
        assert result.confidence < LABELLED

    def test_a_qualified_invoice_title_is_still_an_invoice(self) -> None:
        assert classify(_document([("TAX INVOICE", 40.0, 60.0)])).kind is DocumentKind.invoice


class TestEvidence:
    def test_the_matching_line_is_returned_as_evidence(self) -> None:
        result = classify(_document([("Acme Limited", 40.0, 40.0), ("INVOICE", 400.0, 80.0)]))
        assert result.evidence is not None
        assert result.evidence.snippet == "INVOICE"

    def test_the_evidence_names_the_page_it_was_found_on(self) -> None:
        result = classify(_document([("INVOICE", 40.0, 60.0)]))
        assert result.evidence is not None
        assert result.evidence.page_number == 1

    def test_the_evidence_carries_one_rectangle_a_reviewer_can_be_shown(self) -> None:
        result = classify(_document([("INVOICE", 40.0, 60.0)]))
        assert result.evidence is not None
        assert len(result.evidence.boxes) == 1
        assert result.evidence.is_pointable


class TestOtherKinds:
    @pytest.mark.parametrize(
        ("title", "expected"),
        [
            ("QUOTATION", DocumentKind.estimate),
            ("ESTIMATE", DocumentKind.estimate),
            ("CREDIT NOTE", DocumentKind.credit_note),
            ("PURCHASE ORDER", DocumentKind.purchase_order),
            ("RECEIPT", DocumentKind.receipt),
            ("STATEMENT OF ACCOUNT", DocumentKind.statement),
            ("REMITTANCE ADVICE", DocumentKind.remittance_advice),
        ],
    )
    def test_each_recognised_title_identifies_its_own_kind(
        self, title: str, expected: DocumentKind
    ) -> None:
        assert classify(_document([(title, 40.0, 60.0)])).kind is expected


class TestTitlesMustBeWhereTitlesAre:
    def test_the_word_invoice_far_down_the_page_does_not_identify_an_invoice(self) -> None:
        # "Invoice" appears in the small print of a quotation as often as it
        # appears on an invoice, so body text can never create a reading.
        result = classify(
            _document(
                [
                    ("Acme Limited", 40.0, 60.0),
                    ("This will be replaced by an invoice on acceptance", 40.0, 700.0),
                ]
            )
        )
        assert result.kind is DocumentKind.unknown

    def test_a_sentence_containing_invoice_in_the_title_band_does_not_identify_one(self) -> None:
        # A title is short. A seven-word sentence is prose about an invoice, not
        # a heading that says the document is one.
        result = classify(_document([("Please find our invoice for the works below", 40.0, 60.0)]))
        assert result.kind is DocumentKind.unknown

    def test_a_six_word_title_is_still_short_enough_to_be_a_title(self) -> None:
        result = classify(_document([("ACME LIMITED COMMERCIAL INVOICE NUMBER 4471", 40.0, 60.0)]))
        assert result.kind is DocumentKind.invoice

    def test_a_page_of_no_height_cannot_have_a_title_band(self) -> None:
        result = classify(_document([("INVOICE", 40.0, 0.0)], height=0.0))
        assert result.kind is DocumentKind.unknown


class TestProFormaInvoice:
    def test_a_pro_forma_invoice_is_an_estimate_rather_than_an_invoice(self) -> None:
        # A pro forma is a request for payment in advance, not a final invoice
        # for a completed supply, so it belongs in the path that gets approved
        # before money moves.
        result = classify(
            _document(
                [
                    ("PRO FORMA INVOICE", 40.0, 60.0),
                    ("Valid until 30 April 2026", 40.0, 500.0),
                ]
            )
        )
        assert result.kind is DocumentKind.estimate

    def test_the_pro_forma_reading_explains_itself_to_the_reviewer(self) -> None:
        result = classify(
            _document(
                [
                    ("PRO FORMA INVOICE", 40.0, 60.0),
                    ("Valid until 30 April 2026", 40.0, 500.0),
                ]
            )
        )
        assert result.notes
        assert "pro forma" in result.notes[0]
        assert "approved before anything is paid" in result.notes[0]


class TestUndecidableDocuments:
    def test_two_equally_evidenced_titles_are_not_resolved(self) -> None:
        result = classify(_document([("INVOICE", 40.0, 60.0), ("CREDIT NOTE", 40.0, 120.0)]))
        assert result.kind is DocumentKind.unknown
        assert result.confidence == 0.0

    def test_both_contenders_are_named_so_the_reviewer_knows_the_real_choice(self) -> None:
        result = classify(_document([("INVOICE", 40.0, 60.0), ("CREDIT NOTE", 40.0, 120.0)]))
        assert result.contenders == (DocumentKind.credit_note, DocumentKind.invoice)
        assert result.notes
        assert "more than one title" in result.notes[0]

    def test_a_document_carrying_no_recognised_title_is_unknown(self) -> None:
        result = classify(_document([("Acme Limited", 40.0, 60.0), ("Schedule", 40.0, 120.0)]))
        assert result.kind is DocumentKind.unknown
        assert result.confidence == 0.0
        assert result.evidence is None
        assert result.notes
        assert "No document title" in result.notes[0]

    def test_a_document_with_no_pages_is_unknown(self) -> None:
        result = classify(DocumentText(source=TextSource.none, pages=()))
        assert result.kind is DocumentKind.unknown
        assert result.confidence == 0.0
        assert result.evidence is None
        assert result.notes == ("There was no readable text to identify this document from.",)

    def test_a_page_with_no_words_is_unknown(self) -> None:
        result = classify(_document([]))
        assert result.kind is DocumentKind.unknown
        assert result.confidence == 0.0
        assert result.notes == ("There was no readable text to identify this document from.",)

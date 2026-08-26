"""Words never travel without their position on the page.

`text_layout` is what makes a reading defensible rather than merely plausible: a
total with a rectangle around it is evidence, and a total without one is an
assertion. These tests defend the geometry primitives, the reconstruction of
visual lines from words a PDF may emit in any order, and the normalisation that
stops a typographic dash from turning a found label into "not found".
"""

from __future__ import annotations

import pytest

from finora.domain.text_layout import (
    EXACT_GEOMETRY_SOURCES,
    Box,
    DocumentText,
    PageText,
    TextLine,
    TextSource,
    Word,
    build_lines,
    normalise,
)


def _word(text: str, x: float, y: float, *, width: float = 40.0, height: float = 10.0) -> Word:
    return Word(text=text, box=Box(x=x, y=y, width=width, height=height))


def _page(number: int, words: tuple[Word, ...], *, height: float = 792.0) -> PageText:
    return PageText(
        number=number,
        width=612.0,
        height=height,
        words=words,
        lines=build_lines(words),
    )


class TestBox:
    @pytest.mark.parametrize(("width", "height"), [(-1.0, 10.0), (10.0, -1.0), (-1.0, -1.0)])
    def test_a_box_cannot_have_a_negative_dimension(self, width: float, height: float) -> None:
        with pytest.raises(ValueError, match="negative width or height"):
            Box(x=0.0, y=0.0, width=width, height=height)

    def test_a_zero_sized_box_is_allowed(self) -> None:
        assert Box(x=5.0, y=5.0, width=0.0, height=0.0).right == 5.0

    def test_the_far_edges_are_the_origin_plus_the_extent(self) -> None:
        box = Box(x=10.0, y=20.0, width=100.0, height=40.0)
        assert box.right == 110.0
        assert box.bottom == 60.0

    def test_the_vertical_centre_is_halfway_down(self) -> None:
        assert Box(x=0.0, y=20.0, width=10.0, height=30.0).centre_y == 35.0

    def test_the_union_of_two_disjoint_boxes_encloses_both(self) -> None:
        left = Box(x=10.0, y=10.0, width=20.0, height=10.0)
        right = Box(x=100.0, y=50.0, width=20.0, height=10.0)
        assert left.union(right) == Box(x=10.0, y=10.0, width=110.0, height=50.0)

    def test_the_union_is_the_same_whichever_way_round_it_is_taken(self) -> None:
        left = Box(x=10.0, y=10.0, width=20.0, height=10.0)
        right = Box(x=100.0, y=50.0, width=20.0, height=10.0)
        assert left.union(right) == right.union(left)

    def test_the_union_of_a_nested_box_is_the_enclosing_box(self) -> None:
        outer = Box(x=0.0, y=0.0, width=100.0, height=100.0)
        inner = Box(x=25.0, y=25.0, width=10.0, height=10.0)
        assert outer.union(inner) == outer

    def test_padding_grows_each_dimension_by_twice_the_amount(self) -> None:
        box = Box(x=50.0, y=60.0, width=100.0, height=20.0)
        padded = box.padded(4.0)
        assert padded == Box(x=46.0, y=56.0, width=108.0, height=28.0)

    def test_padding_clamps_the_origin_at_zero_rather_than_going_off_the_page(self) -> None:
        # A negative origin draws the highlight in the wrong place instead of
        # failing loudly, so it is clamped.
        padded = Box(x=1.0, y=2.0, width=10.0, height=20.0).padded(5.0)
        assert padded.x == 0.0
        assert padded.y == 0.0
        assert padded.width == 20.0
        assert padded.height == 30.0


class TestTextLine:
    def test_a_line_must_contain_at_least_one_word(self) -> None:
        with pytest.raises(ValueError, match="at least one word"):
            TextLine(words=())

    def test_the_text_of_a_line_joins_its_words_with_single_spaces(self) -> None:
        line = TextLine(words=(_word("Invoice", 10.0, 10.0), _word("number", 60.0, 10.0)))
        assert line.text == "Invoice number"

    def test_the_box_of_a_line_is_the_union_of_every_word_box(self) -> None:
        line = TextLine(
            words=(
                _word("Invoice", 10.0, 10.0, width=40.0, height=10.0),
                _word("number", 60.0, 12.0, width=50.0, height=10.0),
            )
        )
        assert line.box == Box(x=10.0, y=10.0, width=100.0, height=12.0)

    def test_the_box_of_a_single_word_line_is_that_word_box(self) -> None:
        word = _word("Total", 100.0, 200.0)
        assert TextLine(words=(word,)).box == word.box

    def test_box_of_returns_nothing_for_an_empty_selection(self) -> None:
        line = TextLine(words=(_word("Total", 100.0, 200.0),))
        assert line.box_of(()) is None
        assert line.box_of([]) is None

    def test_box_of_encloses_the_words_it_is_given(self) -> None:
        first = _word("JMD", 100.0, 200.0, width=30.0, height=10.0)
        second = _word("1,500.00", 140.0, 200.0, width=60.0, height=10.0)
        line = TextLine(words=(first, second))
        assert line.box_of([first, second]) == Box(x=100.0, y=200.0, width=100.0, height=10.0)

    def test_words_from_drops_the_leading_words(self) -> None:
        line = TextLine(
            words=(
                _word("Invoice", 10.0, 10.0),
                _word("number", 60.0, 10.0),
                _word("4471", 120.0, 10.0),
            )
        )
        assert tuple(word.text for word in line.words_from(2)) == ("4471",)


class TestBuildLines:
    def test_no_words_produce_no_lines(self) -> None:
        assert build_lines([]) == ()
        assert build_lines(()) == ()

    def test_words_sharing_a_vertical_centre_become_one_line(self) -> None:
        words = [_word("Invoice", 10.0, 50.0), _word("4471", 80.0, 50.0)]
        lines = build_lines(words)
        assert len(lines) == 1
        assert lines[0].text == "Invoice 4471"

    def test_a_line_reads_left_to_right_however_the_words_arrived(self) -> None:
        # A PDF is free to emit a page's characters in any order it likes, so
        # stream order says nothing about reading order.
        words = [
            _word("4471", 200.0, 50.0),
            _word("Invoice", 10.0, 50.0),
            _word("number", 100.0, 50.0),
        ]
        assert build_lines(words)[0].text == "Invoice number 4471"

    def test_words_far_apart_vertically_become_separate_lines_top_to_bottom(self) -> None:
        words = [_word("Total", 10.0, 300.0), _word("Invoice", 10.0, 50.0)]
        lines = build_lines(words)
        assert [line.text for line in lines] == ["Invoice", "Total"]

    def test_a_large_and_a_small_word_group_when_within_the_taller_word_tolerance(self) -> None:
        # The tolerance is 0.6 of the taller word's height, so a 24pt heading and
        # an 8pt word beside it stay together without a table of font exceptions.
        heading = _word("TOTAL", 100.0, 100.0, width=60.0, height=24.0)
        small = _word("2026", 200.0, 114.0, width=30.0, height=8.0)
        lines = build_lines([heading, small])
        assert len(lines) == 1
        assert lines[0].text == "TOTAL 2026"

    def test_a_clearly_lower_line_is_not_absorbed_by_the_tolerance(self) -> None:
        heading = _word("TOTAL", 100.0, 100.0, width=60.0, height=24.0)
        small = _word("2026", 200.0, 114.0, width=30.0, height=8.0)
        below = _word("Subtotal", 100.0, 200.0, width=60.0, height=10.0)
        lines = build_lines([heading, small, below])
        assert [line.text for line in lines] == ["TOTAL 2026", "Subtotal"]


class TestPageText:
    def test_the_text_of_a_page_joins_its_lines_with_newlines(self) -> None:
        page = _page(1, (_word("Invoice", 10.0, 50.0), _word("Total", 10.0, 300.0)))
        assert page.text == "Invoice\nTotal"

    def test_a_page_with_no_words_is_empty(self) -> None:
        page = _page(1, ())
        assert page.is_empty
        assert page.text == ""

    def test_a_page_with_words_is_not_empty(self) -> None:
        assert not _page(1, (_word("Invoice", 10.0, 50.0),)).is_empty


class TestDocumentText:
    def test_the_text_of_a_document_joins_its_pages_with_newlines(self) -> None:
        document = DocumentText(
            source=TextSource.text_layer,
            pages=(
                _page(1, (_word("Invoice", 10.0, 50.0),)),
                _page(2, (_word("Continued", 10.0, 50.0),)),
            ),
        )
        assert document.text == "Invoice\nContinued"

    def test_the_page_count_is_the_number_of_pages_read(self) -> None:
        document = DocumentText(
            source=TextSource.text_layer,
            pages=(_page(1, ()), _page(2, ()), _page(3, ())),
        )
        assert document.page_count == 3

    def test_a_document_whose_every_page_is_empty_has_no_text(self) -> None:
        document = DocumentText(source=TextSource.text_layer, pages=(_page(1, ()), _page(2, ())))
        assert not document.has_text

    def test_one_page_with_words_is_enough_for_a_document_to_have_text(self) -> None:
        document = DocumentText(
            source=TextSource.text_layer,
            pages=(_page(1, ()), _page(2, (_word("Invoice", 10.0, 50.0),))),
        )
        assert document.has_text

    def test_a_document_with_no_pages_has_no_text(self) -> None:
        assert not DocumentText(source=TextSource.none, pages=()).has_text

    @pytest.mark.parametrize("source", list(TextSource))
    def test_only_a_text_layer_carries_exact_geometry(self, source: TextSource) -> None:
        # Recognised text is a reading of an image; its coordinates are estimates
        # and must never be presented as though they were the document's own.
        document = DocumentText(source=source, pages=())
        assert document.has_exact_geometry is (source is TextSource.text_layer)

    def test_the_exact_geometry_sources_are_exactly_the_text_layer(self) -> None:
        assert EXACT_GEOMETRY_SOURCES == frozenset({TextSource.text_layer})

    def test_a_page_is_looked_up_by_its_own_number(self) -> None:
        second = _page(2, (_word("Continued", 10.0, 50.0),))
        document = DocumentText(source=TextSource.text_layer, pages=(_page(1, ()), second))
        assert document.page(2) is second

    def test_looking_up_a_page_that_was_not_read_returns_nothing(self) -> None:
        document = DocumentText(source=TextSource.text_layer, pages=(_page(1, ()),))
        assert document.page(7) is None

    def test_lines_pairs_each_page_with_each_of_its_own_lines(self) -> None:
        first = _page(1, (_word("Invoice", 10.0, 50.0), _word("Total", 10.0, 300.0)))
        second = _page(2, (_word("Continued", 10.0, 50.0),))
        document = DocumentText(source=TextSource.text_layer, pages=(first, second))
        assert [(page.number, line.text) for page, line in document.lines()] == [
            (1, "Invoice"),
            (1, "Total"),
            (2, "Continued"),
        ]

    def test_notes_default_to_none_recorded(self) -> None:
        assert DocumentText(source=TextSource.text_layer, pages=()).notes == ()


class TestNormalise:
    def test_runs_of_whitespace_collapse_to_one_space(self) -> None:
        assert normalise("Invoice   \t\n number") == "invoice number"

    def test_leading_and_trailing_whitespace_is_stripped(self) -> None:
        assert normalise("  Invoice number \n") == "invoice number"

    def test_case_is_levelled(self) -> None:
        assert normalise("INVOICE Number") == "invoice number"

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("\u2018quoted\u2019", "'quoted'"),
            ("\u201cquoted\u201d", '"quoted"'),
            ("invoice\u2013number", "invoice-number"),
            ("invoice\u2014number", "invoice-number"),
            ("invoice\u2212number", "invoice-number"),
            ("invoice\u00a0number", "invoice number"),
            ("\ufb01nal", "final"),
            ("\ufb02oat", "float"),
        ],
    )
    def test_typographic_lookalikes_are_mapped_to_ascii(self, raw: str, expected: str) -> None:
        assert normalise(raw) == expected

    def test_compatibility_forms_are_folded_by_nfkc(self) -> None:
        assert normalise("\uff29\uff2e\uff36\uff2f\uff29\uff23\uff25") == "invoice"

    def test_an_en_dash_in_a_label_matches_after_normalisation(self) -> None:
        # A vendor's typographic dash is the difference between finding the
        # invoice number and telling a user it is not there.
        assert normalise("Invoice \u2013 Number") == normalise("INVOICE - NUMBER")
        assert normalise("Invoice \u2013 Number") == "invoice - number"

    def test_empty_text_normalises_to_empty_text(self) -> None:
        assert normalise("") == ""
        assert normalise("   \n\t ") == ""

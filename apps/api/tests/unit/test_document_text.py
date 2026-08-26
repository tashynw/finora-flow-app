"""The one place the platform opens a file someone outside it supplied.

Two promises are defended here. The first is that nothing escapes: a corrupt,
encrypted, empty or actively hostile document produces a `DocumentText` that
explains itself, never an exception, because an exception here turns "this scan
is unreadable, type the fields in" into a failed request with a blank screen.
The second is that the explanations are worth reading — "password protected" and
"damaged" send a reviewer to two different places, so the tests assert on what
the notes actually say and not merely that a note exists.

PDFs are built by hand rather than by a writer library. A literal PDF is a few
lines of bytes, and the alternative is a production dependency carried solely to
produce test fixtures.
"""

from __future__ import annotations

import time
from collections.abc import Sequence

import pytest

from finora.domain.text_layout import DocumentText, TextSource
from finora.infrastructure.document_text import ReadingLimits, read_document, unreadable

PAGE_WIDTH = 612.0
PAGE_HEIGHT = 792.0

#: A run of text and where it starts, in PDF user space: x from the left edge,
#: y up from the bottom. The reader is expected to hand back the top-left
#: measurement a viewer draws with, which is what makes the flip worth asserting.
Placement = tuple[str, float, float]


def _escape(text: str) -> str:
    for character, replacement in (("\\", "\\\\"), ("(", "\\("), (")", "\\)")):
        text = text.replace(character, replacement)
    return text


def _assemble(objects: Sequence[bytes], *, trailer_extra: str = "") -> bytes:
    """Wrap numbered object bodies in a header, a real xref table and a trailer.

    The xref offsets are computed rather than faked because a parser that has to
    reconstruct a broken table takes a different path through its own code, and
    a fixture that quietly exercises the recovery path is not testing the file
    it claims to be.
    """
    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode("ascii") + body + b"\nendobj\n"

    table = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode("ascii")
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode("ascii")
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R {trailer_extra} >>\n"
        f"startxref\n{table}\n%%EOF\n"
    ).encode("ascii")
    return bytes(out)


def _pdf(
    pages: Sequence[Sequence[Placement]],
    *,
    width: float = PAGE_WIDTH,
    height: float = PAGE_HEIGHT,
    rotate: int = 0,
    size: float = 12.0,
) -> bytes:
    """A PDF of one or more pages with text at given positions in Helvetica."""
    kids = " ".join(f"{4 + index * 2} 0 R" for index in range(len(pages)))
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode("ascii"),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ]
    for index, placements in enumerate(pages):
        content = "".join(
            f"BT /F1 {size} Tf 1 0 0 1 {x} {y} Tm ({_escape(text)}) Tj ET\n"
            for text, x, y in placements
        ).encode("ascii")
        objects.append(
            (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] "
                f"/Rotate {rotate} /Resources << /Font << /F1 3 0 R >> >> "
                f"/Contents {5 + index * 2} 0 R >>"
            ).encode("ascii")
        )
        objects.append(
            f"<< /Length {len(content)} >>\nstream\n".encode("ascii") + content + b"endstream"
        )
    return _assemble(objects)


def _pdf_without_pages() -> bytes:
    return _assemble(
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [] /Count 0 >>",
        ]
    )


def _protected_pdf() -> bytes:
    """A PDF whose standard security handler rejects the empty password.

    The body is left in the clear: what is under test is how an authentication
    failure is explained, and a parser refuses this document at exactly the point
    it refuses a genuinely encrypted one, before any content is touched.
    """
    identifier = "<0102030405060708090a0b0c0d0e0f10>"
    return _assemble(
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
            b"<< /Filter /Standard /V 1 /R 2 /P -1 /O <"
            + b"11" * 32
            + b"> /U <"
            + b"22" * 32
            + b"> >>",
        ],
        trailer_extra=f"/Encrypt 5 0 R /ID [{identifier} {identifier}]",
    )


def _read_pdf(data: bytes, *, limits: ReadingLimits | None = None) -> DocumentText:
    return read_document(data, content_type="application/pdf", limits=limits)


def _read_text(data: bytes, *, content_type: str = "text/plain") -> DocumentText:
    return read_document(data, content_type=content_type)


class TestReadingLimits:
    @pytest.mark.parametrize("max_pages", [0, -1, -100])
    def test_a_reading_that_may_open_no_page_is_not_a_reading(self, max_pages: int) -> None:
        with pytest.raises(ValueError, match="least one page"):
            ReadingLimits(max_pages=max_pages)

    @pytest.mark.parametrize("max_seconds", [0.0, -0.5, -20.0])
    def test_a_reading_needs_a_positive_time_budget(self, max_seconds: float) -> None:
        with pytest.raises(ValueError, match="positive time budget"):
            ReadingLimits(max_seconds=max_seconds)

    def test_a_single_page_and_a_sliver_of_time_are_accepted(self) -> None:
        limits = ReadingLimits(max_pages=1, max_seconds=0.001)
        assert limits.max_pages == 1
        assert limits.max_seconds == 0.001

    def test_the_default_ceilings_are_bounded_without_being_asked_for(self) -> None:
        limits = ReadingLimits()
        assert limits.max_pages == 10
        assert limits.max_seconds == 20.0


class TestUnreadable:
    def test_an_unreadable_reading_has_no_source_and_no_pages(self) -> None:
        document = unreadable("The file is a picture of a duck.")
        assert document.source is TextSource.none
        assert document.pages == ()
        assert document.page_count == 0
        assert not document.has_text

    def test_an_unreadable_reading_carries_the_explanation_it_was_given(self) -> None:
        document = unreadable("The file is a picture of a duck.")
        assert document.notes == ("The file is a picture of a duck.",)

    def test_an_unreadable_reading_never_claims_exact_geometry(self) -> None:
        assert not unreadable("Nothing here.").has_exact_geometry


class TestRoutingByContentType:
    @pytest.mark.parametrize("content_type", ["application/pdf", "text/csv", "image/png", ""])
    def test_an_empty_file_is_reported_before_its_type_is_considered(
        self, content_type: str
    ) -> None:
        document = read_document(b"", content_type=content_type)
        assert document.source is TextSource.none
        assert "The file is empty" in document.notes[0]

    @pytest.mark.parametrize("content_type", ["image/png", "application/zip", "image/tiff"])
    def test_an_unsupported_type_is_named_in_the_refusal(self, content_type: str) -> None:
        document = read_document(b"not really a document", content_type=content_type)
        assert document.source is TextSource.none
        assert content_type in document.notes[0]

    def test_an_unsupported_type_is_refused_rather_than_sniffed_from_its_bytes(self) -> None:
        # The bytes are a perfectly good PDF. A reader chosen from content is a
        # reader chosen by whoever sent the file, so the declared type decides.
        document = read_document(_pdf([[("Invoice", 72.0, 720.0)]]), content_type="image/png")
        assert document.source is TextSource.none
        assert not document.pages

    def test_a_refusal_tells_the_reviewer_the_fields_can_still_be_entered(self) -> None:
        document = read_document(b"...", content_type="application/zip")
        assert "entered by hand" in document.notes[0]
        assert "can be opened" in document.notes[0]

    @pytest.mark.parametrize(
        "content_type",
        [
            "application/pdf; charset=binary",
            "application/pdf;version=1.7",
            "APPLICATION/PDF",
            "  application/pdf  ",
        ],
    )
    def test_a_decorated_content_type_still_reaches_the_pdf_reader(self, content_type: str) -> None:
        document = read_document(_pdf([[("Invoice", 72.0, 720.0)]]), content_type=content_type)
        assert document.source is TextSource.text_layer
        assert document.text == "Invoice"

    @pytest.mark.parametrize("content_type", ["", "   ", "; charset=utf-8"])
    def test_a_missing_content_type_is_reported_as_unknown(self, content_type: str) -> None:
        document = read_document(b"Invoice 4471", content_type=content_type)
        assert "'unknown'" in document.notes[0]

    @pytest.mark.parametrize(
        "content_type", ["text/plain", "text/csv", "text/tab-separated-values"]
    )
    def test_every_text_type_reaches_the_text_reader(self, content_type: str) -> None:
        document = read_document(b"Invoice 4471", content_type=content_type)
        assert document.source is TextSource.plain_text


class TestReadingPlainText:
    def test_a_text_file_is_one_page_whose_characters_are_exact(self) -> None:
        document = _read_text(b"Invoice 4471\nTotal 115,000.00\n")
        assert document.source is TextSource.plain_text
        assert document.page_count == 1
        assert document.text == "Invoice 4471\nTotal 115,000.00"

    def test_a_text_file_has_no_geometry_that_may_be_drawn_on_a_page(self) -> None:
        document = _read_text(b"Invoice 4471")
        assert not document.has_exact_geometry
        assert "cannot be highlighted" in document.notes[0]

    def test_words_on_the_same_line_share_a_vertical_position(self) -> None:
        page = _read_text(b"Invoice Number 4471").pages[0]
        assert len({word.box.y for word in page.words}) == 1
        assert len(page.lines) == 1

    def test_each_later_line_sits_further_down_the_page(self) -> None:
        page = _read_text(b"first\nsecond\nthird").pages[0]
        assert [word.box.y for word in page.words] == [0.0, 12.0, 24.0]
        assert [line.text for line in page.lines] == ["first", "second", "third"]

    def test_words_are_laid_out_left_to_right_by_the_length_of_the_one_before(self) -> None:
        page = _read_text(b"ab cde").pages[0]
        first, second = page.words
        assert (first.box.x, first.box.width) == (0.0, 12.0)
        assert second.box.x == first.box.right + 6.0

    def test_the_page_is_as_wide_as_its_longest_line_and_as_tall_as_its_lines(self) -> None:
        page = _read_text(b"ab\nabcd\n").pages[0]
        assert page.width == 24.0
        assert page.height == 24.0

    def test_a_blank_line_still_pushes_what_follows_it_down(self) -> None:
        page = _read_text(b"first\n\nthird").pages[0]
        assert [word.box.y for word in page.words] == [0.0, 24.0]

    def test_tab_separated_values_become_separate_words_on_one_line(self) -> None:
        page = _read_text(
            b"Invoice\t4471\tJMD 115,000.00", content_type="text/tab-separated-values"
        ).pages[0]
        assert [word.text for word in page.words] == ["Invoice", "4471", "JMD", "115,000.00"]
        assert len(page.lines) == 1

    def test_a_comma_separated_row_stays_one_word_because_only_whitespace_divides_them(
        self,
    ) -> None:
        # Delimiters are not interpreted here. A CSV cell is reached by the
        # extraction rules matching within a word, not by this reader guessing
        # which of a comma, a semicolon or a pipe the exporter chose.
        page = _read_text(b"Invoice,4471,115000.00", content_type="text/csv").pages[0]
        assert [word.text for word in page.words] == ["Invoice,4471,115000.00"]

    def test_trailing_whitespace_on_a_line_is_not_read_as_a_word(self) -> None:
        page = _read_text(b"Invoice 4471   \t\nTotal 500  ").pages[0]
        assert [word.text for word in page.words] == ["Invoice", "4471", "Total", "500"]

    @pytest.mark.parametrize("data", [b" ", b"\n\n\n", b"   \r\n\t \r\n", b"\t"])
    def test_a_file_holding_only_whitespace_is_reported_as_holding_no_text(
        self, data: bytes
    ) -> None:
        document = _read_text(data)
        assert document.source is TextSource.none
        assert document.notes == ("This file contains no text.",)

    def test_a_byte_order_mark_is_not_left_stuck_to_the_first_word(self) -> None:
        # Excel writes one on every CSV it exports. Kept, it makes the first cell
        # begin with an invisible character that matches no label, and the field
        # reads to a user as missing rather than as an encoding detail.
        document = _read_text("\ufeffInvoice,4471".encode(), content_type="text/csv")
        assert document.pages[0].words[0].text == "Invoice,4471"
        assert "\ufeff" not in document.text

    def test_a_file_a_windows_spreadsheet_wrote_is_read_rather_than_refused(self) -> None:
        document = _read_text("Café Total".encode("cp1252"), content_type="text/csv")
        assert [word.text for word in document.pages[0].words] == ["Café", "Total"]

    def test_a_byte_no_encoding_explains_is_shown_rather_than_silently_dropped(self) -> None:
        document = _read_text(b"Total \x81 due")
        assert [word.text for word in document.pages[0].words] == ["Total", "\ufffd", "due"]


class TestReadingAPdf:
    def test_a_one_page_pdf_yields_its_words_and_the_size_of_its_page(self) -> None:
        document = _read_pdf(
            _pdf([[("Invoice", 72.0, 720.0), ("4471", 200.0, 720.0), ("Total", 72.0, 700.0)]])
        )

        assert document.source is TextSource.text_layer
        assert document.page_count == 1
        page = document.pages[0]
        assert page.number == 1
        assert (page.width, page.height) == (PAGE_WIDTH, PAGE_HEIGHT)
        assert [word.text for word in page.words] == ["Invoice", "4471", "Total"]

    def test_the_words_of_a_pdf_are_assembled_into_the_lines_a_reader_would_see(self) -> None:
        document = _read_pdf(
            _pdf([[("Invoice", 72.0, 720.0), ("4471", 200.0, 720.0), ("Total", 72.0, 700.0)]])
        )
        assert [line.text for line in document.pages[0].lines] == ["Invoice 4471", "Total"]

    def test_a_pdf_word_can_be_pointed_at_on_the_page(self) -> None:
        page = _read_pdf(_pdf([[("Invoice", 72.0, 720.0)]])).pages[0]
        box = page.words[0].box

        assert box.x == pytest.approx(72.0)
        assert box.height == pytest.approx(12.0)
        assert box.width > 0
        assert 0.0 <= box.y <= box.bottom <= page.height
        assert box.right <= page.width

    def test_a_word_higher_on_the_page_has_the_smaller_y(self) -> None:
        # Coordinates come out in visual space, origin top-left, which is the
        # opposite of the PDF user space the words were written in.
        page = _read_pdf(_pdf([[("header", 72.0, 720.0), ("footer", 72.0, 60.0)]])).pages[0]
        header, footer = page.words
        assert header.text == "header"
        assert header.box.y < footer.box.y

    def test_pages_are_numbered_from_one_in_the_order_the_document_gives_them(self) -> None:
        document = _read_pdf(
            _pdf([[("One", 72.0, 720.0)], [("Two", 72.0, 720.0)], [("Three", 72.0, 720.0)]])
        )
        assert [page.number for page in document.pages] == [1, 2, 3]
        assert document.text == "One\nTwo\nThree"

    def test_a_pdf_that_read_cleanly_reports_nothing_to_the_reviewer(self) -> None:
        assert _read_pdf(_pdf([[("Invoice", 72.0, 720.0)]])).notes == ()

    def test_a_rotated_page_carries_no_rotation_because_its_coordinates_already_do(self) -> None:
        # A viewer builds its viewport from /Rotate too. Passing the raw value on
        # would have the rotation applied a second time and every highlight would
        # land on the wrong quarter of the page.
        page = _read_pdf(_pdf([[("Invoice", 72.0, 720.0)]], rotate=90)).pages[0]
        assert page.rotation == 0
        assert (page.width, page.height) == (PAGE_HEIGHT, PAGE_WIDTH)

    def test_a_pdf_with_no_pages_is_reported_as_unreadable(self) -> None:
        document = _read_pdf(_pdf_without_pages())
        assert document.source is TextSource.none
        assert document.notes == ("This PDF contains no pages.",)

    def test_a_pdf_with_pages_but_no_text_in_them_is_reported_as_a_scan(self) -> None:
        document = _read_pdf(_pdf([[], []]))
        assert document.source is TextSource.none
        assert "scan or an image" in document.notes[0]
        assert "recognition service" in document.notes[0]

    def test_a_scan_keeps_its_pages_so_the_viewer_still_has_something_to_show(self) -> None:
        document = _read_pdf(_pdf([[], []]))
        assert document.page_count == 2
        assert all(page.is_empty for page in document.pages)

    @pytest.mark.parametrize(
        "damage",
        [
            _pdf([[("Invoice", 72.0, 720.0)]])[:120],
            _pdf([[("Invoice", 72.0, 720.0)]])[:-40],
            b"%PDF-1.7\n" + bytes(range(256)) * 4,
            b"%PDF-1.4\n" + b"<< /A " * 500 + b">>" * 500,
        ],
    )
    def test_a_damaged_pdf_says_the_file_is_broken_and_the_original_is_kept(
        self, damage: bytes
    ) -> None:
        document = _read_pdf(damage)
        assert document.source is TextSource.none
        assert "damaged or incomplete" in document.notes[0]
        assert "can be downloaded" in document.notes[0]

    def test_a_password_protected_pdf_says_so_rather_than_calling_the_file_damaged(self) -> None:
        # `pdfplumber` reports every parser failure as one exception type whose
        # message is empty for a wrong password, so the two outcomes are only
        # distinguishable from the cause chain. Told the file is damaged, a
        # reviewer downloads a document that opens perfectly well elsewhere
        # instead of asking the sender for an unprotected copy.
        document = _read_pdf(_protected_pdf())
        assert document.source is TextSource.none
        assert "password protected" in document.notes[0]
        assert "unprotected copy" in document.notes[0]


class TestThePageCeiling:
    def test_pages_beyond_the_ceiling_are_not_read(self) -> None:
        document = _read_pdf(
            _pdf([[(f"page{number}", 72.0, 720.0)] for number in range(1, 6)]),
            limits=ReadingLimits(max_pages=2),
        )
        assert document.page_count == 2
        assert document.text == "page1\npage2"

    def test_the_reviewer_is_told_how_many_pages_there_were_and_how_many_were_read(self) -> None:
        document = _read_pdf(
            _pdf([[(f"page{number}", 72.0, 720.0)] for number in range(1, 6)]),
            limits=ReadingLimits(max_pages=2),
        )
        note = document.notes[0]
        assert "5 pages" in note
        assert "first 2" in note
        assert "opened in the viewer" in note

    def test_a_document_inside_the_ceiling_is_read_without_a_note_about_it(self) -> None:
        document = _read_pdf(
            _pdf([[("One", 72.0, 720.0)], [("Two", 72.0, 720.0)]]),
            limits=ReadingLimits(max_pages=2),
        )
        assert document.page_count == 2
        assert document.notes == ()


class TestTheTimeBudget:
    def test_a_document_that_outlasts_its_budget_is_reported_rather_than_abandoned(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The clock is driven rather than waited on. The module takes no clock to
        # inject, and a budget short enough for a two-page document to exceed is
        # shorter than the resolution `time.monotonic` has on Windows.
        clock = iter([0.0, 100.0])
        monkeypatch.setattr(time, "monotonic", lambda: next(clock, 100.0))

        document = _read_pdf(_pdf([[("One", 72.0, 720.0)], [("Two", 72.0, 720.0)]]))

        assert document.source is TextSource.none
        assert "taking too long" in document.notes[0]
        assert "0 of 2 pages" in document.notes[0]
        assert "entered by hand" in document.notes[0]


#: Every shape of input a caller has no business sending and will send anyway.
JUNK = [
    pytest.param(b"", id="empty"),
    pytest.param(b"\x00" * 1024, id="nuls"),
    pytest.param(bytes(range(256)) * 4, id="every-byte"),
    pytest.param(b"%PDF-1.7\n" + bytes(range(256)) * 8, id="pdf-header-then-rubbish"),
    pytest.param(
        b"%PDF-1.4\n1 0 obj\n" + b"<< /A " * 1000 + b">>" * 1000 + b"\nendobj\n",
        id="deeply-nested-dictionaries",
    ),
    pytest.param(
        b"%PDF-1.4\ntrailer << /Root 1 0 R >>\nstartxref\n999999999\n%%EOF\n",
        id="xref-pointing-past-the-end",
    ),
    pytest.param(b"\x89PNG\r\n\x1a\n" + b"\xff" * 128, id="png"),
    pytest.param(b"PK\x03\x04" + b"\xde\xad\xbe\xef" * 64, id="zip"),
    pytest.param(b"<?xml version='1.0'?><a>" + b"<b>" * 500, id="unclosed-xml"),
    pytest.param("\U0001f600 and a \x00 nul".encode("utf-16"), id="utf-16-with-a-nul"),
]


class TestReadDocumentNeverRaises:
    """The module's central guarantee, stated as a test rather than a docstring."""

    @pytest.mark.parametrize("data", JUNK)
    @pytest.mark.parametrize(
        "content_type", ["application/pdf", "text/plain", "text/csv", "image/png", ""]
    )
    def test_junk_of_any_kind_produces_a_reading_rather_than_an_exception(
        self, data: bytes, content_type: str
    ) -> None:
        assert isinstance(read_document(data, content_type=content_type), DocumentText)

    @pytest.mark.parametrize("data", JUNK)
    def test_junk_offered_as_a_pdf_is_refused_with_a_complete_sentence(self, data: bytes) -> None:
        document = _read_pdf(data)
        assert document.source is TextSource.none
        assert not document.has_text
        assert document.notes[0].endswith(".")

    @pytest.mark.parametrize("data", JUNK)
    def test_junk_offered_as_an_unsupported_type_is_never_opened_at_all(self, data: bytes) -> None:
        document = read_document(data, content_type="application/zip")
        assert document.pages == ()
        assert not document.has_exact_geometry

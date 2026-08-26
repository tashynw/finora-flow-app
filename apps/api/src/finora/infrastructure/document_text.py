"""Turning stored bytes into positioned text.

This is the only place in the platform that opens a document supplied by someone
outside it, which sets the rules for everything below.

It never raises. A document that is corrupt, encrypted, enormous or actively
hostile produces a `DocumentText` that says so in its notes, because the caller's
job is to record a reading attempt and show the reviewer what happened. An
exception escaping here would turn "this scan is unreadable, type the fields in"
into a failed request with nothing on the screen.

It is bounded in every dimension a document can grow. Pages read, words kept and
wall-clock time are all capped, and a document that exceeds any of them is
reported as partially read rather than allowed to occupy a worker indefinitely. A
PDF is a program in a stack language and a page can reference itself; the caps are
what stop that being this platform's problem.

Coordinates come out in visual space: origin top-left, y increasing downward,
page rotation already applied, measured in points. `pdfplumber` resolves `/Rotate`
into its coordinates and page size, and `pdf.js` in the browser does the same when
it builds a viewport, so the two agree without either side compensating. That is
why `PageText.rotation` stays zero here rather than carrying the raw `/Rotate`
value that a viewer would then apply a second time.
"""

from __future__ import annotations

import io
import time
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Final

import pdfplumber

from finora.domain.text_layout import (
    Box,
    DocumentText,
    PageText,
    TextSource,
    Word,
    build_lines,
)

#: Content types this module can read, mapped to how it reads them. Anything not
#: listed is reported as unreadable rather than guessed at by sniffing bytes,
#: because a reader chosen from content is a reader chosen by the attacker.
PDF_TYPES: Final[frozenset[str]] = frozenset({"application/pdf"})

TEXT_TYPES: Final[frozenset[str]] = frozenset(
    {
        "text/plain",
        "text/csv",
        "text/tab-separated-values",
    }
)

#: Word geometry is discarded beyond this count. A legitimate invoice page has a
#: few hundred words; a page with a hundred thousand is a generated document
#: whose only purpose is to exhaust whoever opens it.
_MAX_WORDS_PER_PAGE: Final[int] = 20_000

#: Plain text is split into pseudo-lines with synthetic geometry so that the same
#: line-matching rules work on it. The values are only ever used for ordering.
_SYNTHETIC_LINE_HEIGHT: Final[float] = 12.0
_SYNTHETIC_CHAR_WIDTH: Final[float] = 6.0

#: `pdfplumber` groups characters into words using these tolerances, in points.
#: The vertical figure is deliberately tight: a looser one merges a table row
#: with the row beneath it, and a total then carries the box of its neighbour.
_WORD_X_TOLERANCE: Final[float] = 1.5
_WORD_Y_TOLERANCE: Final[float] = 1.0


@dataclass(frozen=True, slots=True)
class ReadingLimits:
    """The ceilings a single reading attempt may not exceed."""

    #: Pages searched for values. Pages beyond this are still stored and can be
    #: opened in the viewer; they are simply not read, and the caller is told.
    max_pages: int = 10
    #: Wall-clock budget for the whole document.
    max_seconds: float = 20.0

    def __post_init__(self) -> None:
        if self.max_pages < 1:
            raise ValueError("At least one page must be readable.")
        if self.max_seconds <= 0:
            raise ValueError("A reading attempt needs a positive time budget.")


def unreadable(note: str) -> DocumentText:
    """A reading that produced nothing, and says why."""
    return DocumentText(source=TextSource.none, pages=(), notes=(note,))


def read_document(
    data: bytes,
    *,
    content_type: str,
    limits: ReadingLimits | None = None,
) -> DocumentText:
    """Read positioned text out of a document, or explain why there is none."""
    limits = limits or ReadingLimits()

    if not data:
        return unreadable("The file is empty, so there was nothing to read.")

    normalised = content_type.split(";")[0].strip().casefold()

    if normalised in PDF_TYPES:
        return _read_pdf(data, limits=limits)
    if normalised in TEXT_TYPES:
        return _read_text(data)

    return unreadable(
        f"Files of type '{normalised or 'unknown'}' cannot be read for values. "
        "The document is stored and can be opened, and its fields can be entered by hand."
    )


# --------------------------------------------------------------------- PDF


def _read_pdf(data: bytes, *, limits: ReadingLimits) -> DocumentText:
    deadline = time.monotonic() + limits.max_seconds
    pages: list[PageText] = []
    notes: list[str] = []

    try:
        # An empty password is not a bypass: it opens a document encrypted with
        # the standard security handler and no user password, which is how most
        # "protected" invoices are produced. A document with a real password
        # raises, and is reported rather than retried with guesses.
        with pdfplumber.open(io.BytesIO(data), password="") as pdf:
            total = len(pdf.pages)
            if total == 0:
                return unreadable("This PDF contains no pages.")

            if total > limits.max_pages:
                notes.append(
                    f"This document has {total} pages and the first {limits.max_pages} "
                    "were read for values. The remaining pages can be opened in the viewer."
                )

            for index, page in enumerate(pdf.pages[: limits.max_pages], start=1):
                if time.monotonic() > deadline:
                    notes.append(
                        f"Reading stopped after {index - 1} of {total} pages because the "
                        "document was taking too long. What was read is shown; the rest "
                        "needs to be entered by hand."
                    )
                    break
                pages.append(_read_pdf_page(page, number=index, notes=notes))

    # Deliberately broad. A document parser's failure modes are not enumerable:
    # see the module docstring for why none of them may escape this function.
    except Exception as error:
        return unreadable(_explain_pdf_failure(error))

    if not pages:
        detail = " ".join(notes)
        return unreadable(f"Nothing could be read from this PDF. {detail}".strip())

    document = DocumentText(source=TextSource.text_layer, pages=tuple(pages), notes=tuple(notes))

    if not document.has_text:
        # Every page opened and every page was blank. That is a scan: an image
        # of a document with no text layer behind it. Reported as a distinct
        # outcome from a broken file, because the two need different responses
        # from the reviewer and only one of them is worth retrying.
        return DocumentText(
            source=TextSource.none,
            pages=tuple(pages),
            notes=(
                *notes,
                "This PDF has pages but no text in them, so it is a scan or an "
                "image. Its values cannot be read without a recognition service.",
            ),
        )

    return document


def _read_pdf_page(page: pdfplumber.page.Page, *, number: int, notes: list[str]) -> PageText:
    try:
        extracted = page.extract_words(
            x_tolerance=_WORD_X_TOLERANCE,
            y_tolerance=_WORD_Y_TOLERANCE,
            keep_blank_chars=False,
            use_text_flow=False,
        )
    # One unreadable page is not a failed document. The rest are still worth
    # reading, and the reviewer is told which page was skipped.
    except Exception:
        notes.append(f"Page {number} could not be read and was skipped.")
        extracted = []

    if len(extracted) > _MAX_WORDS_PER_PAGE:
        notes.append(
            f"Page {number} contains an unusual amount of text and only the first "
            f"{_MAX_WORDS_PER_PAGE} words were read."
        )
        extracted = extracted[:_MAX_WORDS_PER_PAGE]

    words: list[Word] = []
    for item in extracted:
        word = _to_word(item)
        if word is not None:
            words.append(word)

    return PageText(
        number=number,
        width=float(page.width),
        height=float(page.height),
        words=tuple(words),
        lines=build_lines(words),
        # See the module docstring: pdfplumber has already resolved rotation into
        # these coordinates, so a viewer must not apply it again.
        rotation=0,
    )


def _to_word(item: dict[str, object]) -> Word | None:
    """One extracted word, or None when its geometry is unusable.

    A word with a negative or absent box is dropped rather than repaired. A
    highlight drawn from a repaired box points at the wrong part of the page,
    which is worse than no highlight at all because the reviewer trusts it.
    """
    text = str(item.get("text", "")).strip()
    if not text:
        return None

    try:
        x0 = float(item["x0"])  # type: ignore[arg-type]
        top = float(item["top"])  # type: ignore[arg-type]
        x1 = float(item["x1"])  # type: ignore[arg-type]
        bottom = float(item["bottom"])  # type: ignore[arg-type]
    except (KeyError, TypeError, ValueError):
        return None

    width = x1 - x0
    height = bottom - top
    if width < 0 or height < 0:
        return None

    return Word(text=text, box=Box(x=x0, y=top, width=width, height=height))


def _explain_pdf_failure(error: Exception) -> str:
    """Turn a parser exception into something a reviewer can act on.

    The whole chain is examined, not just the exception raised. `pdfplumber`
    wraps every parser failure in a single exception type, and the wrapper's
    message is empty for a wrong password, so read at the top alone a protected
    document is indistinguishable from a damaged one. The reviewer would be told
    to download a file that is not broken instead of to ask for an open copy.
    """
    for cause in _causes(error):
        name = type(cause).__name__.casefold()
        message = str(cause).casefold()
        if "password" in name or "password" in message or "encrypt" in message:
            return (
                "This PDF is password protected, so it could not be opened for reading. "
                "Ask the sender for an unprotected copy, or enter the fields by hand."
            )
    return (
        "This PDF could not be opened. It may be damaged or incomplete. "
        "The original is stored exactly as it arrived and can be downloaded."
    )


def _causes(error: BaseException) -> Iterator[BaseException]:
    """An exception and everything it was raised from, outermost first."""
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        current = current.__cause__ or current.__context__


# -------------------------------------------------------------------- text


def _read_text(data: bytes) -> DocumentText:
    """Read a plain-text or delimited file.

    Decoded permissively, because a CSV exported from a spreadsheet on a Windows
    machine is frequently not UTF-8 and refusing it would leave a readable
    document unread. Undecodable bytes become replacement characters, which are
    visible to the reviewer rather than silently dropped.

    A leading byte order mark is consumed rather than kept. A spreadsheet writes
    one, and a first cell beginning with an invisible character matches no label,
    which reads to a user as a missing field rather than as an encoding detail.
    """
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("cp1252", errors="replace")

    raw_lines = [line.rstrip() for line in text.splitlines()]
    if not any(line.strip() for line in raw_lines):
        return unreadable("This file contains no text.")

    words: list[Word] = []
    for row, line in enumerate(raw_lines):
        x = 0.0
        y = row * _SYNTHETIC_LINE_HEIGHT
        for token in line.split():
            width = len(token) * _SYNTHETIC_CHAR_WIDTH
            words.append(
                Word(
                    text=token,
                    box=Box(x=x, y=y, width=width, height=_SYNTHETIC_LINE_HEIGHT),
                )
            )
            x += width + _SYNTHETIC_CHAR_WIDTH
        if len(words) > _MAX_WORDS_PER_PAGE:
            break

    page = PageText(
        number=1,
        width=max((word.box.right for word in words), default=0.0),
        height=len(raw_lines) * _SYNTHETIC_LINE_HEIGHT,
        words=tuple(words),
        lines=build_lines(words),
    )

    return DocumentText(
        source=TextSource.plain_text,
        pages=(page,),
        notes=(
            "This is a text file, so the values read from it have no position on a "
            "page and cannot be highlighted.",
        ),
    )

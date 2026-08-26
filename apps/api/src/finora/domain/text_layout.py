"""Where words sit on a page.

Extraction needs geometry, not just text. A total that a reviewer cannot point
at on the page is an assertion; the same total with a rectangle around it is
evidence, and evidence is what makes a correction a two-second check instead of
a full re-read of the document.

So the text model here is deliberately positional. Words carry boxes, lines are
assembled from words rather than taken from a stream, and every search returns
what matched along with where it was. Nothing downstream has to guess where a
value came from, because the value never travels without its location.

Coordinates are points with the origin at the top-left of the page, which is how
a viewer draws and not how PDF user space is defined. The conversion happens once,
at the boundary where text is read, so that no consumer has to remember which way
up a rectangle is.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from enum import StrEnum
from typing import Final


class TextSource(StrEnum):
    """How the text of a document was obtained.

    This is not a detail. Text read from a PDF's own text layer is exactly what
    the author wrote and its coordinates are exact. Text recognised from pixels
    is a reading of an image, and both the characters and their positions are
    estimates. A field extracted from the second kind can never carry the same
    confidence as one extracted from the first, so the distinction is carried
    everywhere rather than flattened into "we have some text".
    """

    #: The document's embedded text layer. Exact characters, exact geometry.
    text_layer = "text_layer"
    #: Recognised from an image of the page by a model. Approximate.
    vision = "vision"
    #: A plain-text or delimited file. Exact characters, no geometry at all.
    plain_text = "plain_text"
    #: No text could be obtained. Nothing may be extracted from this.
    none = "none"


#: Sources whose coordinates can be drawn on a page with confidence.
EXACT_GEOMETRY_SOURCES: Final[frozenset[TextSource]] = frozenset({TextSource.text_layer})


@dataclass(frozen=True, slots=True)
class Box:
    """A rectangle on a page, in points, measured from the top-left corner."""

    x: float
    y: float
    width: float
    height: float

    def __post_init__(self) -> None:
        if self.width < 0 or self.height < 0:
            raise ValueError("A box cannot have negative width or height.")

    @property
    def right(self) -> float:
        return self.x + self.width

    @property
    def bottom(self) -> float:
        return self.y + self.height

    @property
    def centre_y(self) -> float:
        return self.y + self.height / 2

    def union(self, other: Box) -> Box:
        x = min(self.x, other.x)
        y = min(self.y, other.y)
        return Box(
            x=x,
            y=y,
            width=max(self.right, other.right) - x,
            height=max(self.bottom, other.bottom) - y,
        )

    def padded(self, amount: float) -> Box:
        """Grown by a small margin, so a highlight does not clip the glyphs.

        Clamped at zero rather than allowed to go negative, because a box that
        starts off the page draws in the wrong place instead of failing.
        """
        return Box(
            x=max(self.x - amount, 0.0),
            y=max(self.y - amount, 0.0),
            width=self.width + amount * 2,
            height=self.height + amount * 2,
        )


@dataclass(frozen=True, slots=True)
class Word:
    """One whitespace-delimited run of characters and the space it occupies."""

    text: str
    box: Box


@dataclass(frozen=True, slots=True)
class TextLine:
    """Words that a reader would see as one line.

    Assembled from word positions rather than taken from the document's own
    stream order, because a PDF is free to emit a page's characters in any order
    it likes. A table row and its heading frequently arrive far apart, and label
    matching is worthless if "Invoice number" and its value are not on the same
    line as far as the code is concerned.
    """

    words: tuple[Word, ...]

    def __post_init__(self) -> None:
        if not self.words:
            raise ValueError("A line must contain at least one word.")

    @property
    def text(self) -> str:
        return " ".join(word.text for word in self.words)

    @property
    def box(self) -> Box:
        box = self.words[0].box
        for word in self.words[1:]:
            box = box.union(word.box)
        return box

    def words_from(self, index: int) -> tuple[Word, ...]:
        return self.words[index:]

    def box_of(self, words: tuple[Word, ...] | list[Word]) -> Box | None:
        if not words:
            return None
        box = words[0].box
        for word in words[1:]:
            box = box.union(word.box)
        return box


@dataclass(frozen=True, slots=True)
class PageText:
    """One page: its size, and the words on it."""

    number: int
    width: float
    height: float
    words: tuple[Word, ...]
    lines: tuple[TextLine, ...]
    #: Reported by the document. A viewer applies it, so highlight coordinates
    #: are stored unrotated and rotate with the page rather than drifting.
    rotation: int = 0

    @property
    def text(self) -> str:
        return "\n".join(line.text for line in self.lines)

    @property
    def is_empty(self) -> bool:
        return not self.words


@dataclass(frozen=True, slots=True)
class DocumentText:
    """Everything readable in a document, page by page."""

    source: TextSource
    pages: tuple[PageText, ...]
    #: What could not be read. Present so a partial reading is visibly partial
    #: rather than quietly short.
    notes: tuple[str, ...] = ()

    @property
    def text(self) -> str:
        return "\n".join(page.text for page in self.pages)

    @property
    def page_count(self) -> int:
        return len(self.pages)

    @property
    def has_text(self) -> bool:
        return any(not page.is_empty for page in self.pages)

    @property
    def has_exact_geometry(self) -> bool:
        return self.source in EXACT_GEOMETRY_SOURCES

    def page(self, number: int) -> PageText | None:
        for page in self.pages:
            if page.number == number:
                return page
        return None

    def lines(self) -> list[tuple[PageText, TextLine]]:
        return [(page, line) for page in self.pages for line in page.lines]


# ------------------------------------------------------------- line assembly

#: Two words belong to the same line when their vertical centres are within
#: this fraction of the taller word's height. A fraction rather than a fixed
#: number of points, so the same rule works for an 8pt footnote and a 24pt
#: heading without a table of exceptions.
_LINE_TOLERANCE_RATIO: Final[float] = 0.6


def build_lines(words: list[Word] | tuple[Word, ...]) -> tuple[TextLine, ...]:
    """Group words into visual lines, left to right and top to bottom."""
    if not words:
        return ()

    ordered = sorted(words, key=lambda w: (round(w.box.centre_y, 1), w.box.x))

    groups: list[list[Word]] = []
    for word in ordered:
        placed = False
        if groups:
            current = groups[-1]
            reference = current[-1]
            tolerance = max(reference.box.height, word.box.height) * _LINE_TOLERANCE_RATIO
            if abs(word.box.centre_y - reference.box.centre_y) <= tolerance:
                current.append(word)
                placed = True
        if not placed:
            groups.append([word])

    return tuple(TextLine(words=tuple(sorted(group, key=lambda w: w.box.x))) for group in groups)


# ------------------------------------------------------------- normalisation

_WHITESPACE = re.compile(r"\s+")

#: Characters a document producer uses interchangeably with their ASCII
#: equivalents. Left in place they turn an exact label match into a miss, and a
#: miss reads to a user as "the system could not find the invoice number" when
#: the real cause is a typographic dash.
_LOOKALIKES: Final[dict[str, str]] = {
    "\u2018": "'",
    "\u2019": "'",
    "\u201c": '"',
    "\u201d": '"',
    "\u2010": "-",
    "\u2011": "-",
    "\u2012": "-",
    "\u2013": "-",
    "\u2014": "-",
    "\u2212": "-",
    "\u00a0": " ",
    "\u202f": " ",
    "\u2009": " ",
    "\ufb01": "fi",
    "\ufb02": "fl",
}

_LOOKALIKE_TABLE = str.maketrans(_LOOKALIKES)


def normalise(text: str) -> str:
    """Fold a document's text into a form that can be matched reliably.

    Case, accents and typographic punctuation are levelled, and runs of
    whitespace collapse to one space. This is only ever used for finding things;
    the verbatim text is what gets stored and shown, because a reviewer needs to
    see what the document actually says.
    """
    folded = unicodedata.normalize("NFKC", text).translate(_LOOKALIKE_TABLE)
    return _WHITESPACE.sub(" ", folded).strip().casefold()

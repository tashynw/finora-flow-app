"""Deciding what a document is.

A document's kind determines which fields are required, which workflow it can
enter and what "complete" means, so getting it wrong is not a cosmetic error: a
quotation misread as an invoice enters the payment path, and an invoice misread as
a quotation is never paid until the vendor calls.

The rule is therefore conservative. A kind is only claimed when the document says
so near the top of its first page, where every real business document puts its
title. Supporting words further down can raise a weak reading, but never create
one on their own, because "invoice" appears in the small print of a quotation as
often as it appears on an invoice. When two kinds are equally well evidenced, or
none is, the answer is `unknown` and a person decides.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final

from finora.domain.extraction import (
    DocumentKind,
    Evidence,
    MatchQuality,
    combine_confidence,
)
from finora.domain.text_layout import DocumentText, PageText, TextLine, normalise

#: Titles are at the top of a page. Searching the whole page instead would find
#: the word "invoice" in a quotation's terms and conditions and treat it as the
#: document's own title.
_TITLE_BAND: Final[float] = 0.38

#: A title is short. Requiring that keeps a sentence containing the word from
#: being mistaken for a heading consisting of it.
_MAX_TITLE_WORDS: Final[int] = 6


@dataclass(frozen=True, slots=True)
class KindRule:
    kind: DocumentKind
    #: Matched against a short line near the top of page one.
    title: re.Pattern[str]
    #: Matched anywhere. Raises a title match's confidence, never stands alone.
    supporting: tuple[re.Pattern[str], ...] = ()
    note: str | None = None


def _p(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern)


#: Order matters only for tie-breaking within a kind's own patterns; across kinds
#: the score decides, and an equal score is reported as undecided rather than
#: resolved by the order these happen to be written in.
KIND_RULES: Final[tuple[KindRule, ...]] = (
    # Checked before the plain invoice rule below by virtue of being a longer,
    # more specific title. A pro forma is a request for payment in advance, not a
    # final invoice for a completed supply, so it belongs in the estimate path
    # where it gets approved before money moves.
    KindRule(
        kind=DocumentKind.estimate,
        title=_p(r"\bpro[ -]?forma\b"),
        supporting=(_p(r"\bvalid (for|until)\b"), _p(r"\badvance payment\b")),
        note=(
            "This is a pro forma invoice: a request for payment in advance rather "
            "than a final invoice. It is treated as an estimate so that it is "
            "approved before anything is paid."
        ),
    ),
    KindRule(
        kind=DocumentKind.credit_note,
        title=_p(r"\bcredit (note|memo|memorandum)\b"),
        supporting=(_p(r"\bcredit (applied|balance)\b"),),
    ),
    KindRule(
        kind=DocumentKind.invoice,
        title=_p(r"\b(tax |sales |commercial )?invoice\b"),
        supporting=(
            _p(r"\b(amount|balance|total) due\b"),
            _p(r"\b(payment )?terms\b"),
            _p(r"\bremit(tance)? to\b"),
            _p(r"\bdue date\b"),
        ),
    ),
    KindRule(
        kind=DocumentKind.estimate,
        title=_p(r"\b(quotation|quote|estimate|proposal)\b"),
        supporting=(
            _p(r"\b(valid|quotation valid) (for|until|through)\b"),
            _p(r"\bthis is not an invoice\b"),
            _p(r"\bto accept this (quote|quotation|estimate)\b"),
        ),
    ),
    KindRule(
        kind=DocumentKind.purchase_order,
        title=_p(r"\bpurchase order\b"),
        supporting=(_p(r"\bship to\b"), _p(r"\bdeliver(y)? date\b")),
    ),
    KindRule(
        kind=DocumentKind.receipt,
        title=_p(r"\b(receipt|payment receipt|cash receipt)\b"),
        supporting=(_p(r"\b(paid|payment received|thank you for your payment)\b"),),
    ),
    KindRule(
        kind=DocumentKind.statement,
        title=_p(r"\bstatement( of account)?\b"),
        supporting=(
            _p(r"\b(opening|closing) balance\b"),
            _p(r"\baging\b"),
            _p(r"\b\d{1,3} days?\b"),
        ),
    ),
    KindRule(
        kind=DocumentKind.remittance_advice,
        title=_p(r"\bremittance advice\b"),
        supporting=(_p(r"\bpayment reference\b"),),
    ),
)


@dataclass(frozen=True, slots=True)
class Classification:
    kind: DocumentKind
    confidence: float
    evidence: Evidence | None
    #: Kinds that scored equally. Present so the reviewer is told what the real
    #: choice is instead of being handed "not identified" with no explanation.
    contenders: tuple[DocumentKind, ...] = ()
    notes: tuple[str, ...] = ()


def _title_lines(page: PageText) -> list[TextLine]:
    """Short lines in the upper band of a page, longest text first.

    Longest first because a document that carries both a heading and a strapline
    should be judged on the heading; a two-word line is a title far more often
    than a six-word one, but the six-word one is worth checking when nothing
    shorter matches.
    """
    if page.height <= 0:
        return []
    cutoff = page.height * _TITLE_BAND
    candidates = [
        line for line in page.lines if line.box.y <= cutoff and len(line.words) <= _MAX_TITLE_WORDS
    ]
    return sorted(candidates, key=lambda line: len(line.words))


def classify(text: DocumentText) -> Classification:
    """Decide the kind of a document from its own title and wording."""
    if not text.pages or not text.has_text:
        return Classification(
            kind=DocumentKind.unknown,
            confidence=0.0,
            evidence=None,
            notes=("There was no readable text to identify this document from.",),
        )

    first = text.pages[0]
    whole = normalise(text.text)
    titles = _title_lines(first)

    scored: dict[DocumentKind, tuple[float, Evidence, tuple[str, ...]]] = {}

    for rule in KIND_RULES:
        hit = next((line for line in titles if rule.title.search(normalise(line.text))), None)
        if hit is None:
            continue

        support = sum(1 for pattern in rule.supporting if pattern.search(whole))
        # A title is already strong evidence. Supporting words add a little and
        # cannot push the reading to certainty on their own, because their whole
        # purpose is corroboration.
        confidence = (
            combine_confidence(MatchQuality.labelled)
            if support
            else combine_confidence(MatchQuality.nearby_label)
        )
        evidence = Evidence(
            page_number=first.number,
            snippet=hit.text,
            boxes=(hit.box.padded(2.0),),
        )
        notes = (rule.note,) if rule.note else ()

        existing = scored.get(rule.kind)
        if existing is None or confidence > existing[0]:
            scored[rule.kind] = (confidence, evidence, notes)

    if not scored:
        return Classification(
            kind=DocumentKind.unknown,
            confidence=0.0,
            evidence=None,
            notes=(
                "No document title such as Invoice, Quotation or Credit note was "
                "found near the top of the first page.",
            ),
        )

    best = max(scored.values(), key=lambda item: item[0])[0]
    leaders = [kind for kind, item in scored.items() if item[0] == best]

    if len(leaders) > 1:
        # Two titles with equal standing. Choosing either would be a coin toss
        # dressed as a decision, and the cost of the wrong choice is a quotation
        # in the payment queue.
        return Classification(
            kind=DocumentKind.unknown,
            confidence=0.0,
            evidence=scored[leaders[0]][1],
            contenders=tuple(sorted(leaders)),
            notes=(
                "This document carries more than one title, so what it is cannot "
                "be decided from the document alone.",
            ),
        )

    kind = leaders[0]
    confidence, located, explanation = scored[kind]
    return Classification(kind=kind, confidence=confidence, evidence=located, notes=explanation)

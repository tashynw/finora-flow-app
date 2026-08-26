"""Reading an invoice the way a person reads one: by looking for the labels.

This is the deterministic half of extraction, and it runs first on every document.
It is not a fallback for when the model is unavailable; the model is the fallback
for what this could not find. A labelled value found here is repeatable, costs
nothing, can be pointed at on the page, and fails visibly when the document
changes shape. None of those things is true of a generated answer.

Matching is done word by word rather than with a regular expression over the
line's text, and that choice does real work. `Subtotal` and `Total` are different
words but one contains the other, so a pattern looking for "total" in a line of
text finds the subtotal and reports it as the amount payable. Word-level matching
cannot make that mistake, and it also yields the exact boxes of the words that
matched, which is what a highlight needs.

Rules are applied in order of specificity, and a line consumed by one field is not
offered to another. `Total tax` belongs to the tax field, and once taken it cannot
also be read as the total.

Every value carries why it is trusted as little or as much as it is. The reviewer
who asks "why does this say 62%" gets "the label was two lines away, the date could
be read two ways, and the page is a scan" rather than a number.
"""

from __future__ import annotations

import re
from collections.abc import Container, Mapping
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Final

from finora.domain.classification import KIND_RULES
from finora.domain.extraction import (
    AMBIGUOUS_AMOUNT,
    AMBIGUOUS_DATE,
    ARITHMETIC_AGREES,
    ARITHMETIC_DISAGREES,
    BASE_CONFIDENCE,
    FIELD_VALUE_KINDS,
    INJECTION_SUSPECTED,
    MODEL_PROPOSAL_CONFIDENCE,
    MULTIPLE_CURRENCIES,
    VISION_PENALTY,
    ConfidenceAdjustment,
    DocumentKind,
    DocumentSignal,
    Evidence,
    ExtractionResult,
    FieldCandidate,
    FieldName,
    FieldOrigin,
    MatchQuality,
    ValueKind,
    absent,
    adjusted_confidence,
    combine_confidence,
    find_evidence,
    money_from_text,
    required_fields,
    scan_for_injection,
)
from finora.domain.text_layout import (
    Box,
    DocumentText,
    PageText,
    TextLine,
    TextSource,
    Word,
    normalise,
)
from finora.domain.value_parsing import (
    CurrencyReading,
    detect_currency,
    parse_amount,
    parse_date,
)

# ---------------------------------------------------------------- label rules


@dataclass(frozen=True, slots=True)
class LabelRule:
    """How one field is labelled on a document.

    Labels are phrases, and a phrase matches only when its words appear
    consecutively. `reject` names phrases whose presence on a line means the line
    belongs to a different field, which is how "Total tax" is kept out of the
    total and "Tax registration" out of the tax amount.
    """

    name: FieldName
    labels: tuple[str, ...]
    reject: tuple[str, ...] = ()
    #: Whether a value may be taken from the line beneath the label. True for
    #: fields printed in a column with a heading above them, false where the line
    #: below is more likely to be an unrelated row.
    allow_below: bool = True


#: Ordered most specific first. A rule earlier in this tuple claims its line
#: before a later, broader rule can see it, so the order is a correctness
#: property and not a preference.
LABEL_RULES: Final[tuple[LabelRule, ...]] = (
    LabelRule(
        name=FieldName.vendor_tax_id,
        labels=(
            "taxpayer registration number",
            "tax registration number",
            "tax registration",
            "trn",
            "vat registration",
            "vat registration number",
            "vat number",
            "gst number",
            "tax identification number",
            "tax id",
            "ein",
        ),
        allow_below=False,
    ),
    LabelRule(
        name=FieldName.purchase_order_number,
        labels=(
            "purchase order number",
            "purchase order",
            "po number",
            "po no",
            "p o number",
            "customer po",
            "your order number",
            "your order",
            "order number",
        ),
        reject=("sales order",),
    ),
    LabelRule(
        name=FieldName.estimate_reference,
        labels=(
            "quotation reference",
            "estimate reference",
            "quote reference",
            "against quotation",
            "as per quotation",
            "proposal number",
        ),
    ),
    LabelRule(
        name=FieldName.due_date,
        labels=(
            "payment due date",
            "due date",
            "date due",
            "payment due",
            "pay by",
            "due on",
            "payable by",
        ),
    ),
    LabelRule(
        name=FieldName.document_date,
        labels=(
            "invoice date",
            "date of issue",
            "issue date",
            "issued on",
            "document date",
            "quotation date",
            "estimate date",
            "date",
        ),
        # "Date" alone is the loosest label on this list, so every other kind of
        # date on the page has to be excluded explicitly or it will be read as
        # the document's own date.
        reject=(
            "due date",
            "delivery date",
            "ship date",
            "shipping date",
            "order date",
            "date received",
            "period",
            "expiry",
            "expiry date",
            "valid until",
            "date paid",
        ),
    ),
    LabelRule(
        name=FieldName.tax_total,
        labels=(
            "total tax",
            "tax total",
            "general consumption tax",
            "gct",
            "sales tax",
            "vat amount",
            "vat",
            "gst",
            "tax amount",
            "tax",
        ),
        reject=(
            "tax registration",
            "tax id",
            "tax identification",
            "taxpayer",
            "trn",
            "tax invoice",
            "excluding tax",
            "before tax",
            "net of tax",
        ),
    ),
    LabelRule(
        name=FieldName.subtotal,
        labels=(
            "subtotal",
            "sub total",
            "sub-total",
            "net amount",
            "amount before tax",
            "total excluding tax",
            "total before tax",
            "goods total",
            "taxable amount",
        ),
    ),
    LabelRule(
        name=FieldName.total,
        labels=(
            "total amount due",
            "total amount payable",
            "balance due",
            "amount due",
            "total due",
            "grand total",
            "invoice total",
            "total payable",
            "total including tax",
            "total inclusive of tax",
            "net payable",
            "total",
        ),
        reject=(
            "subtotal",
            "sub total",
            "sub-total",
            "total tax",
            "tax total",
            "total excluding tax",
            "total before tax",
            "amount paid",
            "total paid",
            "previous balance",
            "total quantity",
            "total items",
        ),
    ),
    LabelRule(
        name=FieldName.document_number,
        labels=(
            "invoice number",
            "invoice no",
            "invoice num",
            "tax invoice number",
            "credit note number",
            "quotation number",
            "quote number",
            "estimate number",
            "document number",
            "reference number",
            "our reference",
            "invoice",
            "reference",
        ),
        reject=(
            "purchase order",
            "po number",
            "order number",
            "account number",
            "customer number",
            "vat number",
            "tax registration",
            "trn",
            "page",
        ),
    ),
    LabelRule(
        name=FieldName.payment_terms,
        labels=("payment terms", "terms of payment", "terms"),
        reject=("terms and conditions", "terms & conditions"),
        allow_below=False,
    ),
    LabelRule(
        name=FieldName.vendor_name,
        labels=(
            "vendor name",
            "supplier name",
            "vendor",
            "supplier",
            "sold by",
            "bill from",
            "from",
            "company name",
        ),
        # "remit to" is absent from the labels above on purpose. It introduces the
        # account a payment should go to, which is not the same thing as the
        # supplier of record, and a document that redirects payment says exactly
        # that phrase. The vendor is decided against the vendor master.
        reject=("bill to", "ship to", "sold to", "invoice to", "customer"),
    ),
)

#: Words that sit between a label and its value and carry no meaning of their own.
#: Skipped so that "Invoice No. : 4471" and "Invoice 4471" reach the same value.
_SEPARATORS: Final[frozenset[str]] = frozenset(
    {":", "-", "--", "#", "no", "no.", "num", "num.", "number", "is", "=", ".", "|"}
)

#: Trailing punctuation carried by a word that is not part of it.
_EDGE_PUNCTUATION: Final[str] = " \t:;,.#|()[]<>\"'"

#: The same, for amounts, and deliberately narrower. A printed ledger writes a
#: negative as `(5,000.00)` or `5,000.00-`, so stripping brackets and minus signs
#: here would turn a credit note into an invoice for the same figure.
_MONEY_EDGE_PUNCTUATION: Final[str] = " \t:;,.|\"'"

#: Words a value must not consist of. A label followed immediately by the next
#: label is a label with no value, not a value called "date".
_NOT_A_VALUE: Final[frozenset[str]] = frozenset(
    {"", "n/a", "na", "none", "nil", "-", "--", "tbd", "tba", "to be advised"}
)

#: How far below a label a value may be found. One line, because a column heading
#: sits directly above its first cell and anything further down is a different row.
_MAX_LINES_BELOW: Final[int] = 1

#: Every phrase any rule treats as a label.
#:
#: Used to recognise that a line is a labelled line rather than a bare value, which
#: is what stops the document's own title being read as a label for whatever
#: follows it. "TAX INVOICE" as a heading matches the loose `invoice` label, and
#: without this the line beneath the title becomes the invoice number — so an
#: invoice whose next line is "Supplier Name: Kingston Supplies Limited" acquires
#: that entire string as its document number.
_ALL_LABELS: Final[frozenset[str]] = frozenset(
    label for rule in LABEL_RULES for label in rule.labels
)


# --------------------------------------------------------------- bank details

#: Payment instructions on a document. Their presence is reported so a person
#: verifies them against the vendor master through a channel they already trust.
#: They are never read into a field, because a field can be used to pay someone.
_BANK_MARKERS: Final[tuple[re.Pattern[str], ...]] = (
    re.compile(r"\b(bank|branch) (name|code|address)\b"),
    re.compile(r"\baccount (number|name|no)\b"),
    re.compile(r"\b(iban|swift|bic|sort code|routing number|aba)\b"),
    re.compile(r"\b(wire|bank) transfer (details|instructions)?\b"),
    re.compile(r"\bpay(ment)? (into|to) (the )?(following|our) account\b"),
    re.compile(r"\bdirect deposit\b"),
)


def mentions_bank_details(text: str) -> bool:
    normalised = normalise(text)
    return any(marker.search(normalised) for marker in _BANK_MARKERS)


# ------------------------------------------------------------------ reading


@dataclass(slots=True)
class _Reading:
    """A located value before it has been typed or scored."""

    text: str
    quality: MatchQuality
    evidence: Evidence


@dataclass(frozen=True, slots=True)
class Proposal:
    """A value a model proposed, already verified to exist in the document.

    Verification is the gateway's job and has happened before this arrives: the
    text is known to appear on the page and the evidence is where. What remains
    unverified, and is the whole reason a proposal is scored below any review
    threshold, is the model's claim that this text is *this field*.
    """

    text: str
    evidence: Evidence


def read_fields(
    document: DocumentText,
    *,
    kind: DocumentKind,
    proposals: Mapping[FieldName, Proposal] | None = None,
) -> ExtractionResult:
    """Read every field this document type needs, and say what is wrong with it.

    Returns a complete result whatever happens, including for a document with no
    text at all, because the caller records an attempt either way and the reviewer
    is owed an explanation rather than an empty screen.

    `proposals` lets a caller re-read the same document with a model's answers in
    hand. Re-reading rather than patching the first result is deliberate: the
    cross-checks and the missing-field signals are computed from the full field
    set, so a proposal that supplies the last absent total has to be present
    before they run or the result would still claim the total is missing. Reading
    is a pure function of already-parsed text, so the second pass costs nothing
    that matters.
    """
    result = ExtractionResult(
        kind=kind,
        kind_confidence=0.0,
        kind_evidence=None,
        text_source=document.source,
        page_count=document.page_count,
    )

    if document.source is TextSource.none or not document.has_text:
        result.add_signal(DocumentSignal.no_text_layer)
        result.notes.extend(document.notes)
        for name in required_fields(kind):
            result.fields[name] = absent(name, "Nothing could be read from this document.")
        if required_fields(kind):
            result.add_signal(DocumentSignal.required_field_missing)
        return result

    result.notes.extend(document.notes)

    # Document-wide observations first, because several of them adjust the
    # confidence of individual values found afterwards.
    document_adjustments: list[ConfidenceAdjustment] = []

    findings = scan_for_injection(document.text)
    if findings:
        result.injection_findings = findings
        result.add_signal(DocumentSignal.prompt_injection_suspected)
        document_adjustments.append(
            ConfidenceAdjustment(
                reason="the document contains text written to instruct an automated reader",
                delta=INJECTION_SUSPECTED,
            )
        )

    if mentions_bank_details(document.text):
        result.add_signal(DocumentSignal.bank_details_present)

    if document.source is TextSource.vision:
        document_adjustments.append(
            ConfidenceAdjustment(
                reason="the text was recognised from an image of the page rather than read",
                delta=VISION_PENALTY,
            )
        )

    currency = detect_currency(document.text)
    if currency.is_ambiguous and len(set(currency.found)) > 1:
        result.add_signal(DocumentSignal.multiple_currencies)
        document_adjustments.append(
            ConfidenceAdjustment(
                reason="more than one currency appears on the document",
                delta=MULTIPLE_CURRENCIES,
            )
        )

    readings = _locate_all(document)

    for rule in LABEL_RULES:
        reading = readings.get(rule.name)
        if reading is None:
            continue
        candidate = _build_candidate(
            reading,
            name=rule.name,
            currency_code=currency.code,
            document_adjustments=document_adjustments,
            result=result,
        )
        if candidate is not None:
            result.fields[rule.name] = candidate

    _apply_currency_field(result, document, currency, document_adjustments)
    _fall_back_to_letterhead(result, document, document_adjustments)
    _apply_proposals(
        result,
        proposals or {},
        currency_code=currency.code,
        document_adjustments=document_adjustments,
    )
    _cross_check_amounts(result)
    _cross_check_dates(result)
    _record_absences(result, kind=kind)

    return result


# ------------------------------------------------------------------ locating


#: Which words of each line an earlier rule has already read, keyed by page number
#: and line index.
#:
#: Word by word rather than line by line, because reading a PDF gives one line per
#: visual row, and a row such as `Invoice Number: INV-4471   Invoice Date:
#: 2026-03-15` arrives as a single line carrying two fields. Claiming whole lines
#: would let whichever rule reached that row first hide the other field entirely.
_Claims = dict[tuple[int, int], set[int]]


def _locate_all(document: DocumentText) -> dict[FieldName, _Reading]:
    """Find each field's value, giving earlier rules first claim on a row."""
    claims: _Claims = {}
    found: dict[FieldName, _Reading] = {}

    for rule in LABEL_RULES:
        reading = _locate(document, rule, claims)
        if reading is not None:
            found[rule.name] = reading

    return found


def _locate(document: DocumentText, rule: LabelRule, claims: _Claims) -> _Reading | None:
    kind = FIELD_VALUE_KINDS[rule.name]

    for page in document.pages:
        for index, line in enumerate(page.lines):
            key = (page.number, index)
            taken = claims.get(key, set())
            if len(taken) >= len(line.words):
                continue

            normalised_line = normalise(line.text)
            if any(_phrase_in(normalised_line, phrase) for phrase in rule.reject):
                continue

            span = _label_span(line, rule.labels, taken=taken)
            if span is None:
                continue

            _, after = span
            words = _skip_separators(line.words_from(after))
            start = len(line.words) - len(words)
            # The value ends where the next caption begins, or where an earlier
            # rule's reading begins, whichever comes first.
            end = min(
                _next_caption(line, after=start),
                min((word for word in taken if word >= start), default=len(line.words)),
            )
            reading = _value_from(words[: end - start], line=line, page=page, kind=kind)
            if reading is not None:
                # The caption and everything up to the next one are spent, whether
                # or not the value itself used all of it.
                claims[key] = taken | set(range(span[0], span[1])) | set(range(start, end))
                return reading

            if not rule.allow_below:
                continue

            below = _read_below(page, index, kind=kind, claims=claims)
            if below is not None:
                # A heading and the cell beneath it are both spent: neither is a
                # row another field can read a second value out of.
                claims[key] = set(range(len(line.words)))
                claims[(page.number, index + 1)] = set(range(len(page.lines[index + 1].words)))
                return below

    return None


def _read_below(
    page: PageText,
    index: int,
    *,
    kind: ValueKind,
    claims: _Claims,
) -> _Reading | None:
    """A value printed under its heading rather than beside it."""
    for offset in range(1, _MAX_LINES_BELOW + 1):
        position = index + offset
        if position >= len(page.lines) or claims.get((page.number, position)):
            return None
        line = page.lines[position]
        # A cell under a heading contains a value and nothing else. A line that
        # carries a label of its own is a labelled line, and it will be read
        # correctly when the scan reaches it in its own right.
        if _carries_a_label(line):
            return None
        reading = _value_from(line.words, line=line, page=page, kind=kind)
        if reading is not None:
            # Downgraded because a heading above a value is weaker evidence than
            # a label beside it: the association is inferred from layout.
            return _Reading(
                text=reading.text,
                quality=MatchQuality.nearby_label,
                evidence=reading.evidence,
            )
    return None


def _value_from(
    words: tuple[Word, ...],
    *,
    line: TextLine,
    page: PageText,
    kind: ValueKind,
) -> _Reading | None:
    """Pull a value of the expected shape out of the words after a label."""
    if not words:
        return None

    if kind is ValueKind.money:
        return _money_from(words, line=line, page=page)
    if kind is ValueKind.date:
        return _date_from(words, line=line, page=page)
    return _text_from(words, line=line, page=page)


def _money_from(words: tuple[Word, ...], *, line: TextLine, page: PageText) -> _Reading | None:
    """The rightmost amount after the label.

    Rightmost because an invoice prints its labels on the left and its figures in
    a right-aligned column, and a line frequently carries a quantity or a unit
    price before the amount that matters.
    """
    for word in reversed(words):
        cleaned = word.text.strip(_MONEY_EDGE_PUNCTUATION)
        if parse_amount(cleaned) is None:
            continue
        box = line.box_of((word,))
        return _Reading(
            text=cleaned,
            quality=MatchQuality.labelled,
            evidence=_evidence(page, line, box),
        )
    return None


def _date_from(words: tuple[Word, ...], *, line: TextLine, page: PageText) -> _Reading | None:
    """A date after the label, taken from the shortest run of words that is one.

    A run rather than a single word, because "3 April 2026" is three words and
    only means anything together.
    """
    for start in range(len(words)):
        for end in range(start + 1, min(start + 4, len(words)) + 1):
            run = words[start:end]
            text = " ".join(word.text for word in run).strip(_EDGE_PUNCTUATION)
            if parse_date(text) is None:
                continue
            return _Reading(
                text=text,
                quality=MatchQuality.labelled,
                evidence=_evidence(page, line, line.box_of(run)),
            )
    return None


def _text_from(words: tuple[Word, ...], *, line: TextLine, page: PageText) -> _Reading | None:
    text = " ".join(word.text for word in words).strip(_EDGE_PUNCTUATION)
    if normalise(text) in _NOT_A_VALUE:
        return None
    return _Reading(
        text=text,
        quality=MatchQuality.labelled,
        evidence=_evidence(page, line, line.box_of(words)),
    )


def _evidence(page: PageText, line: TextLine, box: Box | None) -> Evidence:
    return Evidence(
        page_number=page.number,
        snippet=line.text,
        boxes=(box.padded(1.5),) if box else (),
    )


# ------------------------------------------------------------ word matching


def _normalised_words(line: TextLine) -> list[str]:
    return [normalise(word.text).strip(_EDGE_PUNCTUATION) for word in line.words]


def _label_span(
    line: TextLine,
    labels: tuple[str, ...],
    *,
    taken: Container[int] = frozenset(),
) -> tuple[int, int] | None:
    """Where this field's caption sits on this line, if it carries one.

    Longest label first, so "invoice number" is preferred over "invoice" on a line
    that carries both and the value is taken from after the whole phrase. Earliest
    occurrence of that label, so a row carrying two captions is read from the first
    of them rather than the last.

    Words an earlier rule has already read are not available to be read again.
    """
    words = _normalised_words(line)

    for label in sorted(labels, key=lambda phrase: -len(phrase.split())):
        phrase = label.split()
        for start in range(len(words) - len(phrase) + 1):
            if words[start : start + len(phrase)] != phrase:
                continue
            end = start + len(phrase)
            if any(word in taken for word in range(start, end)):
                continue
            # Scanning continues past a match that is prose rather than a caption,
            # because the same words may appear as a real caption further along the
            # same row.
            if _reads_as_a_caption(line, start=start, end=end):
                return start, end

    return None


def _next_caption(line: TextLine, *, after: int) -> int:
    """Index of the first caption at or after `after`, or the end of the line."""
    normalised = _normalised_words(line)

    for index in range(after, len(normalised)):
        for label in _ALL_LABELS:
            phrase = label.split()
            if normalised[index : index + len(phrase)] != phrase:
                continue
            if _reads_as_a_caption(line, start=index, end=index + len(phrase)):
                return index

    return len(line.words)


#: Punctuation that marks the end of a caption. A label printed inside a line is
#: followed by one of these; prose is not.
_CAPTION_PUNCTUATION: Final[str] = ":-=|"


def _reads_as_a_caption(line: TextLine, *, start: int, end: int) -> bool:
    """Whether words matching a label are that field's caption or ordinary prose.

    A caption either begins its line or is punctuated. `Invoice Number: INV-4471`
    still reads as a caption halfway through a merged table row, because of the
    colon.

    The sentence "Please remit to First Global Bank, account number 0012345678"
    contains the words of a supplier label and none of that punctuation. Read as a
    label it names the payee's bank as the supplier, which is the exact shape of a
    payment-redirection attempt, and it would be scored as a confident reading
    because the words sat on the same line as the value.

    So the test is deliberately strict, and errs towards finding nothing. A value
    left unfound costs a reviewer a moment of typing. A value found wrongly and
    confidently costs a payment to the wrong account.
    """
    if start == 0:
        return True

    label_ends = line.words[end - 1].text.rstrip()
    if label_ends and label_ends[-1] in _CAPTION_PUNCTUATION:
        return True

    # A document that prints the separator as its own word, as in "Total : 500".
    if end < len(line.words):
        following = line.words[end].text.strip()
        return following != "" and following[0] in _CAPTION_PUNCTUATION

    return False


def _carries_a_label(line: TextLine) -> bool:
    normalised = normalise(line.text)
    return any(_phrase_in(normalised, label) for label in _ALL_LABELS)


def _phrase_in(normalised_text: str, phrase: str) -> bool:
    """Whether a phrase appears in a line, on word boundaries.

    Bounded so that "tax" does not match inside "taxable" and turn a subtotal
    line into a tax line.
    """
    return re.search(rf"(?<![\w]){re.escape(phrase)}(?![\w])", normalised_text) is not None


def _skip_separators(words: tuple[Word, ...]) -> tuple[Word, ...]:
    index = 0
    while index < len(words):
        token = normalise(words[index].text).strip(_EDGE_PUNCTUATION)
        if token not in _SEPARATORS and token != "":
            break
        index += 1
    return words[index:]


# ------------------------------------------------------------------ typing


def _build_candidate(
    reading: _Reading,
    *,
    name: FieldName,
    currency_code: str | None,
    document_adjustments: list[ConfidenceAdjustment],
    result: ExtractionResult,
    origin: FieldOrigin = FieldOrigin.rule,
    base_confidence: float | None = None,
) -> FieldCandidate | None:
    """Type a located value and score it, or discard it as unreadable."""
    kind = FIELD_VALUE_KINDS[name]
    adjustments = list(document_adjustments)
    notes: list[str] = []
    amount_minor_units: int | None = None
    value_date = None
    currency = None

    if kind is ValueKind.money:
        amount = parse_amount(reading.text)
        if amount is None:
            return None
        if amount.is_ambiguous:
            adjustments.append(
                ConfidenceAdjustment(
                    reason="the thousands and decimal separators could be read either way",
                    delta=AMBIGUOUS_AMOUNT,
                )
            )
        if amount.note:
            notes.append(amount.note)
        if currency_code is None:
            # An amount with no currency is not a money value. It is stored as
            # text so the reviewer can see what was read, and the currency field
            # carries the question, because a figure whose unit is unknown must
            # not reach a threshold check.
            notes.append(
                "The document does not state which currency this amount is in, "
                "so it has not been recorded as an amount yet."
            )
        else:
            try:
                amount_minor_units = money_from_text(amount.value, currency_code)
            except (ValueError, KeyError):
                notes.append(
                    f"'{currency_code}' is not a currency this platform can hold "
                    "amounts in, so the figure has not been recorded."
                )
            else:
                currency = currency_code

    elif kind is ValueKind.date:
        parsed = parse_date(reading.text)
        if parsed is None:
            return None
        value_date = parsed.value
        if parsed.is_ambiguous:
            result.add_signal(DocumentSignal.ambiguous_date)
            adjustments.append(
                ConfidenceAdjustment(
                    reason="the day and month could be read either way round",
                    delta=AMBIGUOUS_DATE,
                )
            )
        if parsed.note:
            notes.append(parsed.note)

    confidence = (
        combine_confidence(reading.quality, adjustments)
        if base_confidence is None
        else adjusted_confidence(base_confidence, adjustments)
    )

    return FieldCandidate(
        name=name,
        text=reading.text,
        origin=origin,
        confidence=confidence,
        evidence=reading.evidence,
        amount_minor_units=amount_minor_units,
        currency=currency,
        value_date=value_date,
        adjustments=tuple(adjustments),
        notes=tuple(notes),
    )


@dataclass(frozen=True, slots=True)
class TypedValue:
    """A value a person typed, converted to the form the field holds.

    `problem` is the whole point of the type. A reviewer who types "next Tuesday"
    into a date must be told that in the field, not have it silently discarded or
    stored as text under a column the rest of the platform reads as a date.
    """

    text: str
    amount_minor_units: int | None = None
    currency: str | None = None
    value_date: date | None = None
    notes: tuple[str, ...] = ()
    problem: str | None = None


def type_value(name: FieldName, text: str, *, currency_code: str | None) -> TypedValue:
    """Convert what a person typed into the field's value, or say why it will not."""
    cleaned = " ".join(text.split())
    if not cleaned:
        return TypedValue(text="")

    kind = FIELD_VALUE_KINDS[name]

    if kind is ValueKind.money:
        amount = parse_amount(cleaned)
        if amount is None:
            return TypedValue(
                text=cleaned,
                problem="That is not an amount. Enter digits, such as 1,250.00.",
            )
        if currency_code is None:
            return TypedValue(
                text=cleaned,
                problem=(
                    "Set the currency for this document before entering amounts, "
                    "because an amount without a currency cannot be used."
                ),
            )
        try:
            minor = money_from_text(amount.value, currency_code)
        except (ValueError, KeyError):
            return TypedValue(
                text=cleaned,
                problem=(
                    f"'{currency_code}' is not a currency this platform can hold "
                    "amounts in. Correct the currency first."
                ),
            )
        return TypedValue(
            text=cleaned,
            amount_minor_units=minor,
            currency=currency_code,
            notes=(amount.note,) if amount.note else (),
        )

    if kind is ValueKind.date:
        parsed = parse_date(cleaned)
        if parsed is None:
            return TypedValue(
                text=cleaned,
                problem="That is not a date. Enter it as 2026-03-15 or 15 March 2026.",
            )
        return TypedValue(
            text=cleaned,
            value_date=parsed.value,
            notes=(parsed.note,) if parsed.note else (),
        )

    if kind is ValueKind.currency_code:
        code = cleaned.upper()
        if len(code) != 3 or not code.isalpha():
            return TypedValue(
                text=cleaned,
                problem="Enter a three-letter currency code, such as JMD or USD.",
            )
        try:
            money_from_text(Decimal(0), code)
        except (ValueError, KeyError):
            return TypedValue(
                text=code,
                problem=f"'{code}' is not a currency this platform can hold amounts in.",
            )
        return TypedValue(text=code, currency=code)

    return TypedValue(text=cleaned)


def _apply_proposals(
    result: ExtractionResult,
    proposals: Mapping[FieldName, Proposal],
    *,
    currency_code: str | None,
    document_adjustments: list[ConfidenceAdjustment],
) -> None:
    """Fill gaps with a model's proposals, and only gaps.

    A rule's reading always wins. The rules are auditable and reproducible; a
    model is neither, so it is never allowed to overwrite one, even when a
    reviewer might have preferred its answer. Nor is currency accepted from a
    model: that value governs how every amount on the document is interpreted,
    and it is settled document-wide from the symbols and codes actually present.
    """
    for name, proposal in proposals.items():
        if name is FieldName.currency:
            continue
        existing = result.fields.get(name)
        if existing is not None and existing.is_present:
            continue
        candidate = _build_candidate(
            _Reading(
                text=proposal.text.strip(),
                # Unused: `base_confidence` decides the score for a proposal.
                quality=MatchQuality.shape_only,
                evidence=proposal.evidence,
            ),
            name=name,
            currency_code=currency_code,
            document_adjustments=document_adjustments,
            result=result,
            origin=FieldOrigin.model,
            base_confidence=MODEL_PROPOSAL_CONFIDENCE,
        )
        if candidate is None:
            continue
        result.fields[name] = FieldCandidate(
            name=candidate.name,
            text=candidate.text,
            origin=candidate.origin,
            confidence=candidate.confidence,
            evidence=candidate.evidence,
            amount_minor_units=candidate.amount_minor_units,
            currency=candidate.currency,
            value_date=candidate.value_date,
            adjustments=candidate.adjustments,
            notes=(
                *candidate.notes,
                "The document does not label this value. It was proposed by the "
                "assistive reader and must be confirmed against the document.",
            ),
        )
        result.add_signal(DocumentSignal.model_assisted)


def _apply_currency_field(
    result: ExtractionResult,
    document: DocumentText,
    currency: CurrencyReading,
    document_adjustments: list[ConfidenceAdjustment],
) -> None:
    """Record the document's currency as a field in its own right.

    A field rather than a property of each amount, because when it cannot be
    decided that is the single most important thing on the screen: every figure
    on the document is unusable until it is answered.
    """
    if currency.code is None:
        result.fields[FieldName.currency] = absent(
            FieldName.currency,
            currency.note or "The document does not state a currency.",
        )
        return

    evidence = find_evidence(document, currency.code)

    result.fields[FieldName.currency] = FieldCandidate(
        name=FieldName.currency,
        text=currency.code,
        origin=FieldOrigin.rule,
        confidence=combine_confidence(
            MatchQuality.labelled if evidence else MatchQuality.shape_only,
            document_adjustments,
        ),
        currency=currency.code,
        evidence=evidence,
        adjustments=tuple(document_adjustments),
    )


def _fall_back_to_letterhead(
    result: ExtractionResult,
    document: DocumentText,
    document_adjustments: list[ConfidenceAdjustment],
) -> None:
    """Take the vendor from the letterhead when no label named one.

    Most invoices never write the word "vendor": the supplier's name is simply
    the largest thing at the top of the page. That is a real signal and worth
    offering, but it is inferred from position alone, so it is scored as
    positional and sits far below the review threshold by construction. It is a
    starting point for a reviewer, never an answer.
    """
    if FieldName.vendor_name in result.fields:
        return
    if not document.pages:
        return

    page = document.pages[0]
    if page.height <= 0:
        return

    top_band = page.height * 0.25
    candidates = [
        line
        for line in page.lines
        if line.box.y <= top_band
        and len(line.words) <= 8
        and _looks_like_a_name(line.text)
        and not _is_a_document_title(line.text)
    ]
    if not candidates:
        return

    # Tallest text wins: a letterhead is set larger than the address beneath it.
    chosen = max(candidates, key=lambda line: (round(line.box.height, 1), -line.box.y))

    result.fields[FieldName.vendor_name] = FieldCandidate(
        name=FieldName.vendor_name,
        text=chosen.text,
        origin=FieldOrigin.rule,
        confidence=combine_confidence(MatchQuality.positional, document_adjustments),
        evidence=_evidence(page, chosen, chosen.box),
        adjustments=tuple(document_adjustments),
        notes=(
            "No supplier label was found, so this was taken from the top of the "
            "first page. Confirm it against the vendor master.",
        ),
    )


def _is_a_document_title(text: str) -> bool:
    """Whether a line is the document announcing what it is.

    Excluded from the vendor fallback because a title is usually the largest text
    on the page, so without this the supplier of every invoice would be read as
    "TAX INVOICE".
    """
    normalised = normalise(text)
    return any(rule.title.search(normalised) for rule in KIND_RULES)


_NAME_LIKE = re.compile(r"[a-z]{2,}")


def _looks_like_a_name(text: str) -> bool:
    """Whether a line could be an organisation's name.

    Excludes lines that are mostly digits or punctuation, which is what a phone
    number, an address line or a document number looks like from here.
    """
    normalised = normalise(text)
    if not _NAME_LIKE.search(normalised):
        return False
    letters = sum(1 for character in normalised if character.isalpha())
    return letters >= len(normalised.replace(" ", "")) * 0.6


# -------------------------------------------------------------- cross-checks


def _cross_check_amounts(result: ExtractionResult) -> None:
    """Confirm the figures agree with each other, and say so either way.

    Corroboration is worth a little and contradiction is worth a lot. Three
    numbers that add up were probably all read correctly; three that do not mean
    at least one was not, and no amount of confidence in each individually
    changes that.
    """
    subtotal = result.fields.get(FieldName.subtotal)
    tax = result.fields.get(FieldName.tax_total)
    total = result.fields.get(FieldName.total)

    if total is not None and total.amount_minor_units is not None and total.amount_minor_units < 0:
        result.add_signal(DocumentSignal.negative_total)

    net = subtotal.amount_minor_units if subtotal else None
    levy = tax.amount_minor_units if tax else None
    gross = total.amount_minor_units if total else None

    # All three are needed. Two of them agreeing about the third's absence says
    # nothing, and a missing figure is already reported as missing elsewhere.
    if net is None or levy is None or gross is None:
        return

    agrees = net + levy == gross
    if not agrees:
        result.add_signal(DocumentSignal.amounts_do_not_add_up)

    delta = ARITHMETIC_AGREES if agrees else ARITHMETIC_DISAGREES
    reason = (
        "the subtotal and tax add up to the total"
        if agrees
        else "the subtotal and tax do not add up to the total"
    )

    for name in (FieldName.subtotal, FieldName.tax_total, FieldName.total):
        existing = result.fields[name]
        adjustments = (*existing.adjustments, ConfidenceAdjustment(reason=reason, delta=delta))
        result.fields[name] = _rescored(existing, adjustments)


def _cross_check_dates(result: ExtractionResult) -> None:
    document_date = result.fields.get(FieldName.document_date)
    due_date = result.fields.get(FieldName.due_date)
    if (
        document_date is None
        or due_date is None
        or document_date.value_date is None
        or due_date.value_date is None
    ):
        return
    if due_date.value_date < document_date.value_date:
        result.add_signal(DocumentSignal.due_before_document_date)


def _rescored(
    candidate: FieldCandidate,
    adjustments: tuple[ConfidenceAdjustment, ...],
) -> FieldCandidate:
    """The same value with its confidence recomputed from a new adjustment set.

    Recomputed from the base rather than nudged, so applying the same check twice
    cannot compound and a confidence is always the sum of its named reasons.
    """
    base = (
        MODEL_PROPOSAL_CONFIDENCE
        if candidate.origin is FieldOrigin.model
        else BASE_CONFIDENCE[_quality_of(candidate)]
    )
    return FieldCandidate(
        name=candidate.name,
        text=candidate.text,
        origin=candidate.origin,
        confidence=adjusted_confidence(base, adjustments),
        evidence=candidate.evidence,
        amount_minor_units=candidate.amount_minor_units,
        currency=candidate.currency,
        value_date=candidate.value_date,
        adjustments=adjustments,
        notes=candidate.notes,
    )


def _quality_of(candidate: FieldCandidate) -> MatchQuality:
    """Recover the match quality a candidate was scored from.

    Derived rather than stored, because the alternative is a second field on
    every candidate that only this function reads.     The base confidences are
    distinct values, so the mapping is exact.
    """
    baseline = candidate.confidence - sum(a.delta for a in candidate.adjustments)
    return min(
        BASE_CONFIDENCE,
        key=lambda quality: abs(BASE_CONFIDENCE[quality] - baseline),
    )


def _record_absences(result: ExtractionResult, *, kind: DocumentKind) -> None:
    """Write an explicit "not found" for every required field that is missing."""
    missing = False
    for name in required_fields(kind):
        if result.fields.get(name) is not None and result.fields[name].is_present:
            continue
        if name not in result.fields:
            result.fields[name] = absent(
                name,
                "This was not found on the document. Enter it before accepting.",
            )
        missing = True

    if missing:
        result.add_signal(DocumentSignal.required_field_missing)

    if kind is DocumentKind.unknown:
        result.add_signal(DocumentSignal.kind_undetermined)

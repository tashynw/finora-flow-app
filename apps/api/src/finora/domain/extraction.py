"""What a document is, and what it says.

Three rules shape this module, and everything else follows from them.

Deterministic reading comes first. A labelled value on an invoice is found by
looking for the label, not by asking a model to guess. Rules are repeatable,
explainable and free, and they fail visibly. A model is only ever asked about
what the rules could not answer, and its answer is a suggestion.

Nothing is invented. A field has a value only when that value was found in the
document and can be pointed at. There is no default vendor, no assumed currency
and no total inferred from an arithmetic identity. An empty field that says "not
found" is correct; a plausible field that nobody can trace is a liability, because
it will be approved.

Confidence decides whether a person must look. It is not a decoration next to a
value: it is compared against a configured threshold, and below that threshold the
document cannot leave review. Every penalty and every bonus applied to it is named
here so that a reviewer asking "why does it only trust this a little" gets an
answer rather than a number.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from enum import StrEnum
from typing import Final

from finora.domain.text_layout import Box, DocumentText, TextLine, TextSource, normalise


class DocumentKind(StrEnum):
    """What kind of document this is.

    `unknown` is a real answer and is used whenever the evidence does not decide.
    Guessing `invoice` because most documents are invoices would put a quotation
    into the payment path, which is the expensive direction to be wrong in.
    """

    invoice = "invoice"
    estimate = "estimate"
    credit_note = "credit_note"
    receipt = "receipt"
    purchase_order = "purchase_order"
    statement = "statement"
    remittance_advice = "remittance_advice"
    unknown = "unknown"


KIND_LABELS: Final[dict[DocumentKind, str]] = {
    DocumentKind.invoice: "Invoice",
    DocumentKind.estimate: "Estimate or quotation",
    DocumentKind.credit_note: "Credit note",
    DocumentKind.receipt: "Receipt",
    DocumentKind.purchase_order: "Purchase order",
    DocumentKind.statement: "Statement of account",
    DocumentKind.remittance_advice: "Remittance advice",
    DocumentKind.unknown: "Not identified",
}


class ExtractionStatus(StrEnum):
    """Where a document has reached.

    `manual_entry_required` exists so that an unreadable document is a state with
    a working path out of it, rather than a failure a user can only stare at. A
    scanned page with no text layer and no vision service configured is still a
    real invoice that has to be paid.
    """

    pending = "pending"
    extracting = "extracting"
    #: Read, and everything a person needs to check is above the threshold.
    extracted = "extracted"
    #: Read, but something needs a person before it can be used.
    needs_review = "needs_review"
    #: A person has confirmed the fields. Downstream modules may rely on them.
    accepted = "accepted"
    #: Nothing readable was obtained. Fields must be typed in.
    manual_entry_required = "manual_entry_required"
    #: The attempt itself failed. Distinct from an unreadable document, because
    #: this one is worth retrying and that one is not.
    failed = "failed"


TERMINAL_EXTRACTION_STATUSES: Final[frozenset[ExtractionStatus]] = frozenset(
    {ExtractionStatus.accepted}
)


class FieldName(StrEnum):
    """The fields the platform reads from an invoice or estimate.

    Bank details are deliberately absent. They appear on documents constantly and
    are the single most attractive thing on the page to an attacker, so they are
    never read into a field that could be used for payment; their presence is
    recorded as a signal for a person to verify against the vendor master.
    """

    vendor_name = "vendor_name"
    vendor_tax_id = "vendor_tax_id"
    document_number = "document_number"
    document_date = "document_date"
    due_date = "due_date"
    currency = "currency"
    subtotal = "subtotal"
    tax_total = "tax_total"
    total = "total"
    purchase_order_number = "purchase_order_number"
    estimate_reference = "estimate_reference"
    payment_terms = "payment_terms"


FIELD_LABELS: Final[dict[FieldName, str]] = {
    FieldName.vendor_name: "Vendor",
    FieldName.vendor_tax_id: "Vendor tax registration",
    FieldName.document_number: "Document number",
    FieldName.document_date: "Document date",
    FieldName.due_date: "Due date",
    FieldName.currency: "Currency",
    FieldName.subtotal: "Subtotal",
    FieldName.tax_total: "Tax",
    FieldName.total: "Total",
    FieldName.purchase_order_number: "Purchase order",
    FieldName.estimate_reference: "Estimate reference",
    FieldName.payment_terms: "Payment terms",
}


class ValueKind(StrEnum):
    """How a field's value is typed once it has been read."""

    text = "text"
    money = "money"
    date = "date"
    currency_code = "currency_code"


FIELD_VALUE_KINDS: Final[dict[FieldName, ValueKind]] = {
    FieldName.vendor_name: ValueKind.text,
    FieldName.vendor_tax_id: ValueKind.text,
    FieldName.document_number: ValueKind.text,
    FieldName.document_date: ValueKind.date,
    FieldName.due_date: ValueKind.date,
    FieldName.currency: ValueKind.currency_code,
    FieldName.subtotal: ValueKind.money,
    FieldName.tax_total: ValueKind.money,
    FieldName.total: ValueKind.money,
    FieldName.purchase_order_number: ValueKind.text,
    FieldName.estimate_reference: ValueKind.text,
    FieldName.payment_terms: ValueKind.text,
}

#: Fields without which an invoice cannot be processed at all. Their absence is
#: not a warning, it is the reason the document stays in review.
REQUIRED_FOR_INVOICE: Final[frozenset[FieldName]] = frozenset(
    {
        FieldName.vendor_name,
        FieldName.document_number,
        FieldName.document_date,
        FieldName.currency,
        FieldName.total,
    }
)

REQUIRED_FOR_ESTIMATE: Final[frozenset[FieldName]] = frozenset(
    {
        FieldName.vendor_name,
        FieldName.document_date,
        FieldName.currency,
        FieldName.total,
    }
)


#: Fields worth having on a document of a given kind, required or not. Used to
#: decide what a model may be asked about, which is why it is a deliberate list
#: rather than "every field": each name here becomes a question sent to a model
#: along with the document's text, and asking about a field nothing downstream
#: reads spends money and widens the surface for no benefit.
#:
#: Currency is excluded everywhere. It governs how every amount on the page is
#: interpreted and is settled from the symbols and codes actually present.
USEFUL_FOR_INVOICE: Final[frozenset[FieldName]] = frozenset(
    {
        FieldName.vendor_name,
        FieldName.vendor_tax_id,
        FieldName.document_number,
        FieldName.document_date,
        FieldName.due_date,
        FieldName.subtotal,
        FieldName.tax_total,
        FieldName.total,
        FieldName.purchase_order_number,
        FieldName.payment_terms,
    }
)

USEFUL_FOR_ESTIMATE: Final[frozenset[FieldName]] = frozenset(
    {
        FieldName.vendor_name,
        FieldName.vendor_tax_id,
        FieldName.document_number,
        FieldName.document_date,
        FieldName.subtotal,
        FieldName.tax_total,
        FieldName.total,
        FieldName.estimate_reference,
        FieldName.payment_terms,
    }
)


def useful_fields(kind: DocumentKind) -> frozenset[FieldName]:
    """The fields a model may be asked about for this kind of document.

    Empty for a kind the platform has no processing rules for. A document nothing
    is waiting on does not justify a model call, and "unknown" in particular must
    not: the fields to ask for would be a guess built on a guess.
    """
    if kind is DocumentKind.estimate:
        return USEFUL_FOR_ESTIMATE
    if kind in {DocumentKind.invoice, DocumentKind.credit_note}:
        return USEFUL_FOR_INVOICE
    return frozenset()


def required_fields(kind: DocumentKind) -> frozenset[FieldName]:
    if kind is DocumentKind.estimate:
        return REQUIRED_FOR_ESTIMATE
    if kind in {DocumentKind.invoice, DocumentKind.credit_note}:
        return REQUIRED_FOR_INVOICE
    # For anything else the platform has no processing rules yet, so demanding
    # fields would block a document nothing is waiting on.
    return frozenset()


class FieldOrigin(StrEnum):
    """Who produced a value. Recorded so a suggestion is never read back as a
    finding, and a person's correction is never overwritten by a re-run."""

    #: A deterministic rule found it in the document.
    rule = "rule"
    #: A model proposed it. Always a suggestion, never a conclusion.
    model = "model"
    #: A person typed or corrected it. Outranks everything.
    human = "human"
    #: Looked for and not found. An explicit answer, not a missing row.
    absent = "absent"


class FieldReview(StrEnum):
    unreviewed = "unreviewed"
    confirmed = "confirmed"
    corrected = "corrected"
    #: A person decided the document does not carry this value.
    cleared = "cleared"


class ConfidenceBand(StrEnum):
    high = "high"
    medium = "medium"
    low = "low"
    none = "none"


@dataclass(frozen=True, slots=True)
class ConfidenceThresholds:
    """Where the bands sit.

    Supplied from configuration rather than fixed, because the point at which a
    finance team wants to stop trusting a reading is a business decision and will
    be tuned against real documents.
    """

    #: At or above this, a value does not need a person's eyes.
    review: float = 0.85
    #: Below this, a value is shown but treated as barely more than a hint.
    low: float = 0.55

    def __post_init__(self) -> None:
        if not 0.0 < self.low <= self.review <= 1.0:
            raise ValueError("Thresholds must satisfy 0 < low <= review <= 1.")

    def band(self, confidence: float) -> ConfidenceBand:
        if confidence <= 0.0:
            return ConfidenceBand.none
        if confidence >= self.review:
            return ConfidenceBand.high
        if confidence >= self.low:
            return ConfidenceBand.medium
        return ConfidenceBand.low


# ---------------------------------------------------------------- confidence


#: How much a match is trusted before anything is added or taken away. These are
#: the only places a confidence number originates, so a value's trust can always
#: be traced to the way it was found.
class MatchQuality(StrEnum):
    #: The document labelled it, in so many words: "Invoice number: 4471".
    labelled = "labelled"
    #: A label was found nearby but not adjoining, such as a column heading two
    #: lines above its value.
    nearby_label = "nearby_label"
    #: Recognised by its own shape alone, with no label to confirm it. A date in
    #: a corner is a date, but which date it is remains a guess.
    shape_only = "shape_only"
    #: Inferred from where it sits on the page, such as the vendor being the
    #: largest text at the top. Frequently right, never dependable.
    positional = "positional"


#: What a model's proposal is worth once the gateway has confirmed the value is
#: genuinely in the document.
#:
#: Not a `MatchQuality`, because those describe how a document presented a value
#: and this describes who proposed it. It sits deliberately in the middle band:
#: above nothing, because the value was verified to exist on the page, and well
#: below any review threshold a finance team would set, because what the model
#: asserted is the *association* between that text and this field, and nothing in
#: the document corroborates it. A proposal therefore always reaches a person.
MODEL_PROPOSAL_CONFIDENCE: Final[float] = 0.60

BASE_CONFIDENCE: Final[dict[MatchQuality, float]] = {
    MatchQuality.labelled: 0.95,
    MatchQuality.nearby_label: 0.78,
    MatchQuality.shape_only: 0.55,
    MatchQuality.positional: 0.40,
}


@dataclass(frozen=True, slots=True)
class ConfidenceAdjustment:
    """One named reason the trust in a value moved, and by how much."""

    reason: str
    delta: float


#: Recognised text is a reading of an image. Even a confident reading can turn an
#: 8 into a 3, and the consequence of that on a total is a wrong payment, so
#: everything read this way is held below the review threshold by construction.
VISION_PENALTY: Final[float] = -0.25

#: Cross-checks. Subtotal plus tax equalling the total is genuine corroboration
#: of all three, and worth a little; it is small because the same wrong column
#: could have been read three times consistently.
ARITHMETIC_AGREES: Final[float] = 0.04
ARITHMETIC_DISAGREES: Final[float] = -0.30

#: `1,500` is fifteen hundred to most writers and one-and-a-half to some. The
#: reading picks the common intent, and this penalty is what stops that choice
#: being silent, because the two differ by a factor of a thousand.
AMBIGUOUS_AMOUNT: Final[float] = -0.30

#: A date like 03/04/2026 is two different dates depending on the writer's
#: country. Nothing in the document decides it, so the reading is reported as
#: ambiguous rather than resolved by a configured locale that would silently be
#: wrong for half of all vendors.
AMBIGUOUS_DATE: Final[float] = -0.35

#: More than one currency on the page. A conversion table, a foreign bank charge
#: or a genuinely mixed document all look the same from here.
MULTIPLE_CURRENCIES: Final[float] = -0.25

#: The document contains text that reads as an instruction to a model. Whether
#: or not it influenced anything, a document trying to talk to the machine is a
#: document a person needs to look at.
INJECTION_SUSPECTED: Final[float] = -0.40


def combine_confidence(
    quality: MatchQuality,
    adjustments: list[ConfidenceAdjustment] | tuple[ConfidenceAdjustment, ...] = (),
) -> float:
    """Final confidence for one value, clamped to a sane range.

    Never returns exactly 1.0. A reading of a document is not a fact, and a
    displayed certainty of 100% invites a reviewer to stop reading.
    """
    return adjusted_confidence(BASE_CONFIDENCE[quality], adjustments)


def adjusted_confidence(
    base: float,
    adjustments: list[ConfidenceAdjustment] | tuple[ConfidenceAdjustment, ...] = (),
) -> float:
    """As `combine_confidence`, for a value whose starting score is not a match quality.

    A model's proposal is the case that needs this: `MODEL_PROPOSAL_CONFIDENCE`
    says what the proposal is worth, and the document-wide penalties still apply
    to it, because a page carrying injected instructions makes a machine's reading
    of that page less trustworthy, not more.
    """
    score = base + sum(a.delta for a in adjustments)
    return max(0.0, min(0.99, round(score, 4)))


# ------------------------------------------------------------------ evidence


@dataclass(frozen=True, slots=True)
class Evidence:
    """Where in the document a value was found.

    `boxes` may be empty, and that is not a defect: a value read from a CSV or
    proposed from a page image has no rectangle to draw. The snippet is always
    present, so the reviewer can at least be shown the text that was matched.
    """

    page_number: int
    snippet: str
    boxes: tuple[Box, ...] = ()

    @property
    def is_pointable(self) -> bool:
        return bool(self.boxes)


@dataclass(frozen=True, slots=True)
class FieldCandidate:
    """A value read from a document, with everything needed to defend it."""

    name: FieldName
    #: Verbatim, as the document writes it. Shown to the reviewer, because a
    #: normalised value hides the difference between "INV-4471" and "inv 4471".
    text: str
    origin: FieldOrigin
    confidence: float
    evidence: Evidence | None = None
    #: Typed forms, populated per the field's value kind.
    amount_minor_units: int | None = None
    currency: str | None = None
    value_date: date | None = None
    #: Named reasons the confidence is what it is, in the reviewer's words.
    adjustments: tuple[ConfidenceAdjustment, ...] = ()
    #: Anything a person should know about this specific reading.
    notes: tuple[str, ...] = ()

    @property
    def is_present(self) -> bool:
        return self.origin is not FieldOrigin.absent and bool(self.text)


def absent(name: FieldName, note: str) -> FieldCandidate:
    """An explicit "looked for, not found", which is a result and not a gap."""
    return FieldCandidate(
        name=name,
        text="",
        origin=FieldOrigin.absent,
        confidence=0.0,
        notes=(note,),
    )


# ------------------------------------------------------------------- signals


class DocumentSignal(StrEnum):
    """Things about a document that a person needs to be told.

    These are not extraction failures. A document can be read perfectly and still
    carry every one of these, and each of them changes what the reviewer should
    do next. They are enumerated rather than assembled as free text so that the
    same condition always reads the same way and can be counted across documents.
    """

    no_text_layer = "no_text_layer"
    scanned_and_unreadable = "scanned_and_unreadable"
    encrypted = "encrypted"
    truncated_pages = "truncated_pages"
    #: Bank or payment instructions appear on the document. Never trusted from a
    #: document, always verified against the vendor master through a known channel.
    bank_details_present = "bank_details_present"
    #: The document tries to instruct a language model.
    prompt_injection_suspected = "prompt_injection_suspected"
    amounts_do_not_add_up = "amounts_do_not_add_up"
    ambiguous_date = "ambiguous_date"
    multiple_currencies = "multiple_currencies"
    #: The kind could not be decided, so no field rules could be chosen.
    kind_undetermined = "kind_undetermined"
    #: A model was asked and did not answer usefully, or was not available.
    model_unavailable = "model_unavailable"
    model_output_rejected = "model_output_rejected"
    #: At least one value on this document came from a model rather than a rule.
    model_assisted = "model_assisted"
    required_field_missing = "required_field_missing"
    negative_total = "negative_total"
    due_before_document_date = "due_before_document_date"


SIGNAL_EXPLANATIONS: Final[dict[DocumentSignal, str]] = {
    DocumentSignal.no_text_layer: (
        "This document is an image rather than text, so nothing could be read from it directly."
    ),
    DocumentSignal.scanned_and_unreadable: (
        "This document is a scan and no reading service is configured, so its "
        "fields have to be typed in."
    ),
    DocumentSignal.encrypted: (
        "This document is password protected and could not be opened for reading."
    ),
    DocumentSignal.truncated_pages: (
        "Only the first pages were read. The rest are stored and can be opened, "
        "but were not searched for values."
    ),
    DocumentSignal.bank_details_present: (
        "This document contains bank or payment details. Confirm them against the "
        "vendor master through a channel you already trust before paying anything."
    ),
    DocumentSignal.prompt_injection_suspected: (
        "This document contains text written to give instructions to an automated "
        "reader. It was treated as content and ignored, and the document needs a "
        "person to look at it."
    ),
    DocumentSignal.amounts_do_not_add_up: (
        "The subtotal and tax do not add up to the total. One of the three was "
        "read incorrectly, or the document itself disagrees."
    ),
    DocumentSignal.ambiguous_date: (
        "A date on this document could be read two ways, such as 03/04 meaning "
        "either 3 April or 4 March. Confirm it against the document."
    ),
    DocumentSignal.multiple_currencies: (
        "More than one currency appears on this document. Confirm which one the "
        "amount is actually in."
    ),
    DocumentSignal.kind_undetermined: (
        "It is not clear whether this is an invoice, a quotation or something "
        "else, so no field rules were applied."
    ),
    DocumentSignal.model_unavailable: (
        "The assistive reader was not available. Everything shown was found by "
        "deterministic rules only."
    ),
    DocumentSignal.model_output_rejected: (
        "The assistive reader returned something that could not be verified "
        "against this document, so it was discarded."
    ),
    DocumentSignal.model_assisted: (
        "One or more values on this document were proposed by the assistive reader "
        "because the document does not label them. Each is marked, and each needs "
        "checking against the document before it is accepted."
    ),
    DocumentSignal.required_field_missing: (
        "A field this document type needs could not be found. Enter it before accepting."
    ),
    DocumentSignal.negative_total: (
        "The total is negative. This is usually a credit note rather than an invoice."
    ),
    DocumentSignal.due_before_document_date: (
        "The due date is earlier than the document date. One of the two was read "
        "incorrectly, or the document is already overdue on issue."
    ),
}

#: Signals that on their own require a person, whatever the field confidences
#: say. Each of these describes a condition where a confident reading is exactly
#: the dangerous case.
SIGNALS_FORCING_REVIEW: Final[frozenset[DocumentSignal]] = frozenset(
    {
        DocumentSignal.prompt_injection_suspected,
        DocumentSignal.bank_details_present,
        DocumentSignal.amounts_do_not_add_up,
        DocumentSignal.ambiguous_date,
        DocumentSignal.multiple_currencies,
        DocumentSignal.kind_undetermined,
        DocumentSignal.required_field_missing,
        DocumentSignal.due_before_document_date,
        DocumentSignal.no_text_layer,
        DocumentSignal.truncated_pages,
        DocumentSignal.model_output_rejected,
        # Redundant against the confidence of a proposal, and kept anyway: a
        # threshold is configuration and configuration can be lowered, whereas
        # "no person has checked what a model asserted" must not become
        # acceptable by administrative accident.
        DocumentSignal.model_assisted,
    }
)


# ------------------------------------------------------------ prompt injection

#: Phrases whose purpose is to address the reader as a machine. A vendor writing
#: a genuine invoice has no reason to write any of these, and an attacker who
#: wants a document to reprogram the pipeline has to write something like one.
#:
#: This list is not a defence on its own and is not treated as one: document text
#: is passed to a model as data inside a delimited block, the model is given no
#: authority, and every value it proposes must be found in the document. The list
#: exists so that an attempt is visible in the audit trail and so the document
#: cannot pass without a person, which is the part a filter cannot provide.
_INJECTION_PATTERNS: Final[tuple[tuple[str, re.Pattern[str]], ...]] = (
    (
        "instructions to disregard earlier text",
        re.compile(
            r"\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b"
        ),
    ),
    (
        "an attempt to redefine the reader's role",
        re.compile(r"\byou are (now |an? )?(a |an )?(helpful|assistant|ai|system|different)\b"),
    ),
    (
        "a reference to system or developer instructions",
        re.compile(r"\b(system|developer) (prompt|message|instruction)"),
    ),
    (
        "a demand to output something specific",
        re.compile(r"\b(output|respond|reply|answer|return) (with|only|exactly|the following)\b"),
    ),
    (
        "an instruction to set a value",
        re.compile(r"\bset (the )?(total|amount|vendor|due date|currency)\b"),
    ),
    (
        "an instruction to approve or pay",
        re.compile(
            r"\b(approve|authorise|authorize|pay|mark as paid) (this|the) "
            r"(invoice|document|payment|estimate)\b"
        ),
    ),
    (
        "a claim of prior authorisation",
        re.compile(
            r"\b(already|pre)[- ]?(approved|authorised|authorized)\b[^.\n]{0,30}\b(no|without)\b"
        ),
    ),
    ("conversation markup", re.compile(r"<\|.{0,20}\|>|\[/?(inst|system|assistant)\]")),
)

#: Characters that hide text from a human reader while leaving it perfectly
#: legible to a parser. Text nobody can see has one purpose on an invoice.
_HIDDEN_CHARACTERS = re.compile(r"[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069]")


@dataclass(frozen=True, slots=True)
class InjectionFinding:
    """One reason a document looks like it is addressing the machine."""

    description: str
    excerpt: str


#: Enough context to recognise the sentence, short enough that the excerpt itself
#: cannot become a second delivery vehicle when it is displayed or logged.
_EXCERPT_RADIUS: Final[int] = 60


def scan_for_injection(text: str) -> tuple[InjectionFinding, ...]:
    """Find text in a document that is trying to instruct an automated reader."""
    if not text:
        return ()

    lowered = text.casefold()
    findings: list[InjectionFinding] = []

    for description, pattern in _INJECTION_PATTERNS:
        match = pattern.search(lowered)
        if match is None:
            continue
        start = max(match.start() - _EXCERPT_RADIUS, 0)
        end = min(match.end() + _EXCERPT_RADIUS, len(text))
        findings.append(
            InjectionFinding(
                description=description,
                excerpt=" ".join(text[start:end].split()),
            )
        )

    hidden = _HIDDEN_CHARACTERS.findall(text)
    if len(hidden) > 3:
        findings.append(
            InjectionFinding(
                description="invisible characters used to hide text from a reader",
                excerpt=f"{len(hidden)} invisible characters",
            )
        )

    return tuple(findings)


# ------------------------------------------------------------------- outcome


@dataclass(slots=True)
class ExtractionResult:
    """Everything one attempt at reading a document produced."""

    kind: DocumentKind
    kind_confidence: float
    kind_evidence: Evidence | None
    text_source: TextSource
    page_count: int
    fields: dict[FieldName, FieldCandidate] = field(default_factory=dict)
    signals: list[DocumentSignal] = field(default_factory=list)
    injection_findings: tuple[InjectionFinding, ...] = ()
    notes: list[str] = field(default_factory=list)

    def add_signal(self, signal: DocumentSignal) -> None:
        if signal not in self.signals:
            self.signals.append(signal)

    def present_fields(self) -> dict[FieldName, FieldCandidate]:
        return {name: candidate for name, candidate in self.fields.items() if candidate.is_present}

    def lowest_confidence(self, among: frozenset[FieldName]) -> float:
        """The weakest reading among the fields that matter.

        A document is only as trustworthy as its worst important field, so the
        minimum is the right summary. An average would let a confidently read
        invoice number carry an unreadable total past the threshold.
        """
        relevant = [self.fields[name].confidence for name in among if name in self.fields]
        return min(relevant) if relevant else 0.0

    def requires_review(self, thresholds: ConfidenceThresholds) -> bool:
        if any(signal in SIGNALS_FORCING_REVIEW for signal in self.signals):
            return True
        needed = required_fields(self.kind)
        if not needed:
            return True
        if any(not self.fields.get(name, absent(name, "")).is_present for name in needed):
            return True
        if self.kind_confidence < thresholds.review:
            return True
        return self.lowest_confidence(needed) < thresholds.review

    def status(self, thresholds: ConfidenceThresholds) -> ExtractionStatus:
        if self.text_source is TextSource.none:
            return ExtractionStatus.manual_entry_required
        return (
            ExtractionStatus.needs_review
            if self.requires_review(thresholds)
            else ExtractionStatus.extracted
        )


# ------------------------------------------------------------ locating a value


def find_evidence(
    document: DocumentText,
    needle: str,
    *,
    page_hint: int | None = None,
) -> Evidence | None:
    """Find where a piece of text sits in a document.

    This is what makes a value defensible rather than merely asserted, and it is
    also the check that keeps a model honest: a proposed value that cannot be
    found in the document has no evidence, and a value with no evidence is
    discarded rather than shown.

    Matching is done on normalised text so that a typographic dash or a
    non-breaking space does not defeat it, and the returned box is the union of
    only those words that actually contributed to the match, so the highlight
    frames the value instead of the whole line it appeared on.
    """
    wanted = normalise(needle)
    if not wanted:
        return None

    pages = document.pages
    if page_hint is not None:
        hinted = document.page(page_hint)
        # The hint is an ordering preference, not a restriction. A model that
        # names the wrong page has still found the value if it is elsewhere.
        pages = (hinted, *(p for p in pages if p.number != page_hint)) if hinted else pages

    for page in pages:
        for line in page.lines:
            if wanted not in normalise(line.text):
                continue
            box = _box_of_match(line, wanted)
            return Evidence(
                page_number=page.number,
                snippet=line.text,
                boxes=(box.padded(1.5),) if box else (),
            )
    return None


def _box_of_match(line: TextLine, wanted: str) -> Box | None:
    """The tightest run of words in a line whose text covers `wanted`.

    Grown from the left, then trimmed from the left again, because the shortest
    covering run is what a reviewer wants framed. A page number matching inside
    a longer figure would otherwise highlight the entire row.
    """
    words = line.words
    for start in range(len(words)):
        for end in range(start + 1, len(words) + 1):
            run = words[start:end]
            if wanted in normalise(" ".join(word.text for word in run)):
                return line.box_of(run)
    return None


def money_from_text(amount: Decimal, currency: str) -> int:
    """Minor units for a decimal read from a document.

    Goes through the money domain so that an unsupported currency is refused here
    rather than stored as a number whose scale nothing knows.
    """
    from finora.domain.money import Money

    return Money.from_decimal(amount, currency).minor_units

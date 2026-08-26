# 6. A model may propose a value only if that value is on the page

Date: 2026-08-05

Status: Accepted

## Context

Reading a supplier's invoice is the point where this platform decides what it is
about to pay, to whom, and when. Everything downstream — approval routing, the
payment package, the accrual — is arithmetic on the values decided here.

A language model is very good at producing those values and cannot be made
accountable for them. It will answer with a plausible total for a document that
has no total on it, and answer in exactly the same tone as when it read one
correctly. It is also reading attacker-controlled text: an invoice is a file a
stranger emailed us, and text on it addressed to an automated reader is a known
attack, not a hypothetical one.

The master prompt requires AI to be assistive, explainable and local by default,
and forbids it any authority over financial actions. That rules out the obvious
design, where a model reads the document and the interface shows what it said.

## Decision

Deterministic rules read the document first. They match labels to values by
position, and every value they produce carries the page, the line and the box it
came from.

A model is asked only about fields no rule could fill, and only for a kind of
document something downstream actually processes. Its answer is then treated as a
*claim about the document*, not as a value: each proposed string is searched for
in the text the reader extracted, and a proposal whose text cannot be located is
discarded and counted. The count is shown to the reviewer, because a model that
proposed three values none of which exist on the page is information about that
reading.

A proposal that survives grounding is stored with origin `model`, a fixed
confidence below the review threshold, and the evidence box where its text was
found. It is therefore always a value a person must confirm, and confirming it is
an act done from the page itself rather than from the model's assurance.

The gateway's default endpoint is a local model server on the machine running the
API, so the default deployment sends document text nowhere. Every way of not
getting an answer — switched off, kill switch engaged, circuit open, nothing
listening, error status, unparseable body, a field nobody asked for — is an
ordinary outcome that produces a reading from rules alone, with a sentence on the
page saying so in those terms. None of them is an error a reviewer has to
resolve, and none of them stops a document being completed by hand.

Document text sent to a model is sent as data, delimited and labelled as
untrusted, and the prompt says so. Text on the page that looks like instructions
to an automated reader raises `prompt_injection_suspected`, which a person has to
acknowledge before the reading can be accepted.

## Consequences

- A value that is genuinely on a document in a layout the rules do not handle,
  and which the model describes in different words than the page uses, is
  discarded. The reviewer types it in. This is the intended trade: the failure
  mode is a moment of typing, and the alternative failure mode is a confident
  wrong payee.
- Grounding is a string search over extracted text, so it confirms that the text
  exists on the page, not that it is the value of that field. The confidence
  assigned to a proposal reflects that: it is below the threshold at which
  anything stands unchecked.
- The gateway can be swapped for any OpenAI-compatible endpoint, including a
  local one, without touching the pipeline. What it may be asked and what will be
  accepted from it are decided in the pipeline, not by the provider.
- Documents that are images with no text layer get no values at all, from rules
  or from a model, and are marked as needing manual entry. Adding OCR would change
  that, and would mean sending document images to whatever performs it, which is a
  deployment decision rather than a code one. It is recorded as an open item in the
  traceability matrix.
- Every reading records the model name, the prompt identifier and the prompt
  version, so a value can still be explained after both have been replaced.

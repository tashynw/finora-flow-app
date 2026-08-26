"""Read a document from disk and print what the pipeline would find in it.

A development aid, not part of the product. It exists so a fixture document can be
checked against the real reader without going through intake, a mailbox or a
browser, which is the difference between diagnosing a rule in seconds and
diagnosing it in a test run.
"""

from __future__ import annotations

import sys
from pathlib import Path

from finora.application.extraction_rules import read_fields
from finora.domain.classification import classify
from finora.domain.extraction import DocumentKind
from finora.infrastructure.document_text import ReadingLimits, read_document


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python scripts/try_read.py <path> [content-type]")
        return 2

    path = Path(sys.argv[1])
    content_type = sys.argv[2] if len(sys.argv) > 2 else "application/pdf"
    text = read_document(
        path.read_bytes(),
        content_type=content_type,
        limits=ReadingLimits(max_pages=10, max_seconds=20.0),
    )

    print(f"source={text.source} pages={len(text.pages)} notes={text.notes}")
    for page in text.pages:
        print(f"--- page {page.number} ({page.width:.0f}x{page.height:.0f}) ---")
        for line in page.lines:
            print(f"  {line.text}")

    classification = classify(text)
    print(f"\nkind={classification.kind} confidence={classification.confidence:.2f}")

    kind = classification.kind if classification.kind is not DocumentKind.unknown else None
    if kind is None:
        print("No kind, so no field rules were applied.")
        return 0

    result = read_fields(text, kind=kind)
    print(f"signals={sorted(signal.value for signal in result.signals)}")
    for name, field in sorted(result.fields.items(), key=lambda item: item[0].value):
        evidence = field.evidence
        where = f"p{evidence.page_number}" if evidence else "-"
        print(f"  {name.value:24} {field.confidence:.2f} {where:4} {field.text!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

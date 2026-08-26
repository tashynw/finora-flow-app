"""Write the API's OpenAPI schema to a file.

The generated schema is the single source of truth for the shared TypeScript
types the web app consumes, so a response shape cannot drift between the two
without the generated types changing and the build noticing.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from finora.api.app import create_app

# Derived from this file rather than the working directory, so the script
# behaves the same whether it is run from the repository root, from apps/api,
# or from inside a container.
REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUTPUT = REPO_ROOT / "packages" / "shared-types" / "openapi.json"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="Where to write the schema.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit non-zero if the file on disk differs, without writing it.",
    )
    args = parser.parse_args()

    schema = create_app().openapi()
    # Sorted keys and a trailing newline keep the diff meaningful, so a review
    # shows the contract change rather than incidental reordering.
    rendered = json.dumps(schema, indent=2, sort_keys=True) + "\n"

    output: Path = args.output
    if args.check:
        if not output.exists():
            print(f"{output} does not exist. Run without --check to generate it.")
            return 1
        if output.read_text(encoding="utf-8") != rendered:
            print(
                f"{output} is stale. The API contract changed without the "
                f"committed schema being regenerated."
            )
            return 1
        print(f"{output} is up to date.")
        return 0

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(rendered, encoding="utf-8")
    print(f"Wrote {output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Generate the public rule catalog from the live registry."""

import argparse
from pathlib import Path

from goodhart.report.rules import catalog


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", type=Path, default=Path(__file__).resolve().parents[1] / "docs/rules.md"
    )
    args = parser.parse_args(argv)
    args.output.write_text(catalog())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

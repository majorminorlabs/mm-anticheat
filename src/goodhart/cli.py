"""Command-line entry point."""

import argparse
import sys
from pathlib import Path

from goodhart import TOOL_NAME, __version__
from goodhart.engine import file_counts
from goodhart.git import InputError, load_git, load_patch


class Parser(argparse.ArgumentParser):
    """Keep exit code 2 unused for agent-hook wrappers."""

    def error(self, message: str) -> None:
        self.exit(3, f"{self.prog}: error: {message}\n")


def main(argv: list[str] | None = None) -> int:
    """Run the CLI."""
    parser = Parser(prog="goodhart")
    parser.add_argument("--version", action="version", version=f"{TOOL_NAME} {__version__}")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("rules", help="List review rules")
    scan = subparsers.add_parser("scan", help="Scan a Git diff or unified patch")
    modes = scan.add_mutually_exclusive_group()
    modes.add_argument("--working", action="store_true")
    modes.add_argument("--staged", action="store_true")
    modes.add_argument("--diff", metavar="PATH")
    scan.add_argument("--base")
    scan.add_argument("--head")
    args = parser.parse_args(argv)
    if args.command == "rules":
        print("No rules registered yet.")
        return 0
    if (args.working or args.staged or args.diff) and (args.base or args.head):
        parser.error("--base/--head cannot be combined with --working, --staged, or --diff")
    try:
        if args.diff:
            text = sys.stdin.read() if args.diff == "-" else Path(args.diff).read_text()
            data = load_patch(text)
        else:
            data = load_git(
                base=args.base, head=args.head or "HEAD", working=args.working, staged=args.staged
            )
        counts = file_counts(data)
        label = f"{data.base}...{data.head}" if data.mode == "full" else "patch"
        print(f"{TOOL_NAME} | {label} | {len(data.changes)} files")
        print(" | ".join(f"{kind}: {count}" for kind, count in counts.items()))
        return 0
    except (InputError, OSError, UnicodeError) as exc:
        print(f"goodhart: error: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())

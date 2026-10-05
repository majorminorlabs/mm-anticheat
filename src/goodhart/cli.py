"""Command-line entry point."""

import argparse
import sys
from pathlib import Path

from goodhart import TOOL_NAME, __version__
from goodhart.engine import file_counts
from goodhart.engine import scan as run_scan
from goodhart.git import InputError, load_git, load_patch
from goodhart.report.json import render as render_json
from goodhart.rules import all_rules


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
    scan.add_argument("--format", choices=["text", "json"], default="text")
    args = parser.parse_args(argv)
    if args.command == "rules":
        for rule in all_rules():
            print(f"{rule.id} {rule.default_severity:6} {rule.name}")
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
        for notice in data.notices:
            print(f"goodhart: {notice}", file=sys.stderr)
        if len(data.changes) > 300:
            print(
                f"goodhart: {len(data.changes)} changed files; this scan may take longer",
                file=sys.stderr,
            )
        counts = file_counts(data)
        result = run_scan(data)
        if args.format == "json":
            print(render_json(result), end="")
            return result.exit_code()
        label = f"{data.base}...{data.head}" if data.mode == "full" else "patch"
        print(f"{TOOL_NAME} | {label} | {len(data.changes)} files")
        print(" | ".join(f"{kind}: {count}" for kind, count in counts.items()))
        print(" | ".join(f"{key}: {value}" for key, value in result.summary.items()))
        for finding in result.findings:
            print(
                f"[{finding.severity}] {finding.rule_id} {finding.file}:{finding.line} "
                f"{finding.title}\n  {finding.evidence}\n  Review: {finding.legit_if}"
            )
        return result.exit_code()
    except (InputError, OSError, UnicodeError) as exc:
        print(f"goodhart: error: {exc}", file=sys.stderr)
        return 3
    except Exception as exc:
        print(f"goodhart: internal error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())

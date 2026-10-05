"""Command-line input, config precedence, rule selection and stable exit codes."""

import argparse
import sys
from pathlib import Path

from goodhart import TOOL_NAME, __version__
from goodhart.config import ConfigError, load_config, rule_ids
from goodhart.engine import scan as run_scan
from goodhart.git import InputError, load_git, load_patch, repository_root
from goodhart.report.json import render as render_json
from goodhart.report.markdown import render as render_markdown
from goodhart.report.rules import explain
from goodhart.report.text import render as render_text
from goodhart.rules import all_rules


class Parser(argparse.ArgumentParser):
    """Keep exit code 2 unused for agent-hook wrappers."""

    def error(self, message: str) -> None:
        self.exit(3, f"{self.prog}: error: {message}\n")


def selected_rules(value: str) -> set[str]:
    """Validate rule IDs while parsing CLI arguments."""
    try:
        return rule_ids(value)
    except ConfigError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def positive(value: str) -> int:
    """Accept a positive presentation limit."""
    try:
        number = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a positive integer") from exc
    if number < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return number


def main(argv: list[str] | None = None) -> int:
    """Run the CLI; options override corresponding config settings."""
    parser = Parser(prog="goodhart")
    parser.add_argument("--version", action="version", version=f"{TOOL_NAME} {__version__}")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("rules", help="List review rules")
    explanation = subparsers.add_parser("explain", help="Explain one rule")
    explanation.add_argument("rule")
    scan = subparsers.add_parser("scan", help="Scan a Git diff or unified patch")
    modes = scan.add_mutually_exclusive_group()
    modes.add_argument("--working", action="store_true")
    modes.add_argument("--staged", action="store_true")
    modes.add_argument("--diff", metavar="PATH")
    scan.add_argument("--base")
    scan.add_argument("--head")
    scan.add_argument("--format", choices=["text", "json", "markdown"], default="text")
    scan.add_argument("--fail-on", choices=["high", "medium", "low", "never"])
    scan.add_argument("--rules", type=selected_rules, metavar="IDS")
    scan.add_argument("--skip-rules", type=selected_rules, metavar="IDS")
    scan.add_argument("--config", type=Path)
    scan.add_argument("--no-color", action="store_true")
    scan.add_argument("--quiet", action="store_true", help="Summary only for text/markdown")
    scan.add_argument("--max-evidence-lines", type=positive, default=6)
    args = parser.parse_args(argv)
    registry = all_rules()
    if args.command == "rules":
        for rule in registry:
            print(f"{rule.id} {rule.default_severity:6} {rule.name} — {rule.why_flagged}")
        return 0
    if args.command == "explain":
        rule = next((rule for rule in registry if rule.id == args.rule), None)
        if rule is None:
            parser.error(f"Unknown rule ID: {args.rule}")
        print(explain(rule), end="")
        return 0
    if (args.working or args.staged or args.diff) and (args.base or args.head):
        parser.error("--base/--head cannot be combined with --working, --staged, or --diff")
    if args.rules is not None and not args.rules:
        parser.error("--rules requires at least one rule ID")
    try:
        try:
            root = repository_root()
        except InputError:
            if not args.diff:
                raise
            root = Path.cwd()
        path = args.config
        if path is None and (root / ".goodhart.toml").exists():
            path = root / ".goodhart.toml"
        config = load_config(path)
        if args.fail_on is not None:
            config.fail_on = args.fail_on
        if args.skip_rules is not None:
            config.skip_rules = args.skip_rules
        active = [rule for rule in registry if args.rules is None or rule.id in args.rules]
        if args.diff:
            text = sys.stdin.read() if args.diff == "-" else Path(args.diff).read_text()
            data = load_patch(text, config)
        else:
            data = load_git(
                base=args.base,
                head=args.head or "HEAD",
                working=args.working,
                staged=args.staged,
                config=config,
            )
        for notice in data.notices:
            print(f"goodhart: {notice}", file=sys.stderr)
        if len(data.changes) > 300:
            print(
                f"goodhart: {len(data.changes)} changed files; this scan may take longer",
                file=sys.stderr,
            )
        result = run_scan(data, config, active)
        if args.format == "json":
            output = render_json(result)
        elif args.format == "markdown":
            output = render_markdown(
                result, quiet=args.quiet, max_evidence_lines=args.max_evidence_lines
            )
        else:
            output = render_text(
                result,
                color=sys.stdout.isatty() and not args.no_color,
                quiet=args.quiet,
                max_evidence_lines=args.max_evidence_lines,
            )
        print(output, end="")
        return result.exit_code(config.fail_on)
    except (InputError, ConfigError, OSError, UnicodeError) as exc:
        print(f"goodhart: error: {exc}", file=sys.stderr)
        return 3
    except Exception as exc:
        print(f"goodhart: internal error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())

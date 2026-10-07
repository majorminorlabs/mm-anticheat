"""Command-line input, config precedence, rule selection and stable exit codes."""

import argparse
import sys
from pathlib import Path

from mm_anticheat import TOOL_NAME, __version__
from mm_anticheat.config import ConfigError, load_config, rule_ids
from mm_anticheat.engine import scan as run_scan
from mm_anticheat.git import InputError, load_git, load_patch
from mm_anticheat.report.json import render as render_json
from mm_anticheat.report.markdown import render as render_markdown
from mm_anticheat.report.rules import explain
from mm_anticheat.report.text import render as render_text
from mm_anticheat.rules import all_rules


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
    parser = Parser(prog="mm-anticheat")
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
    scan.add_argument(
        "--capture-on-block",
        action="store_true",
        help="Save the scanned diff and findings JSON to .anticheat/captures/ on exit 1",
    )
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
    if ((args.staged or args.diff) and (args.base or args.head)) or (args.working and args.head):
        parser.error(
            "--head cannot accompany --working; --base/--head cannot accompany --staged or --diff"
        )
    if args.rules is not None and not args.rules:
        parser.error("--rules requires at least one rule ID")
    try:
        config = load_config(args.config) if args.config is not None else None
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
        config = data.config
        if args.fail_on is not None:
            config.fail_on = args.fail_on
        if args.skip_rules is not None:
            config.skip_rules = args.skip_rules
        for notice in data.notices:
            print(f"anticheat: {notice}", file=sys.stderr)
        if len(data.changes) > 300:
            print(
                f"anticheat: {len(data.changes)} changed files; this scan may take longer",
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
        code = result.exit_code(config.fail_on)
        if code == 1 and args.capture_on_block:
            from mm_anticheat.capture import save

            try:
                capture = save(result)
                print(f"anticheat: blocked scan saved to {capture}", file=sys.stderr)
            except OSError as exc:
                # Capture storage cannot turn a detected block into a hook error/pass.
                print(f"anticheat: capture failed; scan remains blocked: {exc}", file=sys.stderr)
        return code
    except (InputError, ConfigError, OSError, UnicodeError) as exc:
        print(f"anticheat: error: {exc}", file=sys.stderr)
        return 3
    except Exception as exc:
        print(f"anticheat: internal error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())

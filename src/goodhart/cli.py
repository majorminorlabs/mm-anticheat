"""Command-line entry point."""

import argparse

from goodhart import TOOL_NAME, __version__


def main(argv: list[str] | None = None) -> int:
    """Run the CLI."""
    parser = argparse.ArgumentParser(prog="goodhart")
    parser.add_argument("--version", action="version", version=f"{TOOL_NAME} {__version__}")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("rules", help="List review rules")
    args = parser.parse_args(argv)
    if args.command == "rules":
        print("No rules registered yet.")
    return 0

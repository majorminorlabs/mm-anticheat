#!/usr/bin/env python3
"""GitHub Action adapter; network is used only for explicitly enabled PR comments."""

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

MARKER = "<!-- goodhart-check -->"


def request(
    api: str, token: str, route: str, body: dict | None = None, method: str = "GET"
) -> object:
    """Use the configured GitHub API; never follow an API-supplied URL with credentials."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        api.rstrip("/") + route,
        data=data,
        method=method,
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def comment(repository: str, number: int, report: str) -> None:
    """Update only our marked github-actions bot comment, including paginated threads."""
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repository) or number < 1:
        raise ValueError("Invalid repository or PR number")
    api, token = (
        os.environ.get("GITHUB_API_URL", "https://api.github.com"),
        os.environ["GITHUB_TOKEN"],
    )
    if not api.startswith("https://") or not token:
        raise ValueError("Comments require HTTPS and GITHUB_TOKEN")
    prefix = f"/repos/{repository}"
    body = MARKER + "\n" + report
    if len(body) > 60_000:
        body = MARKER + "\nReport exceeds the comment size limit; see the job summary."
    page = 1
    while True:
        comments = request(
            api, token, f"{prefix}/issues/{number}/comments?per_page=100&page={page}"
        )
        for item in comments:
            if item.get("user", {}).get("login") == "github-actions[bot]" and item.get(
                "body", ""
            ).startswith(MARKER):
                request(
                    api,
                    token,
                    f"{prefix}/issues/comments/{int(item['id'])}",
                    {"body": body},
                    "PATCH",
                )
                return
        if len(comments) < 100:
            break
        page += 1
    request(api, token, f"{prefix}/issues/{number}/comments", {"body": body}, "POST")


def main() -> int:
    """Preserve scanner failure after writing its report and optional PR comment."""
    try:
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        pr = event.get("pull_request")
        if not isinstance(pr, dict):
            raise ValueError("This action requires a pull_request event")
        threshold = os.environ.get("GOODHART_FAIL_ON", "high")
        post = os.environ.get("GOODHART_COMMENT", "false")
        if threshold not in {"high", "medium", "low", "never"} or post not in {"true", "false"}:
            raise ValueError("Invalid fail-on or comment input")
        command = [
            sys.executable,
            "-I",
            "-m",
            "goodhart.cli",
            "scan",
            "--base",
            pr["base"]["sha"],
            "--head",
            os.environ["GITHUB_SHA"],
            "--format",
            "markdown",
            "--fail-on",
            threshold,
        ]
        config = os.environ.get("GOODHART_CONFIG", "")
        if config:
            command += ["--config", config]
        run = subprocess.run(command, capture_output=True, text=True)
        print(run.stdout, end="")
        print(run.stderr, end="", file=sys.stderr)
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as summary:
            summary.write(run.stdout or "goodhart scan failed; see the job log.\n")
        if post == "true":
            comment(os.environ["GITHUB_REPOSITORY"], int(event["number"]), run.stdout)
        return run.returncode
    except (OSError, ValueError, KeyError, TypeError, urllib.error.URLError) as exc:
        print(f"goodhart action: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())

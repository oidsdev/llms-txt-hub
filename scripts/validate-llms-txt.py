#!/usr/bin/env python3
"""Validate llms.txt files.

Checks the required H1, markdown link syntax, and that each absolute link
returns HTTP 200 within a timeout. http:// links and file-list links with no
description are warnings. Warnings do not fail a file unless --strict is set.

Examples:
  python scripts/validate-llms-txt.py llms.txt
  python scripts/validate-llms-txt.py --timeout 5 docs/llms.txt
  python scripts/validate-llms-txt.py --self-test
"""

from __future__ import annotations

import argparse
import re
import socket
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from contextlib import redirect_stdout
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import StringIO
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

Fetch = Callable[[str, float], tuple[int | None, str | None]]

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "llms-txt"
USER_AGENT = "llms-txt-validator"
LIST_ITEM = re.compile(
    r"^[*-]\s+\[([^\[\]]+)\]\(([^)\s]+)\)(?::[ \t]*(\S.*?))?[ \t]*$"
)
HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
H1_LINE = re.compile(r"^#(?!#)\s*(.*)$")


@dataclass(frozen=True)
class Finding:
    line: int
    severity: str
    message: str


def default_fetch(url: str, timeout: float) -> tuple[int | None, str | None]:
    """Return the HTTP status for url, falling back from HEAD to GET."""
    status, problem = _request(url, timeout, "HEAD")
    if problem == "timed out" or status == 200:
        return status, problem
    if status in {403, 405, 501}:
        return _request(url, timeout, "GET")
    return status, problem


def validate_text(
    text: str,
    *,
    timeout: float = 10.0,
    fetch: Fetch | None = None,
    skip_fetch: bool = False,
) -> list[Finding]:
    """Return line-numbered findings for one llms.txt document."""
    if text.startswith("\ufeff"):
        text = text[1:]

    lines = text.splitlines()
    findings: list[Finding] = []
    queued: list[tuple[int, str]] = []
    in_fence = False
    in_file_list = False

    first_content = next((index for index, line in enumerate(lines, 1) if line.strip()), None)
    if first_content is None:
        findings.append(Finding(1, "error", "required H1 is missing"))
    else:
        title = _h1_title(lines[first_content - 1].strip())
        if title is None:
            findings.append(Finding(first_content, "error", "required H1 is missing"))
        elif title == "":
            findings.append(Finding(first_content, "error", "H1 title is empty"))

    for index, line in enumerate(lines, 1):
        stripped = line.strip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence or stripped == "":
            continue

        heading = _heading(stripped)
        if heading is not None:
            level = heading[0]
            if level == 1 and index != first_content:
                findings.append(Finding(index, "error", "extra H1"))
            in_file_list = level == 2
            continue

        if in_file_list and (stripped.startswith("- ") or stripped.startswith("* ")):
            _check_list_item(index, stripped, findings, queued, skip_fetch)
            continue

        urls, errors = _scan_links(stripped)
        for message in errors:
            findings.append(Finding(index, "error", message))
        for url in urls:
            _note_link(index, url, findings, queued, skip_fetch)

    if not skip_fetch:
        _check_urls(queued, timeout, fetch or default_fetch, findings)

    findings.sort(key=lambda item: (item.line, 0 if item.severity == "error" else 1))
    return findings


def validate_path(
    path: Path,
    *,
    timeout: float = 10.0,
    fetch: Fetch | None = None,
    skip_fetch: bool = False,
) -> list[Finding]:
    """Read a file and validate it."""
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return [Finding(1, "error", "file is not valid UTF-8")]
    except OSError:
        return [Finding(1, "error", "could not read file")]
    return validate_text(text, timeout=timeout, fetch=fetch, skip_fetch=skip_fetch)


def format_report(path: str, findings: list[Finding], *, strict: bool = False) -> str:
    """Format one file result as pass or fail, with line numbers."""
    status = "fail" if _is_failure(findings, strict) else "pass"
    lines = [f"{status} {path}"]
    for finding in findings:
        lines.append(f"  {finding.line}: {finding.severity}: {finding.message}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    """Run the validator CLI."""
    parser = argparse.ArgumentParser(description="Validate llms.txt files.")
    parser.add_argument("paths", nargs="*", type=Path, help="llms.txt files to check")
    parser.add_argument(
        "--timeout",
        type=float,
        default=10.0,
        help="Seconds to wait for each link (default: 10)",
    )
    parser.add_argument(
        "--skip-fetch",
        action="store_true",
        help="Check syntax only and do not request linked URLs",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Fail when a file has warnings",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run the validator tests",
    )
    args = parser.parse_args(argv)

    if args.self_test:
        return _run_self_test()
    if args.timeout <= 0:
        print("timeout must be greater than 0", file=sys.stderr)
        return 2
    if not args.paths:
        parser.print_help(sys.stderr)
        return 2

    blocks = [
        format_report(
            str(path),
            validate_path(path, timeout=args.timeout, skip_fetch=args.skip_fetch),
            strict=args.strict,
        )
        for path in args.paths
    ]
    print("\n\n".join(blocks))
    failed = sum(block.startswith("fail ") for block in blocks)
    if len(blocks) > 1:
        passed = len(blocks) - failed
        print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


def _request(url: str, timeout: float, method: str) -> tuple[int | None, str | None]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, None
    except urllib.error.HTTPError as exc:
        return exc.code, None
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, (TimeoutError, socket.timeout)):
            return None, "timed out"
        return None, "request failed"
    except (TimeoutError, socket.timeout):
        return None, "timed out"


def _h1_title(line: str) -> str | None:
    match = H1_LINE.fullmatch(line)
    if match is None:
        return None
    return match.group(1).strip()


def _heading(line: str) -> tuple[int, str] | None:
    match = HEADING.fullmatch(line)
    if match is None:
        return None
    return len(match.group(1)), match.group(2).strip()


def _check_list_item(
    line: int,
    text: str,
    findings: list[Finding],
    queued: list[tuple[int, str]],
    skip_fetch: bool,
) -> None:
    match = LIST_ITEM.fullmatch(text)
    if match is None:
        errors = _scan_links(text)[1]
        message = errors[0] if errors else "list item must be [name](url)"
        findings.append(Finding(line, "error", message))
        return

    url = match.group(2)
    notes = match.group(3)
    if notes is None or notes.strip() == "":
        findings.append(Finding(line, "warning", "missing description"))
    _note_link(line, url, findings, queued, skip_fetch)


def _scan_links(line: str) -> tuple[list[str], list[str]]:
    urls: list[str] = []
    errors: list[str] = []
    index = 0
    while index < len(line):
        bracket = line.find("[", index)
        if bracket == -1:
            break
        if bracket > 0 and line[bracket - 1] == "!":
            index = bracket + 1
            continue
        close_bracket = line.find("]", bracket + 1)
        if close_bracket == -1 or line[close_bracket + 1 : close_bracket + 2] != "(":
            if close_bracket == -1 and "(" in line[bracket + 1 :]:
                errors.append("unclosed markdown link")
                break
            index = bracket + 1 if close_bracket == -1 else close_bracket + 1
            continue
        close_paren = line.find(")", close_bracket + 2)
        if close_paren == -1:
            errors.append("unclosed markdown link")
            break
        text = line[bracket + 1 : close_bracket].strip()
        url = line[close_bracket + 2 : close_paren]
        if text == "":
            errors.append("markdown link is missing text")
        elif url.strip() == "":
            errors.append("markdown link is missing a URL")
        elif any(char.isspace() for char in url):
            errors.append("markdown link URL contains spaces")
        else:
            urls.append(url)
        index = close_paren + 1
    return urls, errors


def _note_link(
    line: int,
    url: str,
    findings: list[Finding],
    queued: list[tuple[int, str]],
    skip_fetch: bool,
) -> None:
    parsed = urlparse(url)
    if parsed.scheme == "http":
        findings.append(Finding(line, "warning", "link uses http://"))
    if skip_fetch:
        return
    if parsed.scheme not in {"http", "https"} or parsed.netloc == "":
        findings.append(Finding(line, "error", "link URL is not absolute"))
        return
    queued.append((line, url))


def _check_urls(
    queued: list[tuple[int, str]],
    timeout: float,
    fetch: Fetch,
    findings: list[Finding],
) -> None:
    cache: dict[str, tuple[int | None, str | None]] = {}
    for line, url in queued:
        if url not in cache:
            try:
                cache[url] = fetch(url, timeout)
            except Exception:
                cache[url] = (None, "request failed")
        status, problem = cache[url]
        if problem == "timed out":
            findings.append(Finding(line, "error", "link timed out"))
        elif status != 200:
            detail = "request failed" if status is None else str(status)
            findings.append(Finding(line, "error", f"link did not return 200 ({detail})"))


def _is_failure(findings: list[Finding], strict: bool) -> bool:
    return any(
        finding.severity == "error" or (strict and finding.severity == "warning")
        for finding in findings
    )


def _run_self_test() -> int:
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ValidatorTests)
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    return 0 if result.wasSuccessful() else 1


class ValidatorTests(unittest.TestCase):
    def test_six_fixtures_exist(self) -> None:
        names = sorted(path.name for path in FIXTURES.glob("*.txt"))
        self.assertEqual(
            names,
            [
                "bad-links.txt",
                "http-links.txt",
                "missing-descriptions.txt",
                "missing-h1.txt",
                "not-found.txt",
                "valid.txt",
            ],
        )

    def test_valid_fixture_passes(self) -> None:
        findings = self._validate_fixture("valid.txt")
        self.assertEqual(findings, [])

    def test_missing_h1_fixture(self) -> None:
        findings = self._validate_fixture("missing-h1.txt")
        self.assertEqual(findings, [Finding(1, "error", "required H1 is missing")])

    def test_empty_file_and_blank_h1(self) -> None:
        self.assertEqual(validate_text(""), [Finding(1, "error", "required H1 is missing")])
        self.assertEqual(validate_text("#\n"), [Finding(1, "error", "H1 title is empty")])

    def test_empty_and_relative_urls(self) -> None:
        text = "\n".join(
            [
                "# Docs",
                "",
                "## Docs",
                "",
                "- [Empty](): No URL",
                "- [Relative](/docs/start): Local path",
            ]
        )
        findings = validate_text(text, fetch=_fixture_fetch)
        self.assertEqual(
            findings,
            [
                Finding(5, "error", "markdown link is missing a URL"),
                Finding(6, "error", "link URL is not absolute"),
            ],
        )

    def test_bad_links_fixture(self) -> None:
        findings = self._validate_fixture("bad-links.txt")
        self.assertEqual(
            findings,
            [
                Finding(7, "error", "unclosed markdown link"),
                Finding(8, "error", "markdown link is missing text"),
                Finding(9, "error", "markdown link URL contains spaces"),
                Finding(10, "error", "list item must be [name](url)"),
            ],
        )

    def test_http_links_fixture_warns(self) -> None:
        findings = self._validate_fixture("http-links.txt")
        self.assertEqual(findings, [Finding(7, "warning", "link uses http://")])

    def test_missing_descriptions_fixture_warns(self) -> None:
        findings = self._validate_fixture("missing-descriptions.txt")
        self.assertEqual(findings, [Finding(7, "warning", "missing description")])

    def test_not_found_fixture_fails(self) -> None:
        findings = self._validate_fixture("not-found.txt")
        self.assertEqual(findings, [Finding(7, "error", "link did not return 200 (404)")])

    def test_timeout_reports_line(self) -> None:
        text = (FIXTURES / "valid.txt").read_text(encoding="utf-8")

        def slow(_url: str, _timeout: float) -> tuple[int | None, str | None]:
            return None, "timed out"

        findings = validate_text(text, fetch=slow)
        self.assertTrue(all(item.message == "link timed out" for item in findings))
        self.assertEqual([item.line for item in findings], [9, 10, 14])

    def test_skip_fetch_ignores_status(self) -> None:
        text = (FIXTURES / "not-found.txt").read_text(encoding="utf-8")

        def explode(_url: str, _timeout: float) -> tuple[int | None, str | None]:
            raise AssertionError("fetch should not run")

        findings = validate_text(text, fetch=explode, skip_fetch=True)
        self.assertEqual(findings, [])

    def test_strict_fails_warnings(self) -> None:
        findings = self._validate_fixture("http-links.txt")
        report = format_report("http-links.txt", findings, strict=True)
        self.assertTrue(report.startswith("fail http-links.txt"))
        self.assertIn("7: warning: link uses http://", report)

    def test_cli_reports_pass_and_fail(self) -> None:
        buffer = StringIO()
        with redirect_stdout(buffer):
            code = main(
                [
                    "--skip-fetch",
                    str(FIXTURES / "missing-h1.txt"),
                    str(FIXTURES / "valid.txt"),
                ]
            )
        output = buffer.getvalue()
        self.assertEqual(code, 1)
        self.assertIn("fail ", output)
        self.assertIn("1: error: required H1 is missing", output)
        self.assertIn("pass ", output)
        self.assertIn("1 passed, 1 failed", output)

    def test_live_status_and_timeout(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                self._respond()

            def do_HEAD(self) -> None:
                if self.path == "/get-only":
                    self.send_error(405)
                    return
                self._respond()

            def _respond(self) -> None:
                if self.path == "/slow":
                    time.sleep(1.5)
                code = 200 if self.path in {"/ok", "/get-only", "/slow"} else 404
                self.send_response(code)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, _format: str, *_args: object) -> None:
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{port}"
            text = "\n".join(
                [
                    "# Local",
                    "",
                    "> Summary.",
                    "",
                    "## Docs",
                    "",
                    f"- [Ok]({base}/ok): Reachable",
                    f"- [Get only]({base}/get-only): HEAD is rejected",
                    f"- [Missing]({base}/missing): Gone",
                    f"- [Slow]({base}/slow): Too slow",
                    "",
                ]
            )
            findings = validate_text(text, timeout=0.4)
        finally:
            server.shutdown()
            server.server_close()

        by_line = {item.line: item for item in findings if item.severity == "error"}
        self.assertNotIn(7, by_line)
        self.assertNotIn(8, by_line)
        self.assertEqual(by_line[9].message, "link did not return 200 (404)")
        self.assertEqual(by_line[10].message, "link timed out")
        self.assertTrue(any(item.line == 7 and item.severity == "warning" for item in findings))

    def _validate_fixture(self, name: str) -> list[Finding]:
        text = (FIXTURES / name).read_text(encoding="utf-8")
        return validate_text(text, fetch=_fixture_fetch)


def _fixture_fetch(url: str, _timeout: float) -> tuple[int | None, str | None]:
    if url.endswith("/missing"):
        return 404, None
    return 200, None


if __name__ == "__main__":
    sys.exit(main())

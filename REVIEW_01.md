# REVIEW_01: Gate 1 (Phases 0–3)

Reviewer: Claude · Date: 2026-10-04 · Build reviewed: `dist/goodhart-check-gate1.zip`

## Verdict

**Gate 1 not released yet.** The build quality is high: code is small and readable, the spec was followed closely, ruff is clean, and all 126 tests pass (also on Python 3.13 here). The 5k-line performance target is met.

The problems are all about real-world input. The fixtures are well made, but they were written to the spec. When I ran the scanner on real repositories, it failed in two directions:

- **Misses:** a diff with three obvious cheats produced **zero findings**. All three were caused by file classification.
- **Noise:** across 680 commits of honest, maintainer-written history in five popular repos, 23 commits would have **failed CI on a high finding**. Most of those are false positives with a small number of root causes.

Fix the `must` items, add the listed regression fixtures, and rerun the noise check (section 5). After that, Phase 4 can start.

## What I ran

1. Unzipped the build, installed with `-e .`, then ran `ruff check`, `ruff format --check` and `pytest`. All pass.
2. Read all of `src/` against `docs/HANDOFF.md`.
3. Ran hand-written adversarial diffs in a scratch git repo and as patch files.
4. **Noise corpus:** ran full-mode `scan --base C~1 --head C` on recent first-parent, non-merge commits of five repos, pinned at the SHAs below. These are human-maintained projects, so a high finding there is presumed to be a false positive unless the commit really removes or skips coverage.

| Repo | Pinned SHA | Commits scanned | Commits with a high | Commits with a high or medium |
|---|---|---:|---:|---:|
| pallets/click | `06b2a678` | 80 | 1 | 3 |
| encode/httpx | `b5addb64` | 150 | 6 | 9 |
| sindresorhus/ky | `0d59458a` | 150 | 3 | 6 |
| pydantic/pydantic | `e87e11b7` | 150 | 9 | 18 |
| vitest-dev/vitest | `964e1a44` | 150 | 4 | 13 |
| **Total** | | **680** | **23** | **49** |

Notable raw counts: vitest GH006 high ×53 (one commit), GH008 medium ×57; pydantic GH003 high ×18, GH001 high ×16; ky GH010 ×49.

---

## MUST (fix before Phase 4)

### M1. Content-based Python classification is far too broad
`classify()` marks any `.py` file as `test` if it contains `def test\w*(` or the word `TestCase` anywhere.

- **Miss:** `src/db.py` with a method `def test_connection(self)`, which is common in DB and HTTP clients, becomes a test file. GH006, GH008 and GH009 then never run on it. My probe added `os.environ.get("PYTEST_CURRENT_TEST")` and `except Exception: pass` to that file. Both were silent.
- **False high:** remove that method in a later commit and GH001 fires *"Test file removed from the suite"* on a source file that still exists, because `old_kinds` was test and `new_kinds` is source.
- `def testable(`, `def tester(`, and a docstring mentioning `TestCase` also trigger it.

**Fix:** classify by path first. Use content only for files outside source-looking paths, and require real test-framework signals. For Python: the file imports `pytest` or `unittest` *and* defines a module-level `test*` function or a `TestCase` subclass (AST, not regex). A file's kind should not flip between base and head on content alone. If it does, treat it by its head kind and never emit GH001.

### M2. Default test globs miss most JS/TS layouts
Defaults cover `tests/**`, `.test/.spec` for `.ts`/`.js`, and `__tests__/**` only.

- `web/Button.test.tsx` with `it("renders")` → `it.skip("renders")`: classified `source`, **missed**. The same applies to `.test.jsx` with `it.only`, which is the most common React test layout.
- `test/` (singular) is not covered. ky and vitest both use it, and ky's AVA tests are invisible.
- JS content detection only knows vitest, `@jest/globals`, mocha and node:test. Jest is usually used without imports.

**Fix:** default globs should add `test/**`, `**/test/**`, `**/tests/**`, `spec/**`, `**/spec/**`, `e2e/**`, and `**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}` (expand to explicit patterns, since fnmatch has no braces). Add content signals for `ava`, `@playwright/test`, `bun:test`, `tap`, `uvu`, and `@testing-library/*`. In the existing vitest check, match `'vitest'` exactly and do not treat `vitest/config` or a type-only import as a test signal.

### M3. Default `--base` silently scans nothing on `main`
On `main` with no upstream (a solo repo committing straight to main), `default_base` returns `merge-base(main, HEAD) == HEAD`. The scan covers 0 files and exits 0. This is the default command for most solo users, and it breaks the "no silent failure" rule.

**Fix:** if the resolved merge base equals head, fall back to `HEAD~1`. If even that yields an empty diff, print a one-line notice to stderr naming the range. Add a test.

### M4. `ast.literal_eval` floods stderr with `SyntaxWarning`
GH006 `_values()` runs `literal_eval` on JS string literals. One vitest commit printed **~7,400 `SyntaxWarning: invalid escape sequence` lines** to stderr. The Claude Code hook in Phase 5 feeds stderr back to the agent, so this would be a disaster there.

**Fix:** wrap literal parsing in `warnings.catch_warnings(); warnings.simplefilter("ignore")`, or use a small JS string unescape instead of `literal_eval` for JS. Add a test asserting the CLI's stderr is empty on a JS file containing `'\.'`, `'\d'` and `` `\` `` escapes.

### M5. GH006 high branch matches its own condition literal and ignores the base
On vitest's formatting commit (`a029e76a`, oxc migration), GH006 raised **53 high** findings, for example:
- `typeof value === 'string'` → `return 'string'` (getType.ts)
- `state.current.type === 'test' ? state.current.name : undefined`, where the "output" literal is the condition literal on the same line.

Two bugs cause this:
1. On a ternary or single-line branch, the compared literal is also counted as the returned or assigned literal. Exclude literals that appear in the condition from the output match.
2. The high path never checks `base_values`, so reformatted or reindented existing code counts as a new special case. Require that the output literal (or the whole branch) was not present in the base file, the same way the medium path does.

Also, test **inputs** currently come from every test file in the diff plus all related tests. Generic literals such as `'function'`, `'string'`, `'none'` and `'test'` end up as "inputs". After fixing 1 and 2, re-measure. If noise persists, require the input and the expectation to come from the *same* test function.

### M6. JS test-name regex breaks on escaped quotes and mixed quotes
`TEST_PATTERN` captures names with `([^'"\`\n]+)\1`:
- `'doesn\'t'` is captured as `doesn\`, so several distinct tests collapse to one name. GH004's `dict` then pairs the wrong tests.
- `"doesn't"` (double-quoted name containing an apostrophe) **doesn't match at all**. A formatter switching quote style therefore looks like deleted tests. That accounts for most of vitest's 36 GH002 highs (e.g. *"Test count decreased: 41 → 38 :: correctly doesn\, correctly doesn\…"*).

**Fix:** `(['"\`])((?:\\.|(?!\1).)*)\1` for the name, then unescape it. Key tests by `(describe-path, name, ordinal)` so duplicate names in different `describe` blocks don't collide (GH004 uses a name-keyed dict today).

### M7. GH001 and GH002 fire high on moved and helper files
- **Moves:** httpx *"Moving test cases into test_url.py"* and pydantic *"Migrate pydantic-core tests to main tests directory"* produced high GH001 and GH002 on every file. When git's rename detection doesn't pair the files (moved plus edited, or split across files), the removed test names still appear as **added** test names in other files of the same diff. Compute that across `ctx.changes`. If at least 80% of the removed names reappear elsewhere, downgrade to `info` with *"tests appear to have moved to: …"*. Partial overlap downgrades proportionally to `medium`.
- **Helpers:** GH001 fires high on deleted `tests/**/__init__.py`, `benchmarks/complete_schema.py` and other non-test files under a test glob. Only fire GH001 when the deleted file actually defined at least one test (base test count > 0). Otherwise emit nothing.
- **Duplicates:** when a test file is deleted, GH001 and GH002 both fire ("5 → 0"). Skip GH002 for deleted files, since GH001 covers them.

### M8. GH003 treats conditional skips like unconditional ones
Pydantic: 18 high GH003 findings, nearly all `@pytest.mark.skipif(platform.python_implementation() == 'PyPy', …)`, `skipif(sys.version_info >= (3, 15))`, or `skipif(not email_validator)`. These are environment gates and a normal pattern.

**Fix:** keep `high` for unconditional `skip`, `xfail`, `.skip`, `.only`, `xit` and `pytest.skip(...)` at test-body top level. Use `medium` for `skipif` (and `pytest.skip` inside an `if`) whose condition references `sys.platform`, `sys.version_info`, `platform.*`, `os.name`, or a module-availability name. `skipif(True)` and other constant conditions stay `high`.

### M9. Missed skip variants
- `pytestmark = pytest.mark.skip(...)` (and `= [pytest.mark.skip(...)]`), the module-level skip that disables a **whole file**: missed. Must be `high`.
- `from pytest import mark` → `@mark.skip` / `@mark.xfail`: missed.
- JS: `xtest(`, `fit(`, `fdescribe(` (focused = `.only` equivalent), `test.skip.each` / `it.only.each` (verify these match).

### M10. Regression fixtures for everything above
Add each probe as a fixture, plus at least one *real* snippet per noise cause from the corpus. Commit messages and SHAs are listed above; trim the diffs to the relevant hunk. Required at minimum:
`py_source_with_test_method` (M1), `tsx_skip` and `jsx_only` (M2), `jsx_test_dir_singular` (M2), `gh006_ternary_same_literal` and `gh006_reformat_existing_branch` (M5), `js_name_escaped_quote` and `js_quote_style_change` (M6), `tests_moved_between_files`, `init_py_deleted` and `deleted_file_no_gh002` (M7), `skipif_platform_medium` and `skipif_true_high` (M8), `pytestmark_skip` (M9).

---

## SHOULD (fix, or answer in PROGRESS.md)

**S1. GH009: split runner detection from CI detection.** `process.env.CI ? 20_000 : 5000` for timeouts, and `!process.env.CI` for TTY behavior, are common and legitimate. Proposed: `PYTEST_CURRENT_TEST`, `JEST_WORKER_ID`, `VITEST`, `NODE_ENV === 'test'`, and `pytest`/`unittest` in `sys.modules` stay `high`. Plain `CI` env checks drop to `medium`. Also, GH009 currently fires on matches inside string literals (vitest CLI help text: ``'(default: `!process.env.CI`)'``). Only match when the hit isn't wholly inside a string.

**S2. GH009 missed patterns:** `os.getenv("CI")`, `"CI" in os.environ`, `os.environ["CI"]`, `"pytest" in sys.argv[0]`, `import.meta.env.MODE === 'test'`, `import.meta.vitest`.

**S3. GH008 JS: bare `catch {}` → `low`.** Optional-binding empty catches are idiomatic in JS cleanup paths, and they made up 57 of vitest's mediums and 8 of ky's. Keep `medium` for `catch (e) { return null/false/[]/{} }` inside functions, and for Python broad `except: pass`. Also, `numbers()` in the JS full-mode path uses `+ 2`, which looks like an off-by-one that can attribute an existing catch to a newly added next line. Please check.

**S4. Rule crashes take down the whole scan.** `engine.scan` only catches `SyntaxError`, `ValueError` and `configparser.Error` per rule. Any other exception (`RecursionError` on deeply nested ASTs, `IndexError` and so on) exits 3 for the whole scan. In the stop hook that means fail-open on agent-controlled input. Catch `Exception` per rule × file, emit GH000 with `"<rule>: <ExcType>: <msg>"`, and continue.

**S5. Quadratic regex on hostile input.** In `comment_text` / `mask` / `TEST_PATTERN`, a 40 KB string of `\'` or unterminated backticks takes **~17 s**, and 3,000 `it(` lines without closers take 4.6 s. Fixes: make string patterns possessive-equivalent (e.g. `'[^'\\\n]*(?:\\.[^'\\\n]*)*'`), stop strings at newline for `'`/`"`, and skip any file > 1 MB or with a line > 20k chars with a GH000 note. Add a perf test with these inputs (< 1 s).

**S5b. Huge commits.** The 1,000-file oxc reformat commit took about 2 minutes, while normal commits take about 0.4 s. Fine for v1, but print a stderr note when > 300 files change so a hook user knows why it's slow.

**S6. GH005 / GH004: `pytest.raises`.** `pytest.raises(ZeroDivisionError)` → `pytest.raises(Exception)` is not flagged. The spec table only listed `assertRaises`/`toThrow`, which was my omission, but it's the pytest-native form. Add it to `_weaker`. Also make `assertion_line()` recognise `pytest.raises(`, `with self.assertRaises`, and mock assertions (`.assert_called*`, `.assert_awaited*`, `.assert_not_called`) so patch-mode GH004 counts them. Update `python.assertion_count` to match.

**S7. GH006 misses parametrize tables.** Expected values in `@pytest.mark.parametrize(..., [(input, expected), ...])` and in `it.each`/`test.each` tables are never collected. That's the typical shape of the "hardcode the test cases" cheat. Collect literals from parametrize argvalues: treat the column named `expected`/`want`/`output`/`result` (or the last column) as expectations and the others as inputs.

**S8. GH007 test-script and selection gaps.**
- `"test": "jest"` → `"test": "echo ok"` is not flagged. Flag it when the old script ran a test runner (`TEST_RUN`) and the new one doesn't.
- pytest `-m "not slow"`-style marker selection in `addopts` isn't a selector. Add `-m`.

**S9. Classification signal in the report.** Add a `kinds` field per file to the JSON (or a `files` array) so classification mistakes like M1 and M2 are visible to users. This would have made both bugs obvious. It's a schema addition, so do it before the Phase 4 freeze.

---

## CONSIDER (optional, or v1.1 list)

- **C1.** Early `return` / `return None` inserted at the top of a test body keeps the assertion count the same and isn't detected. Candidate GH013 (`test-body-short-circuited`). Add it to the v1.1 list.
- **C2.** "Delete a real test, add a trivial one with a new name" keeps the counts equal. GH002 could compare name sets and report removed names even when the count is unchanged (as medium), while still respecting the M7 move detection.
- **C3.** `except (ValueError, Exception): pass` (a tuple containing a broad type) isn't treated as broad.
- **C4.** GH010 is the noisiest rule (ky 49, pydantic 38, all `low`). Fine as-is. Consider grouping per *commit* in text output once the Phase 4 reports land.

---

## Answers to Sol's open questions

1. **Section 8 vs section 6 (legit scenarios):** Your reading is correct. Section 6 wins. A "negative" legit-if fixture may assert a *downgraded* finding. I'll fix the wording in the handoff. Keep doing what you did.
2. **GH006 reduced confidence in patch mode:** Approved.
3. **Extra `.test.js` / `.spec.js` globs:** Approved, and expanded in M2.
4. **Working mode includes untracked files:** Approved, and important, since agents create new files constantly.
5. **ZIP instead of remote:** Fine for Gate 1. For Gate 2, a private GitHub repo is preferred so the review can run directly against it.

## Handoff update

`docs/HANDOFF.md` was replaced with v1.1. Only sections 3 (D6), 8.3 and 11 changed. Gate 2's real-world corpus no longer depends on ATLAS runs; it comes from Dippo's own repo history, ImpossibleBench on a local model, METR transcripts and public PRs. 8.3 also asks for `scripts/scan_history.py`. The `scripts/noise_check.py` below is a close sibling, so build them together.

---

## 5. Noise check to include in the repo (needed for re-review)

Add `scripts/noise_check.py`. Given a repo path and N, it scans the last N first-parent non-merge commits (full mode) and prints per-rule × severity counts, the number of commits with any high finding, and up to 5 examples per rule. Add `docs/noise-baseline.md` with results on the five repos at the pinned SHAs above.

**Targets for Gate 1 release:**
- Commits failing on high: **≤ 8 of 680** (currently 23). Each remaining one is listed with a one-line justification ("real test removal", etc.).
- **0** GH006 high findings across the corpus.
- **0** GH009 high findings from `process.env.CI`-style checks.
- **0** stderr lines across the whole corpus run.
- The original 126 tests and all new M10 fixtures pass. Ruff clean.

Reference implementation I used (adapt freely; it needs `--depth 202` clones):

```python
import collections, subprocess, sys, warnings
from pathlib import Path
from goodhart.engine import scan
from goodhart.git import load_git

repo, n = Path(sys.argv[1]), int(sys.argv[2])
commits = subprocess.run(
    ["git", "-C", str(repo), "rev-list", "--first-parent", "--no-merges", f"-n{n}", "HEAD"],
    capture_output=True, text=True,
).stdout.split()
tally, failing = collections.Counter(), 0
for c in commits:
    try:
        r = scan(load_git(base=f"{c}~1", head=c, cwd=repo))
    except Exception as e:
        print("ERR", c[:8], type(e).__name__, e); continue
    failing += any(f.severity == "high" for f in r.findings)
    tally.update((f.rule_id, f.severity) for f in r.findings)
print(repo.name, "commits failing on high:", failing)
for k, v in sorted(tally.items()):
    print(" ", k, v)
```

## Next steps

1. Sol fixes M1–M10, addresses S1–S9 (or answers them in PROGRESS.md), adds the noise script and baseline, and stops.
2. I rerun the corpus and the probes and write `REVIEW_01b.md`. If the targets are met, Gate 1 is released and Phase 4 starts.

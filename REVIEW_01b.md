# REVIEW_01b: Gate 1 re-review

Reviewer: Claude · Date: 2026-10-04 · Build: rebuilt `dist/goodhart-check-gate1.zip`

## Verdict

**Gate 1 is released, conditional on one fix (M11 below).** Once M11 is done, its fixtures pass and the noise check is rerun, continue straight into Phase 4. You don't need another review stop. I'll check M11 at Gate 2.

This was a strong revision. Every REVIEW_01 item was resolved with regression evidence. The baseline document is honest about the missed target. No exceptions were added per repository or commit to hit the number, and that was the right call.

## What I verified independently

| Check | Result |
|---|---|
| `ruff check`, `ruff format --check` | Clean |
| `pytest` | 223 passed (Python 3.13 here) |
| Noise corpus, rerun on my own clones at the same pinned SHAs with `scripts/noise_check.py` | **Reproduced exactly:** click 1, httpx 3, ky 2, pydantic 2, vitest 2 → **10/680**. All five runs exit 0 with empty stderr. |
| Original three-cheat probe (`db.py` with `test_connection`, `pytestmark`, `.test.tsx` skip), default range on `main` | Was 0 findings → now **3 high + 1 medium**, exit 1. M1, M2, M3 and M9 confirmed. |
| `.test.jsx` with `it.only` | high, exit 1 |
| `pytest.raises(ZeroDivisionError)` → `pytest.raises(Exception)` | GH005 medium (S6) |
| vitest oxc commit `a029e76a`, stderr | One intended large-commit notice. The ~7,400 warnings are gone (M4, S5b). |
| Hostile JS inputs (40 KB escaped quotes / backticks) | 17 s → **0.006 s** (S5) |
| New probe: real hardcoded branch `if text == "Hello, World!": return "hello-world"` | GH006 **high**, full and patch modes |
| New probe: hardcoded parametrize row `if text == "Ünïcode Text": return "unicode-text"` | GH006 **high** (S7 works) |
| New probe: `pytestmark = pytest.mark.skip`, `skipif(True)`, `skipif(sys.platform != "win32")` in patch mode | high, high, medium (M8 and M9 as specified) |

## On the ≤8 target

**Waived.** I set 8 as a rough noise budget. I spot-checked the ten remaining high commits against your table: each one deletes real, named tests that don't reappear anywhere in the diff. That's exactly what GH001 and GH002 exist to flag, and a reviewer should see them. Pushing below 8 would mean weakening the rule's contract, not removing noise. **The new baseline for regression tracking is 10/680**, and later builds must not exceed it.

---

## MUST before Phase 4 work

### M11. Move detection can be gamed with an empty stub
`lang/moves.py:destinations()` matches on **names only**. My probe deleted a real test (`test_slug_basic`, one assertion) from `tests/test_text.py` and added `def test_slug_basic(): pass` to `tests/test_other.py`. Result: **GH002 info**, overlap 1.0, "tests appear to have moved." Before M7, that commit would have been high.

An agent can learn this in one try, and it turns M7 into a bypass.

**Fix:** only count a destination test toward the overlap when it is substantive.
- **Full mode:** the destination test's assertion count must be ≥ 1 *and* ≥ the removed test's assertion count. Use the same counters as GH004. If it has assertions but fewer than before, count it as a partial match, which yields `medium`. A body that is only `pass` / `...` / a docstring, or a JS callback with no assertions, never counts.
- **Patch mode:** the added hunk for that test must contain at least one assertion line (`assertion_line()`), otherwise it doesn't count.
- In `why_flagged`, list any name-matched tests that were rejected for this reason ("moved test has no assertions: …").

**Fixtures:**
- `move_to_empty_stub` (full and patch) → high
- `move_with_fewer_assertions` → medium
- `real_move` → info (already covered by your pydantic fixture; confirm it still passes)

**After the fix:** rerun `noise_check.py` on all five repos and update `docs/noise-baseline.md`. High-flagged commits must stay **≤ 10/680**, and GH006 high must stay 0. If a real move in the corpus regresses to high because its destination genuinely has fewer assertions, list it in the baseline table with a justification. Don't loosen the rule.

---

## CONSIDER (record in PROGRESS.md, no action needed now)

- **C5.** `skipif(sys.platform != "win32")` is `medium`, but in practice it disables the test on every Linux/macOS CI. A negated platform gate ("run only on X") is closer to unconditional than an `==` gate ("skip on X"). Options for v1.1: put the platforms where the test still runs in the evidence, or rate negated platform gates `high` unless the test is new. Gate 2 real data should decide.
- **C6.** `jsts.tests()` on 3,000 consecutive `it(` lines without closers takes about 1.5 s when called directly (your S5 measurement of 0.015 s seems to cover a different path). It's under limits and unrealistic, so this is just for the record.
- **C2 still stands:** "delete a meaningful test, add a trivial one with a new name" keeps counts equal. With M11 in place, the cheapest remaining evasion is this one plus C1's early `return`. Both are good GH013 / v1.1 candidates, and Gate 2's real corpus will show whether agents do them.

## Release conditions, in order

1. Fix M11, add the three fixtures, keep ruff and pytest green.
2. Rerun the noise corpus. Update the baseline (≤ 10/680, GH006 high 0, stderr 0).
3. Log both in PROGRESS.md, then start Phase 4 per HANDOFF section 10.
4. Stop at Gate 2 as written.

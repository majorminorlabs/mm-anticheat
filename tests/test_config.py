"""Configuration validation, precedence-independent allowances and AC012 interplay."""

import time

import pytest

from mm_anticheat.config import Allow, Config, ConfigError, inline_allow, load_config
from mm_anticheat.engine import scan

from .test_rule_edges import run_changes


def changed_skip(before="", after=None, full=True):
    test = "def test_a():\n    assert 3 == 3\n"
    return run_changes(
        [
            (
                "tests/test_a.py",
                before or test,
                after or '@pytest.mark.skip(reason="flaky")\n' + test,
            )
        ],
        full=full,
    )


def test_load_config_all_fields(tmp_path):
    path = tmp_path / ".anticheat.toml"
    path.write_text("""fail_on = "medium"
skip_rules = ["AC010"]
[paths]
test_globs = ["qa/**"]
ignore_globs = []
[[allow]]
rule = "AC001"
path = "tests/legacy/**"
reason = "Legacy removal reviewed in #212"
""")
    config = load_config(path)
    assert config.fail_on == "medium"
    assert config.skip_rules == {"AC010"}
    assert config.test_globs == ("qa/**",)
    assert config.ignore_globs == ()
    assert config.allows == [Allow("AC001", "tests/legacy/**", "Legacy removal reviewed in #212")]
    assert load_config().test_globs == Config().test_globs


@pytest.mark.parametrize(
    "text",
    [
        "unknown = true",
        'fail_on = "info"',
        "fail_on = 7",
        'skip_rules = "AC001"',
        'skip_rules = ["AC999"]',
        '[paths]\ntest_globs = "qa/**"',
        "[paths]\nunknown = []",
        "paths = []",
        "allow = {}",
        '[[allow]]\nrule = "AC001"\npath = "tests/**"',
        '[[allow]]\nrule = "AC001"\npath = "tests/**"\nreason = " "',
        '[[allow]]\nrule = []\npath = "tests/**"\nreason = "ok"',
        '[[allow]]\nrule = "AC999"\npath = "tests/**"\nreason = "ok"',
        '[[allow]]\nrule = "AC001"\npath = "tests/**"\nreason = "ok"\nextra = true',
        "fail_on = [",
    ],
)
def test_invalid_configuration_rejected(tmp_path, text):
    path = tmp_path / "config.toml"
    path.write_text(text)
    with pytest.raises(ConfigError):
        load_config(path)


def test_unreadable_and_nonutf8_config(tmp_path):
    with pytest.raises(ConfigError):
        load_config(tmp_path / "absent")
    path = tmp_path / "config"
    path.write_bytes(b"\xff")
    with pytest.raises(ConfigError):
        load_config(path)


@pytest.mark.parametrize("full", [True, False])
@pytest.mark.parametrize("placement", ["above", "same"])
def test_added_inline_allow_with_reason_is_deferred(full, placement):
    base = "def test_a():\n    assert 3 == 3\n"
    allow = '# anticheat: allow AC003 reason="reviewed flaky test in #88"'
    after = (
        allow + '\n@pytest.mark.skip(reason="flaky")\n' + base
        if placement == "above"
        else '@pytest.mark.skip(reason="flaky") ' + allow + "\n" + base
    )
    result = changed_skip(after=after, full=full)
    skip = next(f for f in result.findings if f.rule_id == "AC003")
    added = next(f for f in result.findings if f.rule_id == "AC012")
    assert not skip.allowed and "applies only after it is merged" in skip.why_flagged
    assert not added.allowed
    assert result.exit_code("high") == 1
    assert result.exit_code("medium") == 1


@pytest.mark.parametrize("reason", ["", ' reason=""', ' reason="   "'])
def test_missing_reason_does_not_suppress(reason):
    result = changed_skip(
        after="# anticheat: allow AC003"
        + reason
        + '\n@pytest.mark.skip(reason="flaky")\ndef test_a():\n    assert 3 == 3\n'
    )
    assert not next(f for f in result.findings if f.rule_id == "AC003").allowed
    assert any(
        f.rule_id == "AC000" and f.rule_name == "allow-missing-reason" and f.severity == "low"
        for f in result.findings
    )
    assert result.exit_code() == 1


def test_allow_existing_comment_does_not_add_ac012():
    comment = '# anticheat: allow AC003 reason="reviewed"\n'
    result = changed_skip(
        before=comment + "def test_a():\n    assert 3 == 3\n",
        after=comment + '@pytest.mark.skip(reason="flaky")\ndef test_a():\n    assert 3 == 3\n',
    )
    assert next(f for f in result.findings if f.rule_id == "AC003").allowed
    assert not any(f.rule_id == "AC012" for f in result.findings)


@pytest.mark.parametrize("full", [True, False])
@pytest.mark.parametrize("placement", ["above", "same"])
def test_js_inline_allow(full, placement):
    code = "const flag = process.env.VITEST;"
    comment = '// anticheat: allow AC009 reason="runner integration"'
    after = comment + "\n" + code if placement == "above" else code + " " + comment
    result = run_changes([("src/a.ts", "", after + "\n")], full=full)
    assert not next(f for f in result.findings if f.rule_id == "AC009").allowed
    assert not next(f for f in result.findings if f.rule_id == "AC012").allowed
    assert result.exit_code() == 1 and result.exit_code("medium") == 1


def test_path_allow_and_rule_scope():
    result = changed_skip()
    config = Config(allows=[Allow("AC003", "**/test_a.py", "Approved flaky case")])
    result = scan(result.data, config)
    assert result.findings[0].allowed
    assert result.exit_code() == 0
    result = scan(result.data, Config(allows=[Allow("AC001", "tests/**", "Different rule")]))
    assert not result.findings[0].allowed


def test_ac012_cannot_allow_itself_inline_but_config_can():
    result = changed_skip(
        after='# anticheat: allow AC012 reason="approve itself"\ndef test_a():\n    assert 3 == 3\n'
    )
    assert result.findings[0].rule_id == "AC012" and not result.findings[0].allowed
    result = scan(
        result.data, Config(allows=[Allow("AC012", "tests/**", "Owner-approved directive")])
    )
    assert result.findings[0].allowed
    assert result.exit_code("medium") == 0


@pytest.mark.parametrize(
    "suffix,text",
    [
        (
            "py",
            'note = "# anticheat: allow AC009 reason=\\"fake\\""\n'
            'flag = os.getenv("PYTEST_CURRENT_TEST")\n',
        ),
        (
            "ts",
            'const note = "// anticheat: allow AC009 reason=\\"fake\\"";\n'
            "const flag = process.env.VITEST;\n",
        ),
    ],
)
def test_allow_strings_do_not_suppress(suffix, text):
    result = run_changes([("src/a." + suffix, "", text)])
    assert not next(f for f in result.findings if f.rule_id == "AC009").allowed
    assert not any(f.rule_id == "AC012" for f in result.findings)


def test_allow_two_lines_away_does_not_suppress():
    result = changed_skip(
        after='# anticheat: allow AC003 reason="distant"\n# another line\n'
        '@pytest.mark.skip(reason="flaky")\ndef test_a():\n    assert 3 == 3\n'
    )
    assert not next(f for f in result.findings if f.rule_id == "AC003").allowed


def test_hostile_unterminated_reason_is_bounded():
    start = time.perf_counter()
    assert inline_allow('# anticheat: allow AC003 reason="' + '\\"' * 20_000) is None
    assert time.perf_counter() - start < 1

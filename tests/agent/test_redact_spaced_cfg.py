"""Spaced ``key = value`` config assignments (#130827): config secrets masked, source code kept."""

import pytest

from agent.redact import redact_for_egress, redact_sensitive_text, redact_terminal_output


@pytest.fixture(autouse=True)
def _ensure_redaction_enabled(monkeypatch):
    monkeypatch.delenv("HERMES_REDACT_SECRETS", raising=False)
    monkeypatch.setattr("agent.redact._REDACT_ENABLED", True)


@pytest.mark.parametrize("text, secret", [
    ('password = "hunter2"\n', "hunter2"),                       # the issue repro
    ("[database]\npassword = 'x9Kp2LmQ'\n", "x9Kp2LmQ"),           # INI, single-quoted
    ('[server]\ndb.password = "S3cretVal"  # prod\n', "S3cretVal"),  # TOML dotted + comment
    ('  5|password = "abc123def456"\r\n', "abc123def456"),        # read_file gutter, CRLF
    ("secret = a1b2c3d4e5f6a7b8c9d0e1f2\n", "a1b2c3d4e5f6a7b8c9d0e1f2"),  # unquoted opaque
])
def test_spaced_config_secret_masked(text, secret):
    assert secret not in redact_for_egress(text)
    assert secret not in redact_terminal_output(text, "cat ~/.hermes/.env")


@pytest.mark.parametrize("key", ["password", "db_password", "DB_PASSWORD", "client_secret"])
def test_spaced_quoted_value_with_space_masked_whole(key):
    # The adjacent form's value stops at whitespace; a quoted spaced value must not leak its tail.
    out = redact_sensitive_text(f'{key} = "hunter 2 horse"\n')
    assert "hunter" not in out and "horse" not in out


@pytest.mark.parametrize("line", [
    'password = getpass.getpass("Password: ")',
    "auth = HTTPBasicAuth(user, password)",
    "credentials = session.get_credentials()",
    "self.password = password",
    "this.secret = secret;",
    "  auth = None",
    '  password = ""',
    "  password = input()",
    "token = wintypes.HANDLE()",
    "auth_store = _load_auth_store()",
    "api.token = self._access_token",
    "password = os.environ",
    'password = os.environ["DB_PASSWORD"]',
    "secret = null",
    "token = tokens[0]",
    "auth = a or b",
    'auth_type = "oauth"',
    'auth = "header"',
    'no_token_msg = "no Codex OAuth token found (run: hermes model)"',
    "password => value",
    "password =~ /re/",
    'password = "prefix-" + suffix',
    'secret = "${SECRET}"',
])
def test_spaced_source_code_unchanged(line):
    text = f"```python\n{line}\n```\n"
    assert redact_sensitive_text(text) == text
    assert redact_for_egress(text) == text


@pytest.mark.parametrize("text", [
    "password" * 1500 + "." * 1500 + " = ",  # `[..]*NAME[..]*` keys backtracked per start offset
    "a." + "password" * 6000 + " = ",
    "  5|" + "password" * 6000 + " = ",
], ids=["dotted-run", "dotted-prefix", "anchored-gutter"])
def test_spaced_pass_linear_on_long_keyword_runs(text):
    import time

    from agent.redact import _mask_token
    from agent.redact_spaced_cfg import redact_spaced_cfg_assignments

    start = time.perf_counter()
    redact_spaced_cfg_assignments(text, _mask_token)
    assert time.perf_counter() - start < 1.0

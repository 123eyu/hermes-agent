"""Doctor npm-audit remedy guidance — the fix must persist across `hermes update`.

Regression for #116774: `npm audit fix` on a managed install is reverted by the
next `hermes update`, because the update's frozen install reifies the COMMITTED
root lockfile (then `package-lock.json`, now `pnpm-lock.yaml`) and restores the
pinned (vulnerable) versions. The doctor's root-row remedy used to prescribe exactly
that doomed local command (`run: cd <root> && npm audit fix --workspaces=false`),
sending users into a fix→reintroduce loop. The durable remedy is an upstream
lockfile bump; the doctor must never prescribe a local mutating fix command, and
the shipped root lockfile must audit clean so the finding never appears at all.
"""

import json
import os
import subprocess
from unittest.mock import patch

import pytest

from hermes_cli import doctor_tools
from hermes_cli.doctor_report import Finding


def _audit_json(critical=0, high=0, moderate=0):
    return json.dumps({
        "metadata": {"vulnerabilities": {
            "critical": critical, "high": high, "moderate": moderate,
            "low": 0, "info": 0, "total": critical + high + moderate,
        }},
    })


def _run_audit_one(capsys, audit_extra, audit_stdout):
    issues: list[str] = []
    completed = subprocess.CompletedProcess([], 0, stdout=audit_stdout, stderr="")
    with patch.object(doctor_tools.subprocess, "run", return_value=completed):
        doctor_tools._audit_one("pnpm", "C:/fake/root", "Root npm package",
                                audit_extra, issues)
    return capsys.readouterr().out, issues


def test_root_remedy_never_prescribes_local_audit_fix(capsys):
    """The root row must not tell users to run a mutating `npm audit fix`: the
    next `hermes update` reinstalls from the committed lockfile and reverts it
    (#116774)."""
    out, issues = _run_audit_one(capsys, ["--filter", "."], _audit_json(high=1, moderate=1))
    assert "run: cd" not in out
    assert "audit fix" not in out
    assert "--fix" not in out
    assert "lockfile bump" in out
    assert issues == [
        "Root npm package has 2 npm vulnerabilities; wait for an upstream lockfile fix, then update "
        "your installation (Docker: pull a rebuilt image; recreating the same image restores the same dependencies)"
    ]


def test_npm_audit_only_finding_does_not_offer_doctor_fix(capsys):
    """npm lockfile findings need an upstream image or lockfile update (#136806)."""
    from hermes_cli import doctor

    doctor._print_summary(False, Finding(manual_issues=["web workspace has 1 npm vulnerability"]))

    out = capsys.readouterr().out
    assert "web workspace has 1 npm vulnerability" in out
    assert "hermes doctor --fix" not in out




def test_clean_tree_reports_no_known_vulnerabilities(capsys):
    out, issues = _run_audit_one(capsys, ["--filter", "."], _audit_json())
    assert "no known vulnerabilities" in out
    assert issues == []


def test_failed_audit_is_never_reported_as_clean(capsys):
    """pnpm prints a failed audit (no lockfile, a registry without the audit endpoint) to stderr with
    an empty stdout; npm prints ``{"error": ...}`` (ENOLOCK). Neither carries counts."""
    for stdout in ("", json.dumps({"error": {"code": "ENOLOCK"}})):
        out, issues = _run_audit_one(capsys, ["--filter", "."], stdout)
        assert out == ""
        assert issues == []


def test_root_audit_row_is_not_mislabeled_as_agent_browser(monkeypatch, tmp_path, capsys):
    """The root package.json row (js-yaml, semver, eslint tooling) names itself, not a browser
    driver it never audits (#122223)."""
    import hermes_cli.doctor as doctor_mod
    from gateway.platforms import whatsapp_common

    project = tmp_path / "project"
    (project / "node_modules").mkdir(parents=True)
    monkeypatch.setattr(doctor_mod, "PROJECT_ROOT", project)
    monkeypatch.setattr(doctor_tools, "_pm_tool_path", lambda name: f"/usr/bin/{name}" if name == "pnpm" else None)
    monkeypatch.setattr(whatsapp_common, "resolve_whatsapp_bridge_dir", lambda: tmp_path / "no-whatsapp-bridge")

    completed = subprocess.CompletedProcess([], 0, stdout=_audit_json(), stderr="")
    monkeypatch.setattr(doctor_tools.subprocess, "run", lambda *a, **kw: completed)

    doctor_tools._check_npm_audit(False)

    out = capsys.readouterr().out
    assert "agent-browser" not in out.lower()
    assert "Root npm package deps" in out


def test_doctor_npm_audit_never_touches_sealed_bundle_or_creates_mirror(monkeypatch, tmp_path):
    """Read-only doctor checks must not write inside a sealed bundle or mirror scripts into HERMES_HOME."""
    from pathlib import Path
    import hermes_cli.doctor as doctor_mod

    project = tmp_path / "Hermes.app" / "Contents" / "Resources" / "agent-payload" / "hermes-agent"
    install_bridge = project / "scripts" / "whatsapp-bridge"
    install_bridge.mkdir(parents=True)
    (install_bridge / "bridge.js").write_text("// bridge\n", encoding="utf-8")
    (project / "install-stamp.json").write_text(
        json.dumps({"payload": "bundled", "distribution": "desktop-app"}), encoding="utf-8",
    )
    hermes_home = tmp_path / "hermes_home"
    hermes_home.mkdir()

    monkeypatch.setattr(doctor_mod, "PROJECT_ROOT", project)
    monkeypatch.setattr("hermes_cli._startup_fast.project_root_str", lambda: str(project))
    monkeypatch.setattr("hermes_constants.get_hermes_home", lambda: hermes_home)
    monkeypatch.setattr(doctor_tools, "_pm_tool_path", lambda name: None)

    touches: list[Path] = []
    real_touch = Path.touch

    def _track_touch(self, *a, **kw):
        if project in self.parents or self == project:
            touches.append(self)
        return real_touch(self, *a, **kw)

    monkeypatch.setattr(Path, "touch", _track_touch)

    doctor_tools._check_npm_audit(False)

    assert touches == []
    assert not (hermes_home / "scripts" / "whatsapp-bridge").exists()


def test_doctor_npm_audit_audits_existing_hermes_home_mirror_on_sealed_bundle(monkeypatch, tmp_path, capsys):
    """When WhatsApp deps are already installed in the HERMES_HOME mirror, doctor audits that mirror
    without touching the sealed bundle."""
    from pathlib import Path
    import hermes_cli.doctor as doctor_mod

    project = tmp_path / "Hermes.app" / "Contents" / "Resources" / "agent-payload" / "hermes-agent"
    install_bridge = project / "scripts" / "whatsapp-bridge"
    install_bridge.mkdir(parents=True)
    (install_bridge / "bridge.js").write_text("// bridge\n", encoding="utf-8")
    (project / "install-stamp.json").write_text(
        json.dumps({"payload": "bundled", "distribution": "desktop-app"}), encoding="utf-8",
    )
    hermes_home = tmp_path / "hermes_home"
    mirror = hermes_home / "scripts" / "whatsapp-bridge"
    (mirror / "node_modules").mkdir(parents=True)

    monkeypatch.setattr(doctor_mod, "PROJECT_ROOT", project)
    monkeypatch.setattr("hermes_cli._startup_fast.project_root_str", lambda: str(project))
    monkeypatch.setattr("hermes_constants.get_hermes_home", lambda: hermes_home)
    monkeypatch.setattr(doctor_tools, "_pm_tool_path", lambda name: "/usr/bin/npm" if name == "npm" else None)

    touches: list[Path] = []
    real_touch = Path.touch

    def _track_touch(self, *a, **kw):
        if project in self.parents or self == project:
            touches.append(self)
        return real_touch(self, *a, **kw)

    monkeypatch.setattr(Path, "touch", _track_touch)

    audited_cwds: list[str] = []
    completed = subprocess.CompletedProcess([], 0, stdout=_audit_json(), stderr="")

    def _fake_run(*args, **kwargs):
        audited_cwds.append(str(kwargs.get("cwd", "")))
        return completed

    monkeypatch.setattr(doctor_tools.subprocess, "run", _fake_run)

    doctor_tools._check_npm_audit(False)

    assert touches == []
    assert audited_cwds == [str(mirror)]
    assert "WhatsApp bridge deps" in capsys.readouterr().out


def test_doctor_npm_audit_audits_the_checkout_bridge_over_a_leftover_mirror(monkeypatch, tmp_path):
    """A source checkout runs WhatsApp from its own writable bridge dir, so a mirror an earlier desktop install
    left in the same HERMES_HOME is not the tree doctor audits."""
    import hermes_cli.doctor as doctor_mod

    project = tmp_path / "checkout"
    install_bridge = project / "scripts" / "whatsapp-bridge"
    (install_bridge / "node_modules").mkdir(parents=True)
    hermes_home = tmp_path / "hermes_home"
    (hermes_home / "scripts" / "whatsapp-bridge" / "node_modules").mkdir(parents=True)

    monkeypatch.setattr(doctor_mod, "PROJECT_ROOT", project)
    monkeypatch.setattr("hermes_constants.get_hermes_home", lambda: hermes_home)
    monkeypatch.setattr(doctor_tools, "_pm_tool_path", lambda name: "/usr/bin/npm" if name == "npm" else None)

    audited_cwds: list[str] = []
    completed = subprocess.CompletedProcess([], 0, stdout=_audit_json(), stderr="")

    def _fake_run(*args, **kwargs):
        audited_cwds.append(str(kwargs.get("cwd", "")))
        return completed

    monkeypatch.setattr(doctor_tools.subprocess, "run", _fake_run)

    doctor_tools._check_npm_audit(False)

    assert audited_cwds == [str(install_bridge)]


@pytest.mark.platforms("posix")
@pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0, reason="root writes through mode 0o555")
def test_doctor_npm_audit_audits_the_mirror_of_a_read_only_install(monkeypatch, tmp_path):
    """A read-only install tree (Docker /opt/hermes) runs the bridge from its HERMES_HOME mirror (#49561)."""
    import hermes_cli.doctor as doctor_mod

    project = tmp_path / "opt-hermes"
    install_bridge = project / "scripts" / "whatsapp-bridge"
    (install_bridge / "node_modules").mkdir(parents=True)
    hermes_home = tmp_path / "hermes_home"
    mirror = hermes_home / "scripts" / "whatsapp-bridge"
    (mirror / "node_modules").mkdir(parents=True)
    install_bridge.chmod(0o555)

    monkeypatch.setattr(doctor_mod, "PROJECT_ROOT", project)
    monkeypatch.setattr("hermes_constants.get_hermes_home", lambda: hermes_home)
    monkeypatch.setattr(doctor_tools, "_pm_tool_path", lambda name: "/usr/bin/npm" if name == "npm" else None)

    audited_cwds: list[str] = []
    completed = subprocess.CompletedProcess([], 0, stdout=_audit_json(), stderr="")

    def _fake_run(*args, **kwargs):
        audited_cwds.append(str(kwargs.get("cwd", "")))
        return completed

    monkeypatch.setattr(doctor_tools.subprocess, "run", _fake_run)

    try:
        doctor_tools._check_npm_audit(False)
    finally:
        install_bridge.chmod(0o755)

    assert audited_cwds == [str(mirror)]

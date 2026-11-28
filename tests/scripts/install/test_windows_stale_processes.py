"""Tests for tests/install/e2e-assets/windows-stale-processes.ps1.

Runs the real PowerShell script on Windows PowerShell 5.1 with a shadowed
Get-CimInstance so post-swap settle, identity logging, proof artifacts and
prefix-boundary checks are proven against the actual Windows script parser.
"""

from __future__ import annotations

import base64
import json
import shutil
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.platforms("windows")

CHECKER = Path(__file__).resolve().parents[3] / "tests" / "install" / "e2e-assets" / "windows-stale-processes.ps1"
OLD_LOC = r"C:\Program Files\WindowsApps\NousResearch.HermesBundled_2026.6864.2132.0_x64__e60prshbsznhj"
NEW_LOC = r"C:\Program Files\WindowsApps\NousResearch.HermesBundled_2026.7952.1914.0_x64__e60prshbsznhj"


def _run_checker(tmp_path: Path, fake_cim: str, *, settle_seconds: int = 2, poll_ms: int = 25):
    powershell = shutil.which("powershell")
    assert powershell, "Windows PowerShell is required on Windows hosts"
    proof = tmp_path / "proof"
    proof.mkdir(parents=True, exist_ok=True)
    script = (
        "$ErrorActionPreference = 'Stop'\nSet-StrictMode -Version Latest\n"
        "$at = [datetime]::new(2026, 11, 28, 9, 38, 0, [System.DateTimeKind]::Utc)\n"
        + fake_cim
        + f"\n& '{CHECKER}' -OldInstallLocation '{OLD_LOC}' -ProofDir '{proof}' "
        + f"-SettleSeconds {settle_seconds} -PollMilliseconds {poll_ms}\n"
    )
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    result = subprocess.run(
        [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120, check=False,
    )
    return result, proof


def test_no_stale_processes_exits_cleanly_without_writing_artifact(tmp_path):
    fake_cim = rf"""
function Get-CimInstance {{ [CmdletBinding()] param([string]$ClassName)
    @(
        [pscustomobject]@{{ ProcessId = 200; ParentProcessId = 1; Name = 'Hermes Agent.exe'; CreationDate = $at; ExecutablePath = '{NEW_LOC}\app\Hermes Agent.exe'; CommandLine = '"Hermes Agent.exe"' }}
        [pscustomobject]@{{ ProcessId = 201; ParentProcessId = 1; Name = 'other.exe'; CreationDate = $at; ExecutablePath = '{OLD_LOC}_sibling\other.exe'; CommandLine = 'other.exe' }}
    )
}}
"""
    result, proof = _run_checker(tmp_path, fake_cim, settle_seconds=1, poll_ms=25)

    assert result.returncode == 0, result.stdout + result.stderr
    assert not (proof / "stale-processes.json").exists()


def test_transient_stale_process_settles_and_records_initial_sighting(tmp_path):
    fake_cim = rf"""
$global:stale_calls = 0
function Get-CimInstance {{ [CmdletBinding()] param([string]$ClassName)
    $global:stale_calls++
    if ($global:stale_calls -eq 1) {{
        @([pscustomobject]@{{ ProcessId = 4112; ParentProcessId = 1044; Name = 'Hermes Agent.exe'; CreationDate = $at; ExecutablePath = '{OLD_LOC}\app\Hermes Agent.exe'; CommandLine = '"Hermes Agent.exe" --type=utility' }})
    }} else {{
        @()
    }}
}}
"""
    result, proof = _run_checker(tmp_path, fake_cim, settle_seconds=3, poll_ms=25)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "pid=4112 ppid=1044 name=Hermes Agent.exe" in result.stdout
    assert "old payload processes exited within" in result.stdout
    report = json.loads((proof / "stale-processes.json").read_text(encoding="utf-8-sig"))
    assert report["settled"] is True
    assert report["oldInstallLocation"] == OLD_LOC
    assert [p["ProcessId"] for p in report["initial"]] == [4112]
    assert report["initial"][0]["ParentProcessId"] == 1044
    assert report["initial"][0]["CommandLine"] == '"Hermes Agent.exe" --type=utility'
    assert report["remaining"] == []


def test_persistent_stale_process_throws_with_identity_and_writes_proof(tmp_path):
    fake_cim = rf"""
function Get-CimInstance {{ [CmdletBinding()] param([string]$ClassName)
    @(
        [pscustomobject]@{{ ProcessId = 9001; ParentProcessId = 1; Name = 'python.exe'; CreationDate = $at; ExecutablePath = '{OLD_LOC}\app\resources\agent-payload\tools\python\python.exe'; CommandLine = 'python.exe -m hermes_cli.main gateway run' }}
    )
}}
"""
    result, proof = _run_checker(tmp_path, fake_cim, settle_seconds=0, poll_ms=0)

    assert result.returncode != 0
    combined = result.stdout + result.stderr
    assert "Old payload processes remain alive after 0s:" in combined
    assert "pid=9001 ppid=1 name=python.exe" in combined
    assert "gateway run" in combined
    report = json.loads((proof / "stale-processes.json").read_text(encoding="utf-8-sig"))
    assert report["settled"] is False
    assert [p["ProcessId"] for p in report["initial"]] == [9001]
    assert [p["ProcessId"] for p in report["remaining"]] == [9001]
    assert report["remaining"][0]["ExecutablePath"].endswith(r"\python.exe")


def test_query_error_while_settling_still_saves_the_sighting_and_fails(tmp_path):
    fake_cim = rf"""
$global:stale_calls = 0
function Get-CimInstance {{ [CmdletBinding()] param([string]$ClassName)
    $global:stale_calls++
    if ($global:stale_calls -gt 1) {{ throw 'WMI query failed' }}
    @([pscustomobject]@{{ ProcessId = 5150; ParentProcessId = 1044; Name = 'python.exe'; CreationDate = $at; ExecutablePath = '{OLD_LOC}\app\resources\agent-payload\tools\python\python.exe'; CommandLine = 'python.exe -m hermes_cli.main gateway run' }})
}}
"""
    result, proof = _run_checker(tmp_path, fake_cim, settle_seconds=3, poll_ms=25)

    combined = result.stdout + result.stderr
    assert result.returncode != 0
    assert "WMI query failed" in combined
    assert (proof / "stale-processes.json").exists(), combined
    report = json.loads((proof / "stale-processes.json").read_text(encoding="utf-8-sig"))
    assert report["settled"] is False
    assert report["queryError"] == "WMI query failed"
    assert [p["ProcessId"] for p in report["initial"]] == [5150]
    assert report["initial"][0]["CommandLine"] == "python.exe -m hermes_cli.main gateway run"
    assert [p["ProcessId"] for p in report["remaining"]] == [5150]

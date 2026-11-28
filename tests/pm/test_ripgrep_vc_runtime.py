"""ARM64 Windows ripgrep carries the VC++ runtime it links against.

The aarch64-pc-windows-msvc rg.exe imports VCRUNTIME140.dll (the x64 build
embeds the CRT). A fresh Windows has no copy, so staging failed with
``rg.exe --version exited 3221225781`` (0xC0000135, STATUS_DLL_NOT_FOUND).
"""

from __future__ import annotations

import subprocess

import pm.install
import pm.packages
from pm.registry import get_package, walk
from pm.store import Store


def test_arm64_windows_ripgrep_stages_pythons_vc_runtime_beside_rg(tmp_path, monkeypatch):
    store = Store(tmp_path / "store")
    runtime = store.entry("python-1") / "vcruntime140.dll"
    runtime.parent.mkdir(parents=True)
    runtime.write_bytes(b"arm64 vc runtime")
    monkeypatch.setattr(pm.install, "_lockfile", lambda: None)
    monkeypatch.setattr(pm.install, "_installed_location",
                        lambda package, lockfile, target, **kw: ({"python": {"entry": "python-1"}}, store))

    staged = tmp_path / "scratch" / "tree"
    wrapped = staged / "ripgrep-15.2.0-aarch64-pc-windows-msvc"
    wrapped.mkdir(parents=True)
    (wrapped / "rg.exe").write_bytes(b"rg")

    get_package("ripgrep").stage(store, staged, "15.2.0", "win32-arm64")

    assert (staged / "rg.exe").is_file()
    assert (staged / "vcruntime140.dll").read_bytes() == runtime.read_bytes()


def test_python_installs_before_ripgrep_so_staging_can_read_it():
    order = [package.name for package in walk(["ripgrep"])]
    assert order.index("python") < order.index("ripgrep")


def _arm64_rg_entry(tmp_path, monkeypatch, outcome):
    """An ARM64 rg.exe entry on its own host, so verify() smoke-probes it; returns the probe launches."""
    entry = tmp_path / "rg-entry"
    entry.mkdir()
    (entry / "rg.exe").write_bytes(b"MZ" + bytes(58) + (64).to_bytes(4, "little") + b"PE\0\0" + (0xAA64).to_bytes(2, "little"))
    launched = []

    def run(argv, **kwargs):
        launched.append(argv)
        return outcome(argv)

    monkeypatch.setattr(pm.packages, "current_target", lambda: "win32-arm64")
    monkeypatch.setattr(subprocess, "run", run)
    return entry, launched


def _missing_dll_dialog(argv):
    raise subprocess.TimeoutExpired(argv, 60)


def test_arm64_windows_ripgrep_verify_rejects_entry_missing_vcruntime_without_launching_it(tmp_path, monkeypatch):
    entry, launched = _arm64_rg_entry(tmp_path, monkeypatch, _missing_dll_dialog)

    assert "vcruntime140.dll" in get_package("ripgrep").verify(entry, "win32-arm64")
    assert launched == []


def test_arm64_windows_ripgrep_verify_still_probes_an_entry_with_vcruntime(tmp_path, monkeypatch):
    entry, launched = _arm64_rg_entry(tmp_path, monkeypatch, lambda argv: subprocess.CompletedProcess(argv, 0, b"", b""))
    (entry / "vcruntime140.dll").write_bytes(b"arm64 vc runtime")

    assert get_package("ripgrep").verify(entry, "win32-arm64") == ""
    assert [argv[1:] for argv in launched] == [["--version"]]

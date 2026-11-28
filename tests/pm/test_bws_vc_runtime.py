"""Windows bws carries the VC++ runtime it links against.

Both x86_64-pc-windows-msvc and aarch64-pc-windows-msvc bws.exe dynamically
import VCRUNTIME140.dll and ship no DLL beside the binary. On a fresh Windows
install without a VC++ Redistributable in System32, launching bws.exe blocks on
a missing-DLL modal or exits with STATUS_DLL_NOT_FOUND.
"""

from __future__ import annotations

import subprocess

import pytest

import pm.install
import pm.packages
from pm import paths
from pm.lock import Facts, Lockfile
from pm.registry import get_package, walk
from pm.store import Store, tree_digest

_MACHINE = {"x64": 0x8664, "arm64": 0xAA64}


def _pe(arch: str) -> bytes:
    return b"MZ" + bytes(58) + (64).to_bytes(4, "little") + b"PE\0\0" + _MACHINE[arch].to_bytes(2, "little")


@pytest.mark.parametrize("target,arch", [("win32-x64", "x64"), ("win32-arm64", "arm64")])
def test_windows_bws_stages_pythons_vc_runtime_beside_bws(tmp_path, monkeypatch, target, arch):
    store = Store(tmp_path / "store")
    runtime = store.entry("python-1") / "vcruntime140.dll"
    runtime.parent.mkdir(parents=True)
    runtime.write_bytes(_pe(arch))
    monkeypatch.setattr(pm.install, "_lockfile", lambda: None)
    monkeypatch.setattr(
        pm.install,
        "_installed_location",
        lambda package, lockfile, t, **kw: ({"python": {"entry": "python-1"}}, store),
    )

    staged = tmp_path / "scratch" / "tree"
    staged.mkdir(parents=True)
    (staged / "bws.exe").write_bytes(_pe(arch))

    bws = get_package("bws")
    bws.stage(store, staged, "2.0.0", target)

    assert (staged / "bws.exe").is_file()
    assert (staged / "vcruntime140.dll").read_bytes() == runtime.read_bytes()
    # File evidence only: a header-only bws.exe can't run on the host whose own target this is.
    monkeypatch.setattr(bws, "probe_version", False)
    assert bws.verify(staged, target) == ""


def _pin_python(tmp_path, monkeypatch, target: str) -> None:
    lock_path = tmp_path / "lock.json"
    lock = Lockfile(lock_path)
    lock.set_pin("python", "3.14.9+20261021", {target: [{"url": "https://example.invalid/py.tgz", "sha256": "a" * 64}]})
    lock.save()
    monkeypatch.setattr(paths, "lockfile_path", lambda: lock_path)


def _record_python(store: Store, facts: Facts, target: str, arch: str, *, vc_runtime: bool) -> bytes | None:
    """A pinned python entry with matching facts; returns its vcruntime140.dll bytes, if it has one."""
    py_entry = store.entry("python-1")
    py_entry.mkdir(parents=True)
    (py_entry / "python.exe").write_bytes(_pe(arch))
    (py_entry / "python3.exe").write_bytes(_pe(arch))
    runtime = _pe(arch) + store.root.name.encode() if vc_runtime else None
    if runtime is not None:
        (py_entry / "vcruntime140.dll").write_bytes(runtime)
    facts.record(
        "python",
        "3.14.9+20261021",
        "python-1",
        {"PATH": [str(py_entry)]},
        store.root,
        target=target,
        artifacts=["a" * 64],
        digest=tree_digest(py_entry),
    )
    return runtime


@pytest.mark.parametrize("ambient_python", [False, True], ids=["empty-runtime", "runtime-python-without-dll"])
@pytest.mark.parametrize("target,arch", [("win32-x64", "x64"), ("win32-arm64", "arm64")])
def test_windows_bws_stages_vc_runtime_from_build_store_outside_runtime_dir(
    tmp_path, monkeypatch, target, arch, ambient_python
):
    ambient_runtime = tmp_path / "ambient-runtime"
    ambient_runtime.mkdir()
    monkeypatch.setenv("HERMES_RUNTIME_DIR", str(ambient_runtime))

    _pin_python(tmp_path, monkeypatch, target)

    if ambient_python:
        # Pinned and recorded in the runtime store, but missing the DLL there.
        _record_python(Store(paths.store_root()), Facts(paths.facts_path()), target, arch, vc_runtime=False)
    build_store = Store(tmp_path / "build-store")
    runtime = _record_python(build_store, Facts(build_store.root / "facts.json"), target, arch, vc_runtime=True)

    staged = tmp_path / "scratch" / "tree"
    staged.mkdir(parents=True)
    (staged / "bws.exe").write_bytes(_pe(arch))

    get_package("bws").stage(build_store, staged, "2.0.0", target)

    assert (staged / "vcruntime140.dll").read_bytes() == runtime


@pytest.mark.parametrize("target,arch", [("win32-x64", "x64"), ("win32-arm64", "arm64")])
def test_windows_bws_stages_vc_runtime_from_runtime_store_when_staging_store_has_no_python(
    tmp_path, monkeypatch, target, arch
):
    # A sealed bundle installs bws into its writable store; python lives in the runtime store.
    monkeypatch.setenv("HERMES_RUNTIME_DIR", str(tmp_path / "ambient-runtime"))
    _pin_python(tmp_path, monkeypatch, target)
    runtime = _record_python(Store(paths.store_root()), Facts(paths.facts_path()), target, arch, vc_runtime=True)

    staged = tmp_path / "scratch" / "tree"
    staged.mkdir(parents=True)
    (staged / "bws.exe").write_bytes(_pe(arch))

    get_package("bws").stage(Store(tmp_path / "writable-store"), staged, "2.0.0", target)

    assert (staged / "vcruntime140.dll").read_bytes() == runtime


def _probe_recorder(monkeypatch, target, outcome):
    """Make target the host's own, so verify() smoke-probes, and record each probe launch."""
    launched = []

    def run(argv, **kwargs):
        launched.append(argv)
        return outcome(argv)

    monkeypatch.setattr(pm.packages, "current_target", lambda: target)
    monkeypatch.setattr(subprocess, "run", run)
    return launched


def _missing_dll_dialog(argv):
    raise subprocess.TimeoutExpired(argv, 60)


@pytest.mark.parametrize("target,arch", [("win32-x64", "x64"), ("win32-arm64", "arm64")])
def test_windows_bws_verify_rejects_entry_missing_vcruntime_without_launching_it(tmp_path, monkeypatch, target, arch):
    entry = tmp_path / "bws-entry"
    entry.mkdir()
    (entry / "bws.exe").write_bytes(_pe(arch))
    launched = _probe_recorder(monkeypatch, target, _missing_dll_dialog)

    reason = get_package("bws").verify(entry, target)

    assert "vcruntime140.dll" in reason
    assert launched == []


@pytest.mark.parametrize("target,arch", [("win32-x64", "x64"), ("win32-arm64", "arm64")])
def test_windows_bws_verify_still_probes_an_entry_with_vcruntime(tmp_path, monkeypatch, target, arch):
    entry = tmp_path / "bws-entry"
    entry.mkdir()
    (entry / "bws.exe").write_bytes(_pe(arch))
    (entry / "vcruntime140.dll").write_bytes(_pe(arch))
    launched = _probe_recorder(monkeypatch, target, lambda argv: subprocess.CompletedProcess(argv, 0, b"bws 2.0.0", b""))

    assert get_package("bws").verify(entry, target) == ""
    assert [argv[1:] for argv in launched] == [["--version"]]


def test_posix_bws_staging_does_not_copy_vcruntime(tmp_path, monkeypatch):
    store = Store(tmp_path / "store")
    monkeypatch.setattr(
        pm.install,
        "_installed_location",
        lambda *a, **kw: pytest.fail("POSIX bws should not look up python for vcruntime140.dll"),
    )
    staged = tmp_path / "scratch" / "tree"
    staged.mkdir(parents=True)
    (staged / "bws").write_bytes(b"#!/bin/sh\n")

    get_package("bws").stage(store, staged, "2.0.0", "linux-x64")

    assert (staged / "bws").is_file()
    assert not (staged / "vcruntime140.dll").exists()


def test_python_installs_before_bws_so_staging_can_read_it():
    order = [package.name for package in walk(["bws"])]
    assert order.index("python") < order.index("bws")

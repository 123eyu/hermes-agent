"""Windows bws carries the VC++ runtime it links against.

Both x86_64-pc-windows-msvc and aarch64-pc-windows-msvc bws.exe dynamically
import VCRUNTIME140.dll and ship no DLL beside the binary. On a fresh Windows
install without a VC++ Redistributable in System32, launching bws.exe blocks on
a missing-DLL modal or exits with STATUS_DLL_NOT_FOUND.
"""

from __future__ import annotations

import pytest

import pm.install
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
        lambda package, lockfile, t: ({"python": {"entry": "python-1"}}, store),
    )

    staged = tmp_path / "scratch" / "tree"
    staged.mkdir(parents=True)
    (staged / "bws.exe").write_bytes(_pe(arch))

    bws = get_package("bws")
    bws.stage(store, staged, "2.0.0", target)

    assert (staged / "bws.exe").is_file()
    assert (staged / "vcruntime140.dll").read_bytes() == runtime.read_bytes()
    assert bws.verify(staged, target) == ""


@pytest.mark.parametrize("target,arch", [("win32-x64", "x64"), ("win32-arm64", "arm64")])
def test_windows_bws_stages_vc_runtime_from_build_store_outside_runtime_dir(tmp_path, monkeypatch, target, arch):
    empty_runtime = tmp_path / "ambient-runtime"
    empty_runtime.mkdir()
    monkeypatch.setenv("HERMES_RUNTIME_DIR", str(empty_runtime))

    build_store = Store(tmp_path / "build-store")
    py_entry = build_store.entry("python-1")
    py_entry.mkdir(parents=True)
    (py_entry / "python.exe").write_bytes(_pe(arch))
    (py_entry / "python3.exe").write_bytes(_pe(arch))
    runtime = py_entry / "vcruntime140.dll"
    runtime.write_bytes(_pe(arch))

    lock_path = tmp_path / "lock.json"
    lock = Lockfile(lock_path)
    lock.set_pin("python", "3.14.9+20261021", {target: [{"url": "https://example.invalid/py.tgz", "sha256": "a" * 64}]})
    lock.save()
    monkeypatch.setattr(paths, "lockfile_path", lambda: lock_path)

    facts = Facts(build_store.root / "facts.json")
    facts.record(
        "python",
        "3.14.9+20261021",
        "python-1",
        {"PATH": [str(py_entry)]},
        build_store.root,
        target=target,
        artifacts=["a" * 64],
        digest=tree_digest(py_entry),
    )

    staged = tmp_path / "scratch" / "tree"
    staged.mkdir(parents=True)
    (staged / "bws.exe").write_bytes(_pe(arch))

    get_package("bws").stage(build_store, staged, "2.0.0", target)

    assert (staged / "vcruntime140.dll").read_bytes() == runtime.read_bytes()


@pytest.mark.parametrize("target,arch", [("win32-x64", "x64"), ("win32-arm64", "arm64")])
def test_windows_bws_verify_rejects_entry_missing_vcruntime(tmp_path, target, arch):
    entry = tmp_path / "bws-entry"
    entry.mkdir()
    (entry / "bws.exe").write_bytes(_pe(arch))

    reason = get_package("bws").verify(entry, target)
    assert "vcruntime140.dll" in reason


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

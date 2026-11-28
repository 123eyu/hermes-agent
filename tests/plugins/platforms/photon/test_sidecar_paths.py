"""Tests for the Photon sidecar directory resolver (NS-606).

Hosted/managed images keep the plugin tree under an immutable
``/opt/hermes``; ``resolve_sidecar_dir`` must run in place when the deps are
baked and current, and mirror the sidecar to the writable ``HERMES_HOME``
volume when a runtime install is unavoidable.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from plugins.platforms.photon import sidecar_paths


def _seed_source(source: Path, *, with_node_modules: bool = False) -> None:
    source.mkdir(parents=True, exist_ok=True)
    for name in sidecar_paths._MIRROR_FILES:
        (source / name).write_text(f"// {name}\n", encoding="utf-8")
    if with_node_modules:
        (source / "node_modules").mkdir()
        (source / "node_modules" / ".package-lock.json").write_text(
            "{}", encoding="utf-8"
        )


def _freeze_writability(monkeypatch, *, writable: bool) -> None:
    monkeypatch.setattr(sidecar_paths, "_dir_writable", lambda _p: writable)


def test_env_override_wins(tmp_path, monkeypatch) -> None:
    override = tmp_path / "custom"
    monkeypatch.setenv("PHOTON_SIDECAR_DIR", str(override))
    assert sidecar_paths.resolve_sidecar_dir(tmp_path / "src") == override


def test_writable_source_runs_in_place(tmp_path, monkeypatch) -> None:
    """Dev installs: writable tree keeps today's behavior exactly."""
    monkeypatch.delenv("PHOTON_SIDECAR_DIR", raising=False)
    source = tmp_path / "src"
    _seed_source(source)
    _freeze_writability(monkeypatch, writable=True)
    assert sidecar_paths.resolve_sidecar_dir(source) == source


def test_readonly_source_with_baked_fresh_deps_runs_in_place(
    tmp_path, monkeypatch
) -> None:
    """Managed-image happy path: deps baked at build time, no mirror needed."""
    monkeypatch.delenv("PHOTON_SIDECAR_DIR", raising=False)
    source = tmp_path / "src"
    _seed_source(source, with_node_modules=True)
    # Marker newer than lockfile == fresh install.
    lock = source / "package-lock.json"
    marker = source / "node_modules" / ".package-lock.json"
    os.utime(lock, (1000.0, 1000.0))
    os.utime(marker, (2000.0, 2000.0))
    _freeze_writability(monkeypatch, writable=False)
    assert sidecar_paths.resolve_sidecar_dir(source) == source


def test_mirror_refresh_updates_changed_files_and_keeps_node_modules(
    tmp_path, monkeypatch
) -> None:
    """Image update changes index.mjs → re-copied; installed deps survive."""
    monkeypatch.delenv("PHOTON_SIDECAR_DIR", raising=False)
    home = tmp_path / "home"
    monkeypatch.setenv("HERMES_HOME", str(home))
    source = tmp_path / "src"
    _seed_source(source)
    _freeze_writability(monkeypatch, writable=False)

    mirror = sidecar_paths.resolve_sidecar_dir(source)
    # Simulate a completed npm install in the mirror.
    (mirror / "node_modules").mkdir()
    (mirror / "node_modules" / "installed.txt").write_text("x", encoding="utf-8")

    # Image update rewrites a source file.
    (source / "index.mjs").write_text("// index.mjs v2\n", encoding="utf-8")

    resolved = sidecar_paths.resolve_sidecar_dir(source)

    assert resolved == mirror
    assert (mirror / "index.mjs").read_text(encoding="utf-8") == "// index.mjs v2\n"
    assert (mirror / "node_modules" / "installed.txt").exists()


@pytest.mark.platforms("linux")
def test_dir_writable_probe(tmp_path) -> None:
    assert sidecar_paths.dir_writable(tmp_path) is True
    ro = tmp_path / "ro"
    ro.mkdir()
    ro.chmod(0o555)
    try:
        if os.geteuid() == 0:  # pragma: no cover - root ignores perms
            pytest.skip("root bypasses directory permissions")
        assert sidecar_paths.dir_writable(ro) is False
    finally:
        ro.chmod(0o755)


def test_adapter_import_does_not_resolve_sidecar_dir(monkeypatch) -> None:
    """Importing the adapter must not probe the filesystem or mirror files.

    resolve_sidecar_dir() touch/unlink-probes the source tree and may copy
    files to HERMES_HOME; the adapter and CLI resolve lazily on first use so
    a bare import (plugin discovery, `hermes --help`, test collection) has
    no filesystem side effects.
    """
    import importlib

    from plugins.platforms.photon import adapter as photon_adapter
    from plugins.platforms.photon import cli as photon_cli

    def _boom(*args, **kwargs):  # pragma: no cover - failure path
        raise AssertionError("resolve_sidecar_dir called at import time")

    monkeypatch.setattr(sidecar_paths, "_SIDECAR_DIR", None)
    monkeypatch.setattr(sidecar_paths, "resolve_sidecar_dir", _boom)
    try:
        importlib.reload(photon_adapter)
        importlib.reload(photon_cli)
        # Nothing resolved yet.
        assert sidecar_paths._SIDECAR_DIR is None
        # First real use resolves (and would call resolve_sidecar_dir).
        with pytest.raises(AssertionError, match="import time"):
            photon_adapter._sidecar_dir()
        # A monkeypatched _SIDECAR_DIR (the pattern existing tests use) is
        # honored without touching the resolver.
        monkeypatch.setattr(sidecar_paths, "_SIDECAR_DIR", Path("/tmp/x"))
        assert photon_adapter._sidecar_dir() == Path("/tmp/x")
        assert photon_cli._sidecar_dir() == Path("/tmp/x")
        assert photon_adapter._npm_error_log() == Path("/tmp/x/.photon-npm-error.log")
    finally:
        # Restore real bindings for any later test importing these modules.
        monkeypatch.undo()
        importlib.reload(photon_adapter)
        importlib.reload(photon_cli)


def test_mirror_carries_npmrc_release_age_gate(tmp_path, monkeypatch) -> None:
    """The read-only-tree mirror is where `npm ci`/`npm install` actually runs, so the
    sidecar's .npmrc (min-release-age, #134019) must be mirrored next to the lockfile."""
    monkeypatch.delenv("PHOTON_SIDECAR_DIR", raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    source = tmp_path / "src"
    _seed_source(source)
    (source / ".npmrc").write_text("min-release-age=14\n", encoding="utf-8")
    _freeze_writability(monkeypatch, writable=False)

    mirror = sidecar_paths.resolve_sidecar_dir(source)

    assert mirror != source
    assert (mirror / ".npmrc").read_text(encoding="utf-8") == "min-release-age=14\n"


@pytest.mark.parametrize("move", ("delete", "rename"))
def test_mirror_falls_back_to_the_source_for_a_deleted_or_renamed_profile_home(tmp_path, monkeypatch, move):
    """The sidecar mirror is refused like any unwritable mirror: run from the source (#155595 U3)."""
    import hermes_constants
    from tests.fixtures.dead_profile_home import dead_named_home

    home = dead_named_home(tmp_path, move)
    source = tmp_path / "src"
    _seed_source(source)
    _freeze_writability(monkeypatch, writable=False)
    monkeypatch.delenv("PHOTON_SIDECAR_DIR", raising=False)
    monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: home)
    assert sidecar_paths.resolve_sidecar_dir(source) == source
    assert not home.exists()


def test_sealed_bundle_sidecar_mirrors_without_probing_source(tmp_path, monkeypatch) -> None:
    """A user-writable sealed desktop bundle (macOS .app) must mirror to HERMES_HOME
    without touching .hermes-write-probe inside the bundle."""
    import json

    monkeypatch.delenv("PHOTON_SIDECAR_DIR", raising=False)
    bundle = tmp_path / "Hermes.app" / "Contents" / "Resources" / "agent-payload" / "hermes-agent"
    source = bundle / "plugins" / "platforms" / "photon" / "sidecar"
    _seed_source(source)
    (bundle / "install-stamp.json").write_text(
        json.dumps({"payload": "bundled", "distribution": "desktop-app"}), encoding="utf-8",
    )
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))

    touches: list[Path] = []
    real_touch = Path.touch

    def _track_touch(self, *a, **kw):
        if bundle in self.parents or self == bundle:
            touches.append(self)
        return real_touch(self, *a, **kw)

    monkeypatch.setattr(Path, "touch", _track_touch)

    assert sidecar_paths.dir_writable(source) is False
    resolved = sidecar_paths.resolve_sidecar_dir(source)

    expected = home / "photon" / "sidecar"
    assert resolved == expected
    assert touches == []
    assert (expected / "index.mjs").exists()


def test_sealed_bundle_with_baked_deps_runs_in_place_without_creating_lock(tmp_path, monkeypatch) -> None:
    """When a sealed bundle carries fresh baked deps, Photon runs in place without
    writing .hermes-write-probe or .photon-install.lock into the bundle."""
    import json
    from plugins.platforms.photon import adapter as photon_adapter

    monkeypatch.delenv("PHOTON_SIDECAR_DIR", raising=False)
    bundle = tmp_path / "Hermes.app" / "Contents" / "Resources" / "agent-payload" / "hermes-agent"
    source = bundle / "plugins" / "platforms" / "photon" / "sidecar"
    _seed_source(source, with_node_modules=True)
    (source / "node_modules" / "spectrum-ts").mkdir()
    os.utime(source / "package-lock.json", (1000.0, 1000.0))
    os.utime(source / "node_modules" / ".package-lock.json", (2000.0, 2000.0))
    (bundle / "install-stamp.json").write_text(
        json.dumps({"payload": "bundled", "distribution": "desktop-app"}), encoding="utf-8",
    )

    resolved = sidecar_paths.resolve_sidecar_dir(source)
    assert resolved == source

    monkeypatch.setattr(sidecar_paths, "_SIDECAR_DIR", resolved)
    photon_adapter._ensure_sidecar_deps_blocking()

    assert not (source / ".photon-install.lock").exists()
    assert not (source / ".hermes-write-probe").exists()


def test_mirror_of_the_shipped_sidecar_carries_every_module(tmp_path, monkeypatch) -> None:
    """index.mjs imports its sibling modules at load, so a mirror missing one can't start the sidecar (#85046).
    Mirrors a copy of the real sidecar tree, not a fixture built from the mirror list."""
    import shutil

    monkeypatch.delenv("PHOTON_SIDECAR_DIR", raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    source = tmp_path / "src"
    shutil.copytree(sidecar_paths.SOURCE_SIDECAR_DIR, source, ignore=shutil.ignore_patterns("node_modules"))
    _freeze_writability(monkeypatch, writable=False)

    mirror = sidecar_paths.resolve_sidecar_dir(source)

    shipped = {p.name for p in source.glob("*.mjs")}
    assert "index.mjs" in shipped
    assert mirror != source
    assert shipped <= {p.name for p in mirror.glob("*.mjs")}


def _sealed_bundle_sidecar(tmp_path, *, baked: bool) -> tuple[Path, Path]:
    import json

    bundle = tmp_path / "Hermes.app" / "Contents" / "Resources" / "agent-payload" / "hermes-agent"
    source = bundle / "plugins" / "platforms" / "photon" / "sidecar"
    _seed_source(source, with_node_modules=baked)
    if baked:
        (source / "node_modules" / "spectrum-ts").mkdir()
    (bundle / "install-stamp.json").write_text(
        json.dumps({"payload": "bundled", "distribution": "desktop-app"}), encoding="utf-8",
    )
    return bundle, source


@pytest.mark.parametrize("baked", [True, False], ids=["baked-deps", "mirror-failed"])
def test_install_sidecar_never_runs_npm_inside_a_sealed_bundle(tmp_path, monkeypatch, capsys, baked) -> None:
    """`hermes photon setup` / `install-sidecar` install into the dir the resolver left. Inside a bundle that is
    baked deps (nothing to do) or a failed mirror (say so): never npm or its error log inside the .app."""
    import types
    from plugins.platforms.photon import cli as photon_cli

    bundle, source = _sealed_bundle_sidecar(tmp_path, baked=baked)
    monkeypatch.setattr(sidecar_paths, "_SIDECAR_DIR", source)
    monkeypatch.setattr(sidecar_paths, "_NPM_ERROR_LOG", None)
    monkeypatch.setattr(photon_cli, "find_node_executable", lambda _name: "/usr/bin/npm")
    runs: list[tuple] = []

    def _fake_run(cmd, **kw):
        runs.append((cmd, kw.get("cwd")))
        return types.SimpleNamespace(returncode=1, stderr="npm ERR! EPERM")

    monkeypatch.setattr(photon_cli.subprocess, "run", _fake_run)
    before = sorted(p.relative_to(bundle) for p in bundle.rglob("*"))

    rc = photon_cli._install_sidecar()

    assert runs == []
    assert sorted(p.relative_to(bundle) for p in bundle.rglob("*")) == before
    assert rc == (0 if baked else 1)
    if not baked:
        assert "HERMES_HOME" in capsys.readouterr().err


def test_sealed_bundle_without_deps_reports_the_failed_mirror_not_an_in_bundle_install(tmp_path, monkeypatch) -> None:
    """The gateway's refusal must not tell the user to run npm inside the desktop app."""
    from plugins.platforms.photon import adapter as photon_adapter

    _bundle, source = _sealed_bundle_sidecar(tmp_path, baked=False)
    monkeypatch.setattr(sidecar_paths, "_SIDECAR_DIR", source)

    with pytest.raises(photon_adapter.PhotonSidecarStartupError) as excinfo:
        photon_adapter._ensure_sidecar_deps_blocking()

    assert "npm ci" not in str(excinfo.value)
    assert "HERMES_HOME" in str(excinfo.value)

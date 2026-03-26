# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Web-based one-click installer for Odoo 17 development environments on Windows. Single-file Python application (`setup.py`, ~1300 lines) with zero external dependencies (Python stdlib only), serving a web UI on `http://localhost:9017`.

## Running the Application

```cmd
# Via batch launcher (recommended - auto-finds Python, creates .venv, elevates to Admin)
start.bat

# Direct Python execution
python setup.py
```

## Architecture

**Single-file monolith** (`setup.py`) with six sections:

1. **Config constants** (lines 23-54): URLs, default paths, `PROJECT_DEFAULTS` dict
2. **Detection functions** (lines 93-280): `find_python311()`, `find_postgres_bin()`, `find_docker_postgres()`, `detect_native_postgres_details()`, `parse_project_config()`, `detect_status()`
3. **Installation steps** (lines 324-550): `step_install_python`, `step_install_postgres`, `step_create_pg_user`, `step_clone_odoo`, `step_create_venv`, `step_install_requirements`, `step_create_project`, `step_full_install`
4. **Project management** (lines 554-627): `read_project_config`, `save_project_config`, `delete_project`, `duplicate_project`
5. **Inline HTML** (line 630-1147): Complete SPA as `HTML_PAGE` raw string — SoundCloud-inspired dark UI with embedded JS
6. **HTTP server** (lines 1153-1293): `InstallerHandler` with JSON API endpoints on `ThreadingHTTPServer`

**Templates** (`templates/`): `odoo.conf` (Python `.format()`) and `launch.json` (uses `.replace()` to avoid JSON brace conflicts).

**Data flow**: `start.bat` -> finds/downloads Python -> creates `.venv` -> runs `setup.py` -> serves UI -> `/api/full_install` runs in background thread -> poll `/api/log` for progress.

## API Endpoints (all POST, JSON body)

| Endpoint | Purpose |
|----------|---------|
| `/api/status` | Detect installed components and list projects |
| `/api/full_install` | Run all installation steps in background thread |
| `/api/run_step` | Run single step: `install_python`, `install_postgres`, `clone_odoo`, `create_venv`, `install_requirements` |
| `/api/create_project` | Create new Odoo project with config + junction symlink |
| `/api/read_config` / `/api/save_config` | Read/write project's `odoo.conf` |
| `/api/delete_project` / `/api/duplicate_project` | Project management |
| `/api/start_odoo` / `/api/open_vscode` / `/api/open_explorer` | Launch external processes |
| `/api/log` | Get last 200 log lines and `current_task` progress |

## Testing

```cmd
# Unit tests (61 tests, ~2s)
python -m unittest test_setup -v

# Run a single test class
python -m unittest test_setup.TestDetectStatus -v

# Run a single test method
python -m unittest test_setup.TestDetectStatus.test_detect_status_nothing_installed -v

# E2E test (requires components installed, ~5 min first run)
powershell -ExecutionPolicy Bypass -File e2e_test.ps1

# Windows Sandbox E2E (isolated, uses sandbox_test.wsb + sandbox_test.ps1)
# Double-click sandbox_test.wsb — runs full install + Odoo start + DB create + login in sandbox

# Cleanup installed components for fresh test
cleanup_test.bat
```

Tests use `unittest` (not pytest) with `TempDirMixin` for temp directory setup/teardown. Test file imports `setup` module directly.

## Key Design Decisions

- **Zero dependencies**: Only Python stdlib. No Flask, no npm. The installer's `.venv` is separate from the Odoo venv it creates.
- **Windows-only**: `cmd /c mklink /J` for junctions, `subprocess.CREATE_NEW_CONSOLE` for Odoo process, `.bat` launcher with admin elevation.
- **Shared base, multiple projects**: One Odoo source + venv in `odoo_17_base/`, multiple project folders each with `odoo.conf`, `addons/`, and junction link to shared source.
- **Docker PostgreSQL support**: Auto-detects running Docker PostgreSQL containers via `docker ps`; can create new ones.
- **Global mutable state**: `log_lines` list and `current_task` dict are module-level globals shared across threads.
- **Relative addons_path**: `odoo.conf` uses `./addons,./odoo/addons`. `start_odoo` sets `cwd=project_dir` so paths resolve correctly, matching VS Code F5 behavior.
- **PostgreSQL auth**: `PGPASSWORD` env var passed to `psql` to prevent password prompt hangs.

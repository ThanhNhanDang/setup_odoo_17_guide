# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Web-based one-click installer for Odoo 17 development environments on Windows. It's a single-file Python application (`setup.py`) with zero external dependencies (Python stdlib only) that serves a web UI on `http://localhost:9017`.

## Running the Application

```cmd
# Via batch launcher (recommended - auto-finds Python, creates .venv)
start.bat

# Direct Python execution
python setup.py
```

The web UI opens automatically at `http://127.0.0.1:9017`.

## Architecture

**Single-file monolith**: `setup.py` (~1250 lines) contains everything:

1. **Config constants** (lines 23-54): URLs, default paths (`D:\workspaces\odoo_17_base`, `D:\workspaces\projects\odoo17`), project defaults
2. **Detection functions** (lines 93-201): Find Python 3.11, PostgreSQL (native + Docker containers), parse project configs
3. **Installation steps** (lines 322-529): Each `step_*` function handles one installation phase (Python, PostgreSQL, Odoo clone, venv, pip requirements, project creation)
4. **Project management** (lines 535-609): CRUD operations on projects (read/save config, delete, duplicate)
5. **Inline HTML** (line 611-1132): Complete SPA with SoundCloud-inspired dark UI, embedded as a raw string `HTML_PAGE`
6. **HTTP server** (lines 1134-1253): `InstallerHandler` with JSON API endpoints, runs on `ThreadingHTTPServer`

**Templates** (`templates/`):
- `odoo.conf` - Python `.format()` template for Odoo configuration
- `launch.json` - VS Code debug configuration template

**Entry point**: `start.bat` -> finds/downloads Python -> creates `.venv` -> runs `setup.py`

## API Endpoints (all POST, JSON body)

| Endpoint | Purpose |
|----------|---------|
| `/api/status` | Detect installed components and list projects |
| `/api/full_install` | Run all installation steps sequentially |
| `/api/run_step` | Run a single step: `install_python`, `install_postgres`, `clone_odoo`, `create_venv`, `install_requirements` |
| `/api/create_project` | Create new Odoo project with config + symlink |
| `/api/read_config` / `/api/save_config` | Read/write project's `odoo.conf` |
| `/api/delete_project` / `/api/duplicate_project` | Project management |
| `/api/start_odoo` / `/api/open_vscode` / `/api/open_explorer` | Launch external processes |
| `/api/log` | Get installation log lines and task progress |

## Testing

```cmd
# Unit tests (61 tests, ~2s)
python -m unittest test_setup -v

# E2E test (requires components installed, ~5 min first run)
powershell -ExecutionPolicy Bypass -File e2e_test.ps1

# Cleanup installed components for fresh test
cleanup_test.bat
```

## Key Design Decisions

- **Zero dependencies**: Only Python stdlib. No Flask, no npm, no build tools. The installer's own `.venv` is separate from the Odoo venv it creates.
- **Windows-only**: Uses `cmd /c mklink /J` for junctions, Windows paths, `.bat` launcher, `subprocess.CREATE_NEW_CONSOLE`.
- **Shared base, multiple projects**: One Odoo source + venv in `odoo_17_base/`, multiple project folders each with their own `odoo.conf`, `addons/`, and junction link to the shared Odoo source.
- **Docker PostgreSQL support**: Auto-detects running Docker PostgreSQL containers; can create new ones as alternative to native install.
- **Global mutable state**: `log_lines` list and `current_task` dict are module-level globals used across threads.
- **Admin required**: `start.bat` auto-elevates to Administrator for PostgreSQL install and junction symlinks.
- **Background install**: `/api/full_install` runs in a background thread; poll `/api/log` for progress.
- **Relative addons_path**: `odoo.conf` uses `./addons,./odoo/addons` (relative). `start_odoo` sets `cwd=project_dir` so paths resolve correctly. Same as VS Code F5 via `launch.json`.
- **launch.json template**: Uses `.replace()` instead of `.format()` to avoid conflicts with JSON braces.
- **PostgreSQL auth**: `PGPASSWORD` env var is passed to `psql` commands to prevent password prompt hangs.

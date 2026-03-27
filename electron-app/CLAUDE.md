# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Desktop Electron app for one-click Odoo (15/17/19) installation and project management on Windows. Supports multiple Odoo versions via a version registry pattern. Replaces the Python HTTP-based installer with a native desktop application using IPC communication.

**Version**: See `package.json` (currently 1.0.x)
**Platform**: Windows only
**Language**: TypeScript (main/preload) + Vanilla JS (renderer)

## Build & Dev Commands

```bash
npm run dev          # Clean + compile + launch with DevTools
npm start            # Compile + launch (no DevTools)
npm run build        # TypeScript compilation only (tsc)
npm run watch        # tsc in watch mode
npm run dist         # Full build + electron-builder (NSIS installer)
npm run publish      # Build + publish to GitHub Releases
npm run release:patch  # Version bump + publish (also :minor, :major)
```

**Publish to GitHub Releases** (from Windows cmd):
```cmd
publish.bat          # Default: patch bump (1.0.40 → 1.0.41)
publish.bat minor    # 1.0.40 → 1.1.0
publish.bat major    # 1.0.40 → 2.0.0 (breaking changes only)
```

## Architecture

Three-process Electron architecture with IPC communication (no HTTP server):

### Main Process (`src/main/`)

| File | Purpose |
|------|---------|
| `index.ts` | App entry, frameless BrowserWindow, admin elevation, auto-updater |
| `ipc-handlers.ts` | 30+ IPC handlers — the entire API surface |
| `services/config.ts` | Default paths, download URLs, project defaults |
| `services/odoo-versions.ts` | Version registry: Python/PG URLs, branches, paths per Odoo version |
| `services/installer.ts` | 8 install steps (Nginx, Git, VSCode, Python, PG, clone, venv, pip) + `stepCreateProject` |
| `services/projects.ts` | CRUD: `deleteProject`, `duplicateProject`, `readProjectConfig`, `saveProjectConfig` |
| `services/status.ts` | System detection (Python, PG, Git, Docker, Nginx) + project config parsing |
| `services/detection.ts` | Path finding, `.lnk` shortcut parsing, Docker container detection |
| `services/logger.ts` | In-memory log buffer (200 lines) + real-time streaming to renderer |
| `services/updater.ts` | electron-updater wrapper for GitHub Releases auto-update |
| `services/step-lock.ts` | Prevents concurrent installation step execution |
| `services/ini-parser.ts` | INI file read/write for `odoo.conf` (immutable pattern) |
| `utils/shell.ts` | `runCmd()` / `runCmdStreaming()` shell execution |
| `utils/download.ts` | File download with progress events |
| `utils/nginx.ts` | Nginx install/detection |
| `utils/hosts.ts` | Windows hosts file management + `projectToDomain()` |
| `utils/caddy.ts` | Caddy reverse proxy (alternative to Nginx) |

### Preload (`src/preload/index.ts`)
- Context bridge with channel whitelist
- `window.electronAPI.invoke(channel, data)` for request-response
- `window.electronAPI.onEvent(name, callback)` for push events
- Push channels: `log-message`, `task-progress`, `download-progress`, `update-status`, `project-log`, `duplicate-progress`

### Renderer (`src/renderer/`)

| File | Purpose |
|------|---------|
| `index.html` | Single-page app: panels (Dashboard, Install, Help) + modals |
| `scripts/app.js` | Main app logic (~1800 lines, vanilla JS, zero frameworks) |
| `scripts/i18n.js` | Zero-dependency i18n engine with `t()` function |
| `scripts/docs-data.js` | Help documentation, tour steps, troubleshooting data |
| `scripts/tour.js` | Guided tour overlay component |
| `styles/main.css` | CSS custom properties theme system with 4 presets |
| `locales/en.json` | English translations (150+ keys) |
| `locales/vi.json` | Vietnamese translations + docs/troubleshooting |
| `locales/ko.json` | Korean translations + docs/troubleshooting |

### Templates (`templates/`)
- `odoo.conf` — Odoo config template with `{key}` placeholders
- `launch.json` — VS Code debug config
- `settings.json` — VS Code workspace settings

## IPC Communication Pattern

```javascript
// Renderer → Main (request-response):
const result = await api('status', { base_dir, projects_dir });

// Main registers handler:
ipcMain.handle('status', async (_event, data) => detectStatus(...));

// Main → Renderer (push events):
mainWindow.webContents.send('duplicate-progress', { step, done });
// Renderer listens:
window.electronAPI.onEvent('duplicate-progress', (data) => { ... });
```

## i18n System

- Zero-dependency, 3 languages: EN, VI, KO
- `t('key.path')` with `{param}` interpolation
- HTML attributes: `data-i18n`, `data-i18n-html`, `data-i18n-placeholder`, `data-i18n-title`
- Backend error codes (e.g. `INVALID_NAME`, `PROJECT_EXISTS`) mapped to locale keys via `tMsg()`
- Locale files include docs + troubleshooting content in `td.*` namespace

## Theming System

Four presets (`default`, `autonsi`, `cyberpunk`, `luxury`) with dark/light modes via CSS custom properties and `data-preset`/`data-mode` attributes on `<html>`.

## Key Design Decisions

- **No UI frameworks** — Renderer is pure vanilla HTML/CSS/JS, no build step for frontend
- **IPC replaces HTTP** — All communication through Electron IPC, not fetch/REST
- **Frameless window** — Custom title bar with window control IPC handlers
- **Admin elevation** — Re-launches with PowerShell `RunAs` if not admin
- **Shared base, multiple projects** — One Odoo source + venv per version in `odoo_XX_base/`, multiple project folders with junction links
- **Step locking** — `StepLockManager` prevents parallel installation step execution
- **Auto-update** — GitHub Releases with NSIS installer
- **Version registry** — `odoo-versions.ts` is single source of truth for all version-specific config
- **Immutable INI** — `iniSet()` returns new object, never mutates
- **Project name rules** — `^[a-z_][a-z0-9_\-]*$` (lowercase, no leading digit)
- **Backend error codes** — Backend returns codes like `INVALID_NAME`, frontend translates via `tMsg()`

## Features

### Dashboard
- Project kanban cards with status (running/stopped), version badge, port, domain
- Stats row: Total Projects, Custom Modules, DB Connections, Python/PostgreSQL/VS Code status
- Search + filter (All / Running / Has Custom Modules)
- "New Project" and "Reset All Templates" buttons

### Project Management
- **Create**: name validation, auto-port, auto-domain, version select, DB config, advanced config
- **Start/Stop**: pending spinner, auto-start PostgreSQL, 30s polling, toast notifications
- **Edit Config**: full odoo.conf text editor modal
- **Duplicate**: progress popup (6 steps), skip DB, setup domain in hosts
- **Delete**: name confirmation, optional DB drop
- **VS Code**: opens project with pre-configured launch.json/settings.json
- **Explorer**: opens Windows File Explorer at project path
- **Open Browser**: http://localhost:{port} or https://{domain} (if Nginx)
- **Reset Templates**: regenerate launch.json + settings.json from templates

### Log Viewer (Separate Window)
- Independent BrowserWindow — stays open when main app minimized to tray
- Draggable, resizable, pin (always on top)
- Unique header color per window (10 colors rotate)
- Realtime streaming via IPC file watcher
- Log level coloring: ERROR (red), WARNING (yellow), INFO (blue)
- Controls: Clear, Auto-scroll, Word wrap, line count
- Max 5000 lines buffer

### Installation (8 Steps)
1. **Nginx** — HTTPS reverse proxy
2. **Git** — version control
3. **VS Code** — code editor
4. **Python** — runtime (3.10/3.11/3.12 per Odoo version)
5. **PostgreSQL** — database (14/16 per Odoo version, Docker support)
6. **Clone Odoo** — shallow clone from GitHub
7. **Virtual Env** — Python venv
8. **Pip Requirements** — Odoo dependencies

Each step: individual run, status indicator, progress bar, real-time log. "Install Everything" runs all 8 in parallel pipeline.

### Settings
- **Appearance**: 4 theme presets (Default/Amethyst/Cyberpunk/Pink Luxury), dark/light mode, custom colors (accent/bg/surface/text), custom app icon
- **Language**: EN/VI/KO with realtime switch
- **System Status**: Python, PostgreSQL, Git, VS Code, Nginx detection
- **Odoo Version**: 15/17/19 selector (auto-adjusts paths and download URLs)
- **Directories**: Base dir, Projects dir, Odoo Source folder (configurable)
- **Database**: host, port, user, password, PG super password, PG mode (Native/Docker/Auto)
- **Default Project Config**: HTTP port, project name, admin password
- **Advanced Odoo Config**: addons_path, longpolling, log_level, workers, list_db, dbfilter, proxy_mode, server_wide_modules, data_dir, memory limits
- **About**: version display, check for updates
- Auto-save with "Saved" indicator in footer

### Help System
- **Documentation**: 12+ articles (first install, create project, start/stop, duplicate/delete, custom modules, edit config, debug VS Code, multiple PG, create/restore DB, VS Code dev, Claude Code)
- **Guided Tour**: 12 interactive steps with spotlight overlay, keyboard navigation
- **Troubleshooting**: 18+ entries with symptom/cause/solution, full-text search
- All content translated in EN/VI/KO

### Auto-Update
- Checks GitHub Releases every 30 minutes + manual check
- Download with progress bar, install on quit
- NSIS installer for Windows

### System
- Frameless window with custom titlebar
- System tray (minimize to tray, click to restore)
- Single instance lock
- Admin elevation via PowerShell RunAs (for PostgreSQL, Nginx, symlinks)
- Partial download cleanup on quit

### Validation
- Project name: `^[a-z_][a-z0-9_\-]*$` with realtime hint
- Port: 1024-65535, uniqueness check against existing projects
- Path confinement: resolve check prevents directory traversal
- Backend error codes mapped to translated messages via `tMsg()`

## Duplicate Project Flow

1. Validate name uniqueness + port uniqueness
2. Create folder → junction link → copy addons → copy .vscode → update odoo.conf → setup domain
3. Database is NOT copied (user creates new or restores)
4. Progress events sent to renderer via `duplicate-progress` channel

## IPC Channels

### Request-Response (renderer → main)
`status`, `log`, `full_install`, `run_step`, `create_project`, `read_config`, `save_config`, `delete_project`, `duplicate_project`, `reset_templates`, `start_odoo`, `stop_odoo`, `open_vscode`, `open_explorer`, `open_browser`, `pick-folder`, `window-minimize`, `window-maximize`, `window-close`, `window-is-maximized`, `update-check`, `update-download`, `update-install`, `update-info`, `update-reset-interval`, `app-version`, `default-paths`, `odoo-versions`, `pick-icon`, `get-icon`, `reset-icon`, `watch-log`, `unwatch-log`, `load-settings`, `save-settings`, `open-log-window`, `log-window-pin`

### Push Events (main → renderer)
`log-message`, `task-progress`, `download-progress`, `update-status`, `project-log`, `duplicate-progress`

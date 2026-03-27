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

## Project Name Validation

Regex: `^[a-z_][a-z0-9_\-]*$`
- Lowercase only, no uppercase
- Must start with letter or underscore
- Numbers, hyphens allowed after first char
- Validated both frontend (realtime hint) and backend

## Duplicate Project Flow

1. Validate name uniqueness + port uniqueness
2. Create folder → junction link → copy addons → copy .vscode → update odoo.conf → setup domain
3. Database is NOT copied (user creates new or restores)
4. Progress events sent to renderer via `duplicate-progress` channel

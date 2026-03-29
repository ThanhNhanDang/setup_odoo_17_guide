# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Desktop Electron app for one-click Odoo (15/17/19) installation and project management on Windows. Supports multiple Odoo versions via a version registry pattern. Native desktop app using IPC communication (no HTTP server).

**Platform**: Windows only
**Language**: TypeScript (main/preload) + Vanilla JS (renderer)

## Build & Dev Commands

```bash
npm run dev          # Clean + compile + launch with DevTools
npm start            # Compile + launch (no DevTools)
npm run build        # TypeScript compilation only (tsc)
npm run watch        # tsc in watch mode
npm run dist         # Full build + electron-builder (NSIS installer)
```

**Publish** (from Windows cmd):
```cmd
publish.bat          # Default: patch bump
publish.bat minor    # Minor version bump
publish.bat major    # Major version bump (breaking changes only)
```

## Architecture

Three-process Electron architecture with IPC communication:

### Main Process (`src/main/`)

**Entry**: `index.ts` — App entry, frameless BrowserWindow, admin elevation, auto-updater.

**IPC Handlers** (`src/main/ipc/`): Modular handler registration via shared `IpcContext`.

| Module | Purpose |
|--------|---------|
| `context.ts` | Shared `IpcContext` type (mainWindow, logger, stepLock, logWatchers, logWindows) |
| `window-handlers.ts` | Window controls, pick-folder, open vscode/browser/explorer, pick-file |
| `install-handlers.ts` | Status detection, full_install, run_step |
| `settings-handlers.ts` | App version, default paths, odoo-versions registry, load/save settings, icon management |
| `project-handlers.ts` | Create/delete/duplicate project, start/stop Odoo, reset templates, ensurePgAndStartOdoo |
| `log-handlers.ts` | Log file watching (PowerShell tail + poll fallback), log viewer windows, log-viewer-info/restart |
| `db-handlers.ts` | DB CRUD (list/create/drop/restore), job tracking with file persistence (`db-jobs.json`), dismiss |
| `monitor-handlers.ts` | Thin orchestrator calling log-handlers + db-handlers |

**Services** (`src/main/services/`): Business logic layer called by IPC handlers.

| Service | Purpose |
|---------|---------|
| `odoo-versions.ts` | Version registry: Python/PG versions, download URLs, branches per Odoo version |
| `installer.ts` | 8 install steps (Nginx, Git, VSCode, Python, PG, clone, venv, pip) + `stepCreateProject` |
| `projects.ts` | `deleteProject`, `duplicateProject`, `readProjectConfig`, `saveProjectConfig` |
| `status.ts` | System detection (Python, PG, Git, Docker, Nginx) + `parseProjectConfig` + `checkPort` |
| `detection.ts` | Path finding, `.lnk` shortcut parsing, Docker container detection, async detection functions |
| `ini-parser.ts` | INI file read/write for `odoo.conf` — immutable pattern (`iniSet()` returns new object) |

**Utils** (`src/main/utils/`): Pure helpers (shell, download, nginx, hosts, caddy).

### Preload (`src/preload/index.ts`)
- Context bridge with **channel whitelist** — new IPC channels MUST be added here
- `window.electronAPI.invoke(channel, data)` for request-response
- `window.electronAPI.onEvent(name, callback)` for push events
- Push channels: `log-message`, `task-progress`, `download-progress`, `update-status`, `project-log`, `duplicate-progress`, `create-progress`, `delete-progress`, `db-job-progress`, `language-changed`, `theme-changed`

### Renderer (`src/renderer/`)

**Main App** — vanilla JS, zero frameworks, loaded via `<script>` tags sharing global scope:

| Script | Purpose |
|--------|---------|
| `i18n.js` | Zero-dependency i18n engine: `t('key')`, `applyTranslations()` |
| `docs-data.js` | Help documentation + tour steps + troubleshooting data |
| `tour.js` | Guided tour overlay component |
| `app.js` | Core: navigation, API layer, forms, settings persistence, projects, log, create/delete |
| `install.js` | Install step cards UI, progress bars |
| `dashboard.js` | Dashboard stats, Kanban cards, Project Detail modal, Duplicate |
| `update.js` | Auto-update download + install |
| `theme.js` | Dark/light mode, 4 presets, custom colors, broadcastTheme to monitors |
| `help.js` | Help panel: docs, troubleshooting, tour rendering |

**Monitor Window** (`log-viewer.html` + `scripts/log-viewer.js` + `styles/log-viewer.css`):
- Independent BrowserWindow per project
- Tabs: Log (realtime tail) + Database (CRUD with inline progress rows)
- Theme synced from main app via IPC `theme-changed` event

**Styles**:
- `styles/themes.css` — 4 theme presets (default/autonsi/cyberpunk/luxury) × dark/light modes
- `styles/main.css` — Layout and component styles
- `styles/log-viewer.css` — Monitor window styles

**Locales**: `en.json`, `vi.json`, `ko.json` — all user-facing text must be in all 3 files.

## IPC Communication Pattern

```javascript
// Renderer → Main (request-response):
const result = await api('status', { base_dir, projects_dir });

// Main → Renderer (push events):
mainWindow.webContents.send('duplicate-progress', { step, done });
window.electronAPI.onEvent('duplicate-progress', (data) => { ... });
```

## Key Design Decisions

- **No UI frameworks** — Renderer is pure vanilla HTML/CSS/JS, no build step for frontend
- **IPC replaces HTTP** — All communication through Electron IPC, not fetch/REST
- **Frameless window** — Custom title bar with window control IPC handlers
- **Admin elevation** — Re-launches with PowerShell `RunAs` if not admin (packaged only)
- **Shared base, multiple projects** — One Odoo source + venv per version in `odoo_XX_base/`, multiple project folders with junction links
- **Version registry** — `odoo-versions.ts` is single source of truth for all version-specific config
- **Immutable INI** — `iniSet()` returns new object, never mutates
- **Backend error codes** — Backend returns codes like `INVALID_NAME`, frontend translates via `tMsg()` and `_backendMsgMap`
- **Project name rules** — `^[a-z_][a-z0-9_\-]*$` (lowercase, no leading digit)
- **DB job persistence** — `db-jobs.json` in userData survives app restart; running jobs marked `interrupted` on reload
- **Theme sync** — Main app broadcasts theme changes to all monitor windows via `broadcast-theme` IPC

## Adding New Features Checklist

When adding a new IPC channel:
1. Add handler in the appropriate `src/main/ipc/*-handlers.ts`
2. Add channel name to `validChannels` in `src/preload/index.ts`
3. For push events, also add to `validPushChannels` in preload

When adding user-facing text:
1. Add English key to `locales/en.json`
2. Add Vietnamese translation to `locales/vi.json`
3. Add Korean translation to `locales/ko.json`

When adding backend error codes:
1. Return the code string from the service function
2. Add mapping in `app.js`: `_backendMsgMap`
3. Add `monitor.YOUR_CODE` or `toast.yourKey` to all 3 locale files

## Monitor Window: Database Operations

DB create/restore/drop use **inline progress rows** in the table (not modals):
- Form modal closes on submit → progress row appears in DB table
- Progress events update row in real-time (step label + progress bar + elapsed)
- Jobs tracked in `_inlineJobs` Map (frontend) + `dbJobs` Map (backend)
- Pre-register job BEFORE API call to prevent race with `db-job-progress` event
- File persistence: `db-jobs.json` in `app.getPath('userData')`

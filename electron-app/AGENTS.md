# AGENTS.md — File Index & Module Map

Quick reference for navigating the codebase. Organized by process boundary.

## Main Process (`src/main/`)

### Entry & IPC

| File | Lines | Description |
|------|-------|-------------|
| `index.ts` | ~225 | App entry: frameless BrowserWindow, admin elevation via PowerShell RunAs, system tray (minimize to tray), single instance lock, auto-updater init, partial download cleanup on quit |
| `ipc-handlers.ts` | ~300 | All IPC handlers: status, install, project CRUD, start/stop Odoo, settings, updater, window controls |

### Services (`src/main/services/`)

| File | Lines | Key Exports | Description |
|------|-------|-------------|-------------|
| `config.ts` | ~80 | `DEFAULT_BASE_DIR`, `getDefaultBaseDir()`, `getTemplatesDir()` | Paths, defaults per Odoo version |
| `odoo-versions.ts` | ~120 | `ODOO_VERSIONS`, `getVersionConfig()`, `getPythonCandidates()` | Version registry: Python/PG URLs, branches, docker images |
| `installer.ts` | ~760 | `stepInstallNginx()`, `stepInstallPython()`, `stepCreateProject()`, `stepFullInstall()` | 8 install steps + project creation + full install orchestrator |
| `projects.ts` | ~250 | `deleteProject()`, `duplicateProject()`, `readProjectConfig()`, `saveProjectConfig()` | Project CRUD with progress events |
| `status.ts` | ~200 | `detectStatus()`, `invalidateStatusCache()` | System detection + project listing with 5s cache |
| `detection.ts` | ~250 | `findPython()`, `findPostgresBin()`, `findDockerPostgres()`, `parseLnk()` | Path/tool detection on Windows |
| `logger.ts` | ~50 | `LoggerService` | In-memory 200-line log buffer + IPC push to renderer |
| `updater.ts` | ~80 | `setupAutoUpdater()` | electron-updater for GitHub Releases |
| `step-lock.ts` | ~30 | `StepLockManager` | Mutex preventing parallel install steps |
| `ini-parser.ts` | ~100 | `parseIni()`, `stringifyIni()`, `iniSet()` | Immutable INI parser for odoo.conf |

### Utils (`src/main/utils/`)

| File | Lines | Key Exports | Description |
|------|-------|-------------|-------------|
| `shell.ts` | ~80 | `runCmd()`, `runCmdStreaming()` | Shell execution with streaming output |
| `download.ts` | ~60 | `downloadFile()` | HTTP download with progress events |
| `nginx.ts` | ~100 | `installNginx()`, `isNginxInstalled()` | Nginx download, install, config |
| `hosts.ts` | ~100 | `addHostEntry()`, `projectToDomain()` | Windows hosts file management |
| `caddy.ts` | ~50 | Caddy utilities | Alternative reverse proxy |

## Preload (`src/preload/`)

| File | Description |
|------|-------------|
| `index.ts` | Context bridge: `invoke()` with channel whitelist, `onEvent()` for push events, `removeAllListeners()` |

## Renderer (`src/renderer/`)

### HTML & Styles

| File | Description |
|------|-------------|
| `index.html` | SPA: titlebar, navigation, 3 panels (Dashboard, Install, Help), 6 modals (Settings, New Project, Edit Config, Delete, Duplicate, Detail) |
| `styles/main.css` | ~1300 lines. CSS custom properties, 4 theme presets (default/autonsi/cyberpunk/luxury), dark/light modes |

### Scripts

| File | Lines | Key Functions | Description |
|------|-------|---------------|-------------|
| `scripts/app.js` | ~1800 | `refreshStatus()`, `renderDashboard()`, `renderKanban()`, `startOdoo()`, `stopOdoo()`, `createProject()`, `confirmDuplicate()` | Main app logic, all UI interaction |
| `scripts/i18n.js` | ~100 | `t()`, `initI18n()`, `applyTranslations()`, `setLanguage()` | Zero-dep i18n with fallback chain |
| `scripts/docs-data.js` | ~200 | `TOUR_STEPS`, `DOCS_ENTRIES`, `TROUBLESHOOT_ENTRIES` | Help content using `_t()` for i18n |
| `scripts/tour.js` | ~150 | `startTour()`, `showTourStep()` | Guided tour overlay |

### Locales

| File | Languages | Description |
|------|-----------|-------------|
| `locales/en.json` | English | 150+ keys: nav, settings, dashboard, install, project, modal, toast, update, help, tour, status + docs/troubleshooting in `td.*` |
| `locales/vi.json` | Vietnamese | Full translation including docs and troubleshooting |
| `locales/ko.json` | Korean | Full translation including docs and troubleshooting |

## Templates (`templates/`)

| File | Description |
|------|-------------|
| `odoo.conf` | Odoo config template with `{key}` placeholders |
| `launch.json` | VS Code debug launch config with `{python_path}`, `{odoo_bin_path}` |
| `settings.json` | VS Code workspace settings with `{python_path}` |

## Config Files

| File | Description |
|------|-------------|
| `package.json` | npm scripts, dependencies (electron, electron-builder, typescript) |
| `tsconfig.json` | TypeScript config targeting ES2022, output to `dist/` |
| `electron-builder.yml` | NSIS installer config, GitHub publish, file patterns |
| `publish.bat` | Windows batch: bump version → build → publish → git tag → push |
| `dev-app-update.yml` | Auto-updater config for dev mode |

## Data Flow

```
User clicks button
  → app.js calls api(channel, data)
    → window.electronAPI.invoke(channel, data)
      → ipcMain.handle(channel, handler)
        → service function (installer/projects/status)
          → returns { ok, msg, ... }
        → push events via mainWindow.webContents.send()
      → result back to renderer
    → app.js updates DOM
```

## IPC Channels

### Request-Response (renderer → main)
`status`, `log`, `full_install`, `run_step`, `create_project`, `read_config`, `save_config`, `delete_project`, `duplicate_project`, `reset_templates`, `start_odoo`, `stop_odoo`, `open_vscode`, `open_explorer`, `open_browser`, `pick-folder`, `window-minimize`, `window-maximize`, `window-close`, `window-is-maximized`, `update-check`, `update-download`, `update-install`, `update-info`, `update-reset-interval`, `app-version`, `default-paths`, `odoo-versions`, `pick-icon`, `get-icon`, `reset-icon`, `watch-log`, `unwatch-log`, `load-settings`, `save-settings`

### Push Events (main → renderer)
`log-message`, `task-progress`, `download-progress`, `update-status`, `project-log`, `duplicate-progress`

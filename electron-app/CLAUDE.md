# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Desktop Electron app for one-click Odoo (15/17/19) installation and project management on Windows. Supports multiple Odoo versions via a version registry pattern. Replaces the Python HTTP-based installer with a native desktop application using IPC communication.

## Build & Dev Commands

```bash
npm run dev          # Clean + compile + launch with DevTools
npm start            # Compile + launch (no DevTools)
npm run build        # TypeScript compilation only
npm run watch        # tsc in watch mode
npm run dist         # Full build + electron-builder (NSIS installer)
npm run publish      # Build + publish to GitHub Releases
npm run release:patch  # Version bump + publish (also :minor, :major)
```

## Architecture

Three-process Electron architecture with IPC communication (no HTTP server):

**Main Process** (`src/main/`):
- `index.ts` — App entry, frameless BrowserWindow creation, admin elevation, auto-updater setup
- `ipc-handlers.ts` — 30+ IPC handlers (the API surface). All handlers registered in `registerIpcHandlers(mainWindow)`
- `services/` — Business logic layer:
  - `installer.ts` — 8 installation steps (Nginx, Git, VSCode, Python, PostgreSQL, clone Odoo, venv, pip requirements)
  - `status.ts` — System detection (Python, PostgreSQL, Git, Docker, Nginx) + project config parsing from `odoo.conf`
  - `detection.ts` — Path finding, `.lnk` shortcut parsing, Docker container detection
  - `projects.ts` — CRUD on Odoo projects (create, delete, duplicate, start/stop Odoo)
  - `logger.ts` — In-memory log buffer (200 lines) + real-time event streaming to renderer
  - `updater.ts` — electron-updater wrapper for GitHub Releases auto-update
  - `step-lock.ts` — Prevents concurrent execution of installation steps
  - `ini-parser.ts` — INI file read/write for `odoo.conf`
  - `config.ts` — Default paths, download URLs, project defaults
- `utils/` — Shell execution (`runCmd`/`runCmdStreaming`), file download with progress, Nginx/hosts utilities

**Preload** (`src/preload/index.ts`):
- Context bridge with 27-channel whitelist
- `window.electronAPI.invoke(channel, data)` for request-response
- Push event listeners: `log-message`, `task-progress`, `download-progress`, `update-status`, `project-log`

**Renderer** (`src/renderer/`):
- `index.html` — Single-page app with panels (Dashboard, Install, Log) and modals
- `scripts/app.js` — Vanilla JS (~1500 lines, zero UI frameworks)
- `styles/main.css` — CSS custom properties theme system with 4 presets

## IPC Communication Pattern

```javascript
// Renderer calls main process:
const result = await api('status', { base_dir, projects_dir });
// api() wraps window.electronAPI.invoke() with HTTP fallback

// Main process registers handler:
ipcMain.handle('status', async (_event, data) => detectStatus(...));

// Push events (main → renderer):
mainWindow.webContents.send('project-log', { logPath, lines });
// Renderer listens:
window.electronAPI.onEvent('project-log', (data) => { ... });
```

## Theming System

Four presets (`default`, `autonsi`, `cyberpunk`, `luxury`) with dark/light modes via CSS custom properties and `data-preset`/`data-mode` attributes on `<html>`. Each preset overrides specific component styles (card radius, glow effects, border styles) in `main.css`.

## Key Design Decisions

- **No UI frameworks** — Renderer is pure vanilla HTML/CSS/JS, no build step for frontend
- **IPC replaces HTTP** — All communication through Electron IPC, not fetch/REST
- **Frameless window** — Custom title bar with window control IPC handlers
- **Admin elevation** — Re-launches with PowerShell `RunAs` if not admin (required for PostgreSQL, Nginx)
- **Shared base, multiple projects** — One Odoo source + venv in `odoo_17_base/`, multiple project folders with junction links
- **Step locking** — `StepLockManager` prevents parallel installation step execution
- **Auto-update** — GitHub Releases with NSIS installer, checked 3s after window load
- **Modal structure** — All modals use `.modal-header` (fixed) + `.modal-body` (scrollable) pattern
- **Log file watching** — `fs.watch` with byte-offset reading for real-time Odoo log tailing

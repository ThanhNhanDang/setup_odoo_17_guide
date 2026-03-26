# Skill: Electron Desktop App (Windows)

Build frameless Electron desktop apps for Windows with TypeScript, IPC architecture, and custom dark UI. Zero frontend framework dependencies.

## When to Use

- Building a Windows desktop app with web technologies
- Migrating a web app (Python/Node HTTP server) to desktop
- Creating installer/setup wizard tools
- Apps that need subprocess execution, filesystem access, or admin elevation

## Project Structure

```
my-electron-app/
├── package.json
├── tsconfig.json
├── electron-builder.yml
├── .gitignore
├── resources/
│   └── icon.ico                    # 256x256 minimum
├── templates/                      # App-specific templates (extraResources)
├── src/
│   ├── main/                       # Main process (Node.js backend)
│   │   ├── index.ts                # App entry, BrowserWindow, lifecycle
│   │   ├── ipc-handlers.ts         # All ipcMain.handle() channels
│   │   ├── services/               # Business logic (pure functions)
│   │   │   ├── config.ts           # Constants, defaults
│   │   │   ├── logger.ts           # LoggerService + IPC push
│   │   │   └── [domain].ts         # Domain-specific services
│   │   └── utils/                  # Low-level utilities
│   │       ├── shell.ts            # Subprocess execution
│   │       └── download.ts         # HTTP download with progress
│   ├── preload/
│   │   └── index.ts                # contextBridge (security boundary)
│   └── renderer/                   # Frontend (vanilla HTML/CSS/JS)
│       ├── index.html
│       ├── styles/main.css
│       └── scripts/app.js
├── dist/                           # Compiled TS output (gitignored)
└── release/                        # Packaged app (gitignored)
```

## Scaffold Commands

```bash
mkdir my-electron-app && cd my-electron-app
npm init -y
npm install --save-dev electron electron-builder typescript @types/node rimraf
npm install ini  # Only if you need INI file parsing
```

## package.json

```json
{
  "name": "my-app",
  "version": "1.0.0",
  "main": "dist/main/index.js",
  "scripts": {
    "start": "tsc && electron .",
    "dev": "tsc && electron . --dev",
    "build": "tsc",
    "pack": "tsc && electron-builder --dir",
    "dist": "tsc && electron-builder",
    "clean": "rimraf dist"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "electron": "^33.0.0",
    "electron-builder": "^25.0.0",
    "rimraf": "^6.0.0",
    "typescript": "^5.5.0"
  }
}
```

## tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "sourceMap": true,
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

## electron-builder.yml

```yaml
appId: com.mycompany.myapp
productName: "My App"
directories:
  output: release
  buildResources: resources

files:
  - dist/**/*
  - src/renderer/**/*
  - templates/**/*

extraResources:
  - from: templates
    to: templates
  - from: resources/icon.ico
    to: icon.ico

win:
  target:
    - target: nsis
    - target: dir
  icon: resources/icon.ico
  requestedExecutionLevel: requireAdministrator  # Remove if admin not needed
  signDlls: false

forceCodeSigning: false

nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  runAfterFinish: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  shortcutName: "My App"

asar: true
```

## .gitignore

```
node_modules/
dist/
release/
*.exe
*.blockmap
```

---

## Core Patterns

### 1. Main Process (index.ts)

```typescript
import { app, BrowserWindow, dialog, Menu } from 'electron';
import * as path from 'path';
import { registerIpcHandlers } from './ipc-handlers';

let mainWindow: BrowserWindow | null = null;

function getIconPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'icon.ico');
  return path.join(__dirname, '..', '..', 'resources', 'icon.ico');
}

function createWindow(): void {
  // Remove default menu (File/Edit/View/Window/Help)
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'My App',
    backgroundColor: '#0d1117',
    icon: getIconPath(),
    frame: false,               // Frameless window
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,   // MANDATORY: isolate renderer
      nodeIntegration: false,   // MANDATORY: no Node in renderer
      sandbox: false,
      // __dirname = dist/main/, preload at dist/preload/
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
    },
  });

  // __dirname = dist/main/, renderer at src/renderer/
  mainWindow.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  registerIpcHandlers(mainWindow);
  mainWindow.on('closed', () => { mainWindow = null; });
}

// Set app name (taskbar, Alt+Tab)
app.setName('My App');

// Error handlers
process.on('uncaughtException', (error) => {
  console.error('Uncaught:', error);
  dialog.showErrorBox('Error', `${error.message}\n\n${error.stack}`);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
```

### 2. Preload Bridge (preload/index.ts)

```typescript
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Request-response (renderer -> main -> response)
  invoke: (channel: string, data: unknown): Promise<unknown> => {
    const validChannels = [
      'my-channel-1', 'my-channel-2',
      'window-minimize', 'window-maximize', 'window-close',
    ];
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, data);
    }
    return Promise.reject(new Error(`Invalid channel: ${channel}`));
  },

  // Push events (main -> renderer, real-time)
  onEvent: (eventName: string, callback: (...args: any[]) => void): void => {
    ipcRenderer.on(eventName, (_event, ...args) => callback(...args));
  },

  removeAllListeners: (channel: string): void => {
    ipcRenderer.removeAllListeners(channel);
  },
});
```

### 3. IPC Handlers (ipc-handlers.ts)

```typescript
import { ipcMain, BrowserWindow, shell } from 'electron';

/** Wrap handler with error catching */
function safe<T>(fn: () => Promise<T>): Promise<T | { ok: false; msg: string }> {
  return fn().catch((e: Error) => ({ ok: false as const, msg: `Error: ${e.message}` }));
}

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  // Window controls (frameless)
  ipcMain.handle('window-minimize', () => mainWindow.minimize());
  ipcMain.handle('window-maximize', () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('window-close', () => mainWindow.close());

  // App-specific handlers
  ipcMain.handle('my-channel', async (_event, data) => {
    return safe(async () => {
      // Business logic here
      return { ok: true, result: 'data' };
    });
  });
}
```

### 4. Logger Service with IPC Push

```typescript
import { BrowserWindow } from 'electron';

export interface TaskProgress {
  readonly status: 'idle' | 'running' | 'done' | 'error';
  readonly step: string;
  readonly progress: number;
}

export class LoggerService {
  private readonly lines: string[] = [];
  private task: TaskProgress = { status: 'idle', step: '', progress: 0 };

  constructor(private readonly window: BrowserWindow) {}

  log(msg: string): void {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const line = `[${ts}] ${msg}`;
    this.lines.push(line);
    if (!this.window.isDestroyed()) {
      this.window.webContents.send('log-message', line);
    }
  }

  updateTask(update: Partial<TaskProgress>): void {
    this.task = { ...this.task, ...update };
    if (!this.window.isDestroyed()) {
      this.window.webContents.send('task-progress', this.task);
    }
  }

  getLines(count: number = 200): readonly string[] {
    return this.lines.slice(-count);
  }

  getTask(): Readonly<TaskProgress> { return this.task; }
}
```

### 5. Shell Utility (Windows subprocess)

```typescript
import { execFile, spawn, ChildProcess } from 'child_process';
import { LoggerService } from '../services/logger';

export interface CmdResult {
  readonly code: number;
  readonly output: string;
}

/** Run command and return result */
export function runCmd(cmd: string, cwd?: string, env?: NodeJS.ProcessEnv): Promise<CmdResult> {
  return new Promise((resolve) => {
    execFile('cmd.exe', ['/c', cmd], {
      cwd,
      env: env ?? process.env,
      timeout: 1_800_000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        code: error ? 1 : 0,
        output: (stdout || '') + (stderr || ''),
      });
    });
  });
}

/** Run command with real-time log streaming */
export function runCmdStreaming(
  cmd: string, logger: LoggerService, options?: { cwd?: string }
): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn('cmd.exe', ['/c', cmd], {
      cwd: options?.cwd,
      windowsHide: true,
    });
    proc.stdout?.on('data', (data: Buffer) => {
      data.toString().split('\n').filter(Boolean).forEach(line => {
        logger.log(`    ${line.trim()}`);
      });
    });
    proc.stderr?.on('data', (data: Buffer) => {
      data.toString().split('\n').filter(Boolean).forEach(line => {
        logger.log(`    ${line.trim()}`);
      });
    });
    proc.on('close', (code) => resolve(code ?? 1));
  });
}
```

### 6. Download with Progress

```typescript
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import { LoggerService } from '../services/logger';

export function downloadFile(url: string, destPath: string, logger: LoggerService): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const request = protocol.get(url, (response) => {
      // Follow redirects
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadFile(response.headers.location, destPath, logger).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const total = parseInt(response.headers['content-length'] || '0', 10);
      let downloaded = 0, lastPct = -1;
      response.on('data', (chunk: Buffer) => {
        downloaded += chunk.length;
        if (total > 0) {
          const pct = Math.round((downloaded / total) * 100);
          if (pct >= lastPct + 10) {
            lastPct = pct;
            logger.log(`    Download: ${(downloaded/1024/1024).toFixed(1)}MB / ${(total/1024/1024).toFixed(1)}MB (${pct}%)`);
          }
        }
      });
      const file = fs.createWriteStream(destPath);
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
    });
    request.on('error', reject);
    request.setTimeout(300_000, () => { request.destroy(); reject(new Error('Timeout')); });
  });
}
```

---

## UI Patterns

### Custom Title Bar (frameless window)

```html
<div class="titlebar">
  <div class="titlebar-brand">
    <svg>...</svg>
    My App
  </div>
  <div class="titlebar-controls">
    <button onclick="window.electronAPI.invoke('window-minimize')">&#x2014;</button>
    <button onclick="window.electronAPI.invoke('window-maximize')">&#9744;</button>
    <button class="close" onclick="window.electronAPI.invoke('window-close')">&#10005;</button>
  </div>
</div>
```

```css
.titlebar {
  display: flex; align-items: center; justify-content: space-between;
  height: 40px; background: #010409; padding: 0 8px 0 16px;
  -webkit-app-region: drag;      /* Enable window dragging */
  user-select: none;
  border-bottom: 1px solid #21262d;
}
.titlebar-controls { display: flex; -webkit-app-region: no-drag; }
.titlebar-controls button {
  width: 46px; height: 40px; border: none; background: transparent;
  color: #8b949e; cursor: pointer;
}
.titlebar-controls button:hover { background: #21262d; color: #c9d1d9; }
.titlebar-controls button.close:hover { background: #da3633; color: #fff; }
```

### Horizontal Tab Navigation

```html
<div class="topnav">
  <button class="nav-tab active" onclick="showPanel('home', this)">Home</button>
  <button class="nav-tab" onclick="showPanel('settings', this)">Settings</button>
  <div class="nav-spacer"></div>
  <span class="nav-version">v1.0.0</span>
</div>
```

```css
.topnav {
  display: flex; align-items: center; gap: 4px;
  height: 48px; background: #0d1117; padding: 0 20px;
  border-bottom: 1px solid #21262d;
}
.nav-tab {
  padding: 8px 18px; border-radius: 6px; border: 1px solid transparent;
  color: #8b949e; background: transparent; cursor: pointer;
}
.nav-tab.active { color: #f0883e; border-color: #f0883e; background: #1c1208; }
.nav-spacer { flex: 1; }
```

### Panel Switching (JS)

```javascript
function showPanel(name, el) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  if (el) el.classList.add('active');
}
```

### API Layer (IPC with HTTP fallback)

```javascript
async function api(channel, data = {}) {
  if (window.electronAPI) {
    return window.electronAPI.invoke(channel, data);
  }
  // Fallback for dev without Electron
  const res = await fetch('/api/' + channel, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return res.json();
}
```

### Real-Time Log Push (replaces HTTP polling)

```javascript
// Listen for push events from main process
if (window.electronAPI) {
  window.electronAPI.onEvent('log-message', (line) => {
    const el = document.getElementById('log');
    el.innerHTML += `<div class="line">${escHtml(line)}</div>`;
    el.scrollTop = el.scrollHeight;
  });

  window.electronAPI.onEvent('task-progress', (task) => {
    document.getElementById('progressFill').style.width = task.progress + '%';
    document.getElementById('progressStep').textContent = task.step;
  });
}
```

### Escape Backslash in onclick Attributes (CRITICAL on Windows)

Windows paths like `D:\workspaces\project` lose backslashes inside `onclick="fn('...')"` because JS interprets `\w` as escape sequences.

```javascript
// escHtml - for display text (prevents XSS)
function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// escAttr - for onclick attribute values (escapes backslashes + quotes)
function escAttr(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// Usage in template literals:
`<span>${escHtml(p.path)}</span>`                          // display: OK
`<button onclick="openFolder('${escAttr(p.path)}')">Open</button>` // onclick: OK
// WRONG: onclick="openFolder('${escHtml(p.path)}')"  ← backslashes stripped!
```

### Open Folder in Explorer

```typescript
// WRONG: shell.showItemInFolder(path) - only works for FILE paths
// RIGHT: shell.openPath(path) - works for both files and folders
ipcMain.handle('open_explorer', async (_event, data) => {
  await shell.openPath(data.path);
  return { ok: true };
});
```

### Auto-Update (electron-updater)

```bash
npm install electron-updater
```

```typescript
// src/main/services/updater.ts
import { autoUpdater, UpdateInfo } from 'electron-updater';

export class UpdaterService {
  constructor(private readonly window: BrowserWindow) {
    autoUpdater.autoDownload = false;  // Let user decide
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      window.webContents.send('update-status', {
        status: 'available', version: info.version,
      });
    });

    autoUpdater.on('download-progress', (progress) => {
      window.webContents.send('update-status', {
        status: 'downloading', percent: Math.round(progress.percent),
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      window.webContents.send('update-status', {
        status: 'ready', version: info.version,
      });
    });
  }

  checkForUpdates(): void { autoUpdater.checkForUpdates(); }
  downloadUpdate(): void { autoUpdater.downloadUpdate(); }
  installUpdate(): void { autoUpdater.quitAndInstall(false, true); }
}

// In main index.ts - check after window loads:
mainWindow.webContents.on('did-finish-load', () => {
  const updater = new UpdaterService(mainWindow);
  setTimeout(() => updater.checkForUpdates(), 3000);
});
```

```javascript
// Renderer: listen for update events, show toast notification
window.electronAPI.onEvent('update-status', (data) => {
  if (data.status === 'available') showToast(`v${data.version} available`, 'Update Now');
  if (data.status === 'downloading') showToast(`Downloading ${data.percent}%`);
  if (data.status === 'ready') showToast('Ready to install', 'Restart Now');
});
```

electron-builder.yml:
```yaml
publish:
  provider: github
  owner: your-username
  repo: your-repo
```

### Dashboard with Kanban Cards

```html
<div class="dash-kanban" id="kanban"></div>
```

```javascript
function renderKanban(items) {
  const search = $('search').value.toLowerCase();
  const filtered = items.filter(item =>
    item.name.toLowerCase().includes(search)
  );
  $('kanban').innerHTML = filtered.map(item => `
    <div class="kanban-card">
      <div class="kanban-card-header">
        <span class="kanban-card-name">${escHtml(item.name)}</span>
        <span class="kanban-card-port">:${escHtml(item.port)}</span>
      </div>
      <div class="kanban-card-body">
        <!-- metadata grid -->
      </div>
      <div class="kanban-card-actions">
        <button onclick="action('${escAttr(item.id)}')">Action</button>
        <button onclick="showDetail('${escAttr(item.id)}')">Detail</button>
      </div>
    </div>
  `).join('');
}
```

```css
.dash-kanban {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}
.kanban-card {
  background: #161b22; border: 1px solid #21262d; border-radius: 10px;
  overflow: hidden; transition: all 0.2s;
}
.kanban-card:hover {
  border-color: #30363d; transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
}
```

---

## Publish Workflow

### publish.bat (one-command release)

```cmd
set GH_TOKEN=ghp_xxxxxxxxxxxx
publish.bat patch    # 1.0.0 -> 1.0.1
publish.bat minor    # 1.0.0 -> 1.1.0
publish.bat major    # 1.0.0 -> 2.0.0
```

Script does: bump version -> tsc -> electron-builder --publish always -> gh release edit --draft=false -> git tag + push.

Key points:
- Use `node -p "require('./package.json').version"` to read version (not `findstr`)
- electron-builder creates **draft** releases by default - must publish with `gh release edit`
- `GH_TOKEN` env var required (GitHub Personal Access Token with `repo` scope)
- `git tag -f` to force-update tag if already exists

---

## Dark Theme Color System (GitHub Dark)

```css
/* Backgrounds */
--bg-canvas:    #0d1117;     /* Main background */
--bg-surface:   #161b22;     /* Cards, sections */
--bg-inset:     #010409;     /* Log boxes, inputs */

/* Borders */
--border-default:  #21262d;
--border-muted:    #30363d;

/* Text */
--text-primary:    #e6edf3;
--text-secondary:  #8b949e;
--text-tertiary:   #484f58;

/* Accent */
--accent-orange:   #f0883e;  /* Primary actions, active tabs */
--accent-green:    #3fb950;  /* Success */
--accent-red:      #f85149;  /* Danger, errors */
--accent-blue:     #58a6ff;  /* Info, links */

/* Status backgrounds */
--bg-success:      #0d2818;
--bg-danger:       #2d1117;
--bg-info:         #0c2d6b;

/* Scrollbar */
::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: #0d1117; }
::-webkit-scrollbar-thumb { background: #30363d; border-radius: 4px; }
```

---

## Path Resolution Rules

```
Compiled output:  dist/main/index.js     (__dirname = dist/main/)
Preload:          dist/preload/index.js  (path: __dirname/../preload/)
Renderer HTML:    src/renderer/index.html (path: __dirname/../../src/renderer/)
Resources (dev):  resources/icon.ico     (path: __dirname/../../resources/)
Resources (pkg):  process.resourcesPath  (extraResources destination)
Templates (dev):  templates/             (path: __dirname/../../../templates/)
Templates (pkg):  process.resourcesPath/templates/
```

## Build & Distribution

```bash
# Development
npm run dev          # Compile + launch with DevTools

# Package (unpacked directory, ~269MB)
npm run pack         # Creates release/win-unpacked/

# NSIS installer (from Admin terminal if requestedExecutionLevel set)
npm run dist         # Creates release/My App Setup X.X.X.exe (~78MB)
```

### Icon Requirements
- Format: `.ico`
- Minimum: 256x256 pixels
- Place in: `resources/icon.ico`

### Admin Elevation
- Set `requestedExecutionLevel: requireAdministrator` in electron-builder.yml
- Build from Admin terminal (required for code signing tools)
- Enable Windows Developer Mode if symlink errors occur during build

---

## Common Gotchas

| Problem | Cause | Fix |
|---|---|---|
| Path backslashes stripped in onclick | JS escape sequences | Use `escAttr()` not `escHtml()` for onclick values |
| Explorer button does nothing | `shell.showItemInFolder` needs file path | Use `shell.openPath()` for folders |
| VS Code doesn't open folder | Path not quoted | `code "${targetPath}"` with quotes |
| Icon error during build | Icon < 256x256 | Generate 256x256 minimum `.ico` |
| winCodeSign symlink error | Not admin / no dev mode | Run from Admin terminal or enable Developer Mode |
| Release is draft on GitHub | electron-builder default | `gh release edit vX.X.X --draft=false` |
| `tsc` not found in .bat | Not in PATH | Use `npx tsc` |
| Tag already exists | Re-releasing same version | `git tag -f vX.X.X` + `git push --force` |

## Checklist: New Electron App

1. [ ] Scaffold: `package.json`, `tsconfig.json`, `electron-builder.yml`, `.gitignore`
2. [ ] Create: `src/main/index.ts` (frameless BrowserWindow + Menu.setApplicationMenu(null))
3. [ ] Create: `src/preload/index.ts` (contextBridge with channel whitelist)
4. [ ] Create: `src/main/ipc-handlers.ts` (window controls + app channels)
5. [ ] Create: `src/main/services/logger.ts` (LoggerService with IPC push)
6. [ ] Create: `src/main/utils/shell.ts` (runCmd + runCmdStreaming)
7. [ ] Create: `src/renderer/index.html` (custom titlebar + topnav + panels)
8. [ ] Create: `src/renderer/styles/main.css` (dark theme)
9. [ ] Create: `src/renderer/scripts/app.js` (IPC api layer + panel switching)
10. [ ] Add: `resources/icon.ico` (256x256 minimum)
11. [ ] Build: `npm run dev` (verify UI + IPC)
12. [ ] Package: `npm run dist` (from Admin terminal)

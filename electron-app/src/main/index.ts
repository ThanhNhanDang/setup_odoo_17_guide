import { app, BrowserWindow, dialog, Menu, Tray, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { registerIpcHandlers } from './ipc-handlers';
import { UpdaterService } from './services/updater';
import { initTelemetry, trackEvent, stopTelemetry } from './services/telemetry';

// Self-elevate to Admin if not already (Windows only)
// In dev mode (--dev flag or VS Code F5), skip elevation so the app still launches.
// Some operations (PostgreSQL install, Nginx) require admin — those will fail gracefully.
/** @returns true if we can continue, false if app is quitting (re-launching as admin) */
function ensureAdmin(): boolean {
  if (process.platform !== 'win32') return true;
  // Skip admin elevation in dev mode — allows F5 from VS Code
  if (process.argv.includes('--dev') || !app.isPackaged) return true;
  try {
    execSync('net session', { stdio: 'ignore', windowsHide: true });
    // Already admin
    return true;
  } catch {
    // Not admin - relaunch with elevation (packaged app only)
    const args = process.argv.slice(1).join('" "');
    execSync(
      `powershell -Command "Start-Process -FilePath '${process.execPath}' -ArgumentList '${args}' -Verb RunAs"`,
      { windowsHide: true }
    );
    app.quit();
    return false;
  }
}

// Reduce resize flicker on Windows frameless windows
app.commandLine.appendSwitch('disable-features', 'WidgetLayering');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let nginxCheckInterval: ReturnType<typeof setInterval> | null = null;

function getIconPath(): string {
  // Check for user-custom icon first
  const customDir = path.join(app.getPath('userData'), 'custom-icon');
  if (fs.existsSync(customDir)) {
    for (const ext of ['.ico', '.png', '.svg']) {
      const p = path.join(customDir, `icon${ext}`);
      if (fs.existsSync(p)) return p;
    }
  }
  // Fallback to bundled icon
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'icon.ico');
  }
  return path.join(__dirname, '..', '..', 'resources', 'icon.ico');
}

function createWindow(): void {
  // Use a minimal menu with Edit role so keyboard shortcuts (Ctrl+C/V/X/A, typing in inputs) work on Windows frameless windows.
  // Setting null would disable all accelerators and break text input in some cases.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'editMenu' },
  ]));

  // Resolve saved theme to set correct initial background color
  let mainBgColor = '#0d1117';
  try {
    const settingsFile = path.join(app.getPath('userData'), 'user-settings.json');
    if (fs.existsSync(settingsFile)) {
      const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      const preset = raw.preset || 'default';
      const mode = raw.mode || 'dark';
      const bgMap: Record<string, Record<string, string>> = {
        default: { dark: '#0d1117', light: '#ffffff' },
        autonsi: { dark: '#08080c', light: '#fafaff' },
        cyberpunk: { dark: '#05050a', light: '#eef4f8' },
        luxury: { dark: '#14101a', light: '#faf5f8' },
      };
      mainBgColor = bgMap[preset]?.[mode] || mainBgColor;
    }
  } catch { /* ignore */ }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Odoo Installer',
    backgroundColor: mainBgColor,
    icon: getIconPath(),
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow!.show());

  // Load the renderer HTML
  // __dirname = dist/main/, renderer is at src/renderer/
  const rendererPath = path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html');
  mainWindow.loadFile(rendererPath);

  // Open DevTools in development (Ctrl+Shift+I still works)
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  // Register IPC handlers (once only)
  registerIpcHandlers(mainWindow);

  // Auto-update (once only — not inside did-finish-load to avoid duplicate handlers)
  const updater = new UpdaterService(mainWindow);
  registerUpdateHandlers(mainWindow, updater);
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      updater.checkForUpdates();
      updater.startPeriodicCheck();
    }, 3000);

    // Auto-start Nginx if installed but not running, then check every 60s
    setTimeout(() => {
      autoStartNginx();
      nginxCheckInterval = setInterval(() => autoStartNginx(), 60_000);
    }, 5000);

    // Initialize telemetry & track app launch
    initTelemetry().catch(() => {});
    trackEvent('APP_LAUNCHED', { app_version: app.getVersion() }).catch(() => {});
  });

  // Minimize to tray instead of closing
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow!.hide();
    }
  });

  mainWindow.on('closed', () => {
    updater.stopPeriodicCheck();
    if (nginxCheckInterval) { clearInterval(nginxCheckInterval); nginxCheckInterval = null; }
    mainWindow = null;
  });
}

function createTray(): void {
  const iconPath = getIconPath();
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Odoo Installer');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // Click tray icon → show window
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

/** Auto-start Nginx on app launch if installed but not running */
async function autoStartNginx(): Promise<void> {
  try {
    const settingsFile = path.join(app.getPath('userData'), 'user-settings.json');
    let odooVersion = '17';
    try {
      if (fs.existsSync(settingsFile)) {
        const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        if (raw.odooVersion) odooVersion = raw.odooVersion;
      }
    } catch {}

    const { getDefaultBaseDir } = require('./services/config');
    const baseDir = getDefaultBaseDir(odooVersion);
    const { isNginxInstalled, findNginxAcrossBaseDirs, startNginx } = require('./utils/nginx');
    const { ALL_VERSIONS } = require('./services/odoo-versions');

    // Find Nginx in current or any other version's base dir
    let nginxBaseDir = baseDir;
    if (!isNginxInstalled(baseDir)) {
      const allBaseDirs = ALL_VERSIONS.map((v: string) => getDefaultBaseDir(v));
      const found = findNginxAcrossBaseDirs(allBaseDirs);
      if (!found) return;
      nginxBaseDir = found;
    }

    // Sync hosts file — add entries for all project domains across all versions
    try {
      const { getDefaultProjectsDir } = require('./services/config');
      const { addHostEntry } = require('./utils/hosts');
      for (const v of ALL_VERSIONS) {
        const projDir = getDefaultProjectsDir(v);
        if (!fs.existsSync(projDir)) continue;
        for (const entry of fs.readdirSync(projDir)) {
          try {
            const conf = path.join(projDir, entry, 'odoo.conf');
            if (!fs.existsSync(conf)) continue;
            const raw = fs.readFileSync(conf, 'utf8');
            const dm = raw.match(/^;\s*project_domain\s*=\s*(.+)$/m);
            if (dm) addHostEntry(dm[1].trim());
          } catch { /* skip */ }
        }
      }
    } catch { /* non-critical */ }

    // Check if already running (port 443)
    const { runCmd } = require('./utils/shell');
    const { output } = await runCmd('netstat -ano | findstr ":443.*LISTEN"');
    if (output.trim().length > 0) return; // already running

    // Start Nginx silently (no logger needed — just ensure it runs)
    const { LoggerService } = require('./services/logger');
    const silentLogger = { log: () => {} } as any;
    await startNginx(nginxBaseDir, silentLogger);
  } catch {
    // Ignore — non-critical
  }
}

function registerUpdateHandlers(win: BrowserWindow, updater: UpdaterService): void {
  const { ipcMain } = require('electron');
  ipcMain.handle('update-check', () => updater.checkForUpdates());
  ipcMain.handle('update-download', () => updater.downloadUpdate());
  ipcMain.handle('update-install', () => updater.installUpdate());
  ipcMain.handle('update-info', () => updater.getUpdateInfo());
  ipcMain.handle('update-reset-interval', () => updater.startPeriodicCheck());
}

// Set app name (shows in taskbar, Alt+Tab, etc.)
app.setName('Odoo 17 Installer');

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  dialog.showErrorBox('Unexpected Error', `${error.message}\n\n${error.stack}`);
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
      mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    if (!ensureAdmin()) return; // Re-launching as admin — don't create window
    createTray();
    createWindow();
  });

  // Cleanup partial downloads on quit
  app.on('before-quit', () => {
    isQuitting = true;
    stopTelemetry();
    const { DEFAULT_BASE_DIR } = require('./services/config');
    const partialFiles = [
      'vscode-installer.exe', 'git-installer.exe',
      'python-3.11.4-amd64.exe', 'postgresql-16-installer.exe',
    ];
    for (const f of partialFiles) {
      const fp = path.join(DEFAULT_BASE_DIR, f);
      try {
        if (fs.existsSync(fp)) {
          const stat = fs.statSync(fp);
          // Delete if file is suspiciously small (partial download)
          if (stat.size < 1_000_000) {
            fs.unlinkSync(fp);
          }
        }
      } catch { /* ignore cleanup errors */ }
    }
  });

  app.on('window-all-closed', () => {
    // Don't quit — app stays in tray
  });
}

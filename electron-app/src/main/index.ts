import { app, BrowserWindow, dialog, Menu, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { registerIpcHandlers } from './ipc-handlers';
import { UpdaterService } from './services/updater';

// Self-elevate to Admin if not already (Windows only)
function ensureAdmin(): void {
  if (process.platform !== 'win32') return;
  try {
    execSync('net session', { stdio: 'ignore', windowsHide: true });
    // Already admin
  } catch {
    // Not admin - relaunch with elevation
    const { shell } = require('electron');
    const appPath = app.isPackaged
      ? process.execPath
      : `"${process.execPath}" "${path.join(__dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe')}"`;

    if (app.isPackaged) {
      // Use PowerShell Start-Process -Verb RunAs for packaged app
      const args = process.argv.slice(1).join('" "');
      execSync(
        `powershell -Command "Start-Process -FilePath '${process.execPath}' -ArgumentList '${args}' -Verb RunAs"`,
        { windowsHide: true }
      );
    }
    app.quit();
  }
}

let mainWindow: BrowserWindow | null = null;

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
  // Remove default menu bar entirely (File, Edit, View, Window, Help)
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,              // Don't show until content is ready
    title: 'Odoo 17 Installer',
    backgroundColor: '#0d1117',
    icon: getIconPath(),
    frame: false,             // Frameless - custom title bar
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // __dirname = dist/main/, preload is at dist/preload/
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
    },
  });

  // Show window only after content is painted — prevents white flash
  mainWindow.once('ready-to-show', () => {
    mainWindow!.show();
  });

  // Load the renderer HTML
  // __dirname = dist/main/, renderer is at src/renderer/
  const rendererPath = path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html');
  mainWindow.loadFile(rendererPath);

  // Open DevTools in development (Ctrl+Shift+I still works)
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  // Register IPC handlers
  registerIpcHandlers(mainWindow);

  // Auto-update: check after window is ready
  mainWindow.webContents.on('did-finish-load', () => {
    const updater = new UpdaterService(mainWindow!);
    registerUpdateHandlers(mainWindow!, updater);
    // Check for updates after UI is settled
    setTimeout(() => updater.checkForUpdates(), 3000);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerUpdateHandlers(win: BrowserWindow, updater: UpdaterService): void {
  const { ipcMain } = require('electron');
  ipcMain.handle('update-check', () => updater.checkForUpdates());
  ipcMain.handle('update-download', () => updater.downloadUpdate());
  ipcMain.handle('update-install', () => updater.installUpdate());
  ipcMain.handle('update-info', () => updater.getUpdateInfo());
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
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    ensureAdmin();
    createWindow();
  });

  // Cleanup partial downloads on quit
  app.on('before-quit', () => {
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
    app.quit();
  });
}

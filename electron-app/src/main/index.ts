import { app, BrowserWindow, dialog, Menu } from 'electron';
import * as path from 'path';
import { registerIpcHandlers } from './ipc-handlers';

let mainWindow: BrowserWindow | null = null;

function getIconPath(): string {
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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

  app.whenReady().then(createWindow);

  app.on('window-all-closed', () => {
    app.quit();
  });
}

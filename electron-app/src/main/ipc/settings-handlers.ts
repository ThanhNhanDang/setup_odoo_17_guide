import { ipcMain, app, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { IpcContext } from './context';
import { DEFAULT_ODOO_VERSION, ALL_VERSIONS, ODOO_VERSIONS, getEffectiveVersionConfig } from '../services/odoo-versions';
import { getDefaultBaseDir, getDefaultProjectsDir } from '../services/config';

/** Read user URL overrides from settings file */
function readUrlOverrides(): Record<string, { pythonUrl?: string; postgresUrl?: string }> {
  try {
    const settingsFile = path.join(app.getPath('userData'), 'user-settings.json');
    if (fs.existsSync(settingsFile)) {
      const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (raw.versionUrlOverrides) return raw.versionUrlOverrides;
    }
  } catch { /* ignore */ }
  return {};
}

export { readUrlOverrides };

export function registerSettingsHandlers(ctx: IpcContext): void {
  // --- App Info ---
  ipcMain.handle('app-version', () => app.getVersion());

  ipcMain.handle('default-paths', (_event, data?: Record<string, string>) => {
    const version = data?.odoo_version || DEFAULT_ODOO_VERSION;
    return {
      base_dir: getDefaultBaseDir(version),
      projects_dir: getDefaultProjectsDir(version),
      odoo_version: version,
    };
  });

  // --- Odoo Versions Registry (for UI) ---
  ipcMain.handle('odoo-versions', () => {
    const urlOverrides = readUrlOverrides();
    return {
      versions: ALL_VERSIONS.map(v => {
        const cfg = getEffectiveVersionConfig(v, urlOverrides);
        return {
          key: cfg.key,
          label: cfg.label,
          settingsLabel: cfg.settingsLabel,
          pythonVersion: cfg.pythonVersion,
          postgresVersion: cfg.postgresVersion,
          pgvector: cfg.pgvector,
          branch: cfg.branch,
          color: cfg.color,
          pythonUrl: cfg.pythonUrl,
          postgresUrl: cfg.postgresUrl,
          defaultPythonUrl: ODOO_VERSIONS[v].pythonUrl,
          defaultPostgresUrl: ODOO_VERSIONS[v].postgresUrl,
        };
      }),
      default: DEFAULT_ODOO_VERSION,
    };
  });

  // --- User Settings Persistence ---
  const settingsFile = path.join(app.getPath('userData'), 'user-settings.json');

  ipcMain.handle('load-settings', async () => {
    try {
      if (fs.existsSync(settingsFile)) {
        const raw = fs.readFileSync(settingsFile, 'utf8');
        return { ok: true, settings: JSON.parse(raw) };
      }
    } catch { /* corrupted file */ }
    return { ok: true, settings: {} };
  });

  ipcMain.handle('save-settings', async (_event, data: Record<string, string>) => {
    try {
      const dir = path.dirname(settingsFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify(data, null, 2), 'utf8');

      // Broadcast language change to all log/monitor windows
      if (data.language) {
        for (const [, win] of ctx.logWindows) {
          if (!win.isDestroyed()) {
            win.webContents.send('language-changed', { language: data.language });
          }
        }
      }

      return { ok: true };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  });

  // --- Icon Management ---
  ipcMain.handle('get-icon', async () => {
    const customDir = path.join(app.getPath('userData'), 'custom-icon');
    const defaultDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', '..', 'resources');
    for (const ext of ['.ico', '.png', '.svg']) {
      const p = path.join(customDir, `icon${ext}`);
      if (fs.existsSync(p)) {
        const buf = fs.readFileSync(p);
        const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : 'image/x-icon';
        return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, path: p, isCustom: true };
      }
    }
    for (const ext of ['.ico', '.png', '.svg']) {
      const p = path.join(defaultDir, `icon${ext}`);
      if (fs.existsSync(p)) {
        const buf = fs.readFileSync(p);
        const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : 'image/x-icon';
        return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, path: '', isCustom: false };
      }
    }
    return { ok: false, dataUrl: '', isCustom: false };
  });

  ipcMain.handle('pick-icon', async () => {
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: 'Select App Icon',
      filters: [{ name: 'Icons', extensions: ['ico', 'png', 'svg'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, msg: 'cancelled' };
    const src = result.filePaths[0];
    const ext = path.extname(src).toLowerCase();
    const customDir = path.join(app.getPath('userData'), 'custom-icon');
    try {
      if (!fs.existsSync(customDir)) fs.mkdirSync(customDir, { recursive: true });
      for (const old of ['.ico', '.png', '.svg']) {
        const oldPath = path.join(customDir, `icon${old}`);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      const destName = `icon${ext}`;
      const destPath = path.join(customDir, destName);
      fs.copyFileSync(src, destPath);
      if (ext === '.ico' || ext === '.png') {
        const { nativeImage } = require('electron');
        ctx.mainWindow.setIcon(nativeImage.createFromPath(destPath));
      }
      const buf = fs.readFileSync(src);
      const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : 'image/x-icon';
      return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, fileName: destName };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  });

  ipcMain.handle('reset-icon', async () => {
    const customDir = path.join(app.getPath('userData'), 'custom-icon');
    try {
      if (fs.existsSync(customDir)) {
        for (const ext of ['.ico', '.png', '.svg']) {
          const p = path.join(customDir, `icon${ext}`);
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }
      }
      const defaultIcon = app.isPackaged
        ? path.join(process.resourcesPath, 'icon.ico')
        : path.join(__dirname, '..', '..', '..', 'resources', 'icon.ico');
      if (fs.existsSync(defaultIcon)) {
        const { nativeImage } = require('electron');
        ctx.mainWindow.setIcon(nativeImage.createFromPath(defaultIcon));
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  });
}

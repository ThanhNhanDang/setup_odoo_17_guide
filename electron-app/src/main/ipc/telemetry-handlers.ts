// ---------------------------------------------------------------------------
// Telemetry IPC Handlers — Admin Dashboard data access + window management
// ---------------------------------------------------------------------------

import { ipcMain, BrowserWindow } from 'electron';
import * as path from 'path';
import { IpcContext } from './context';
import {
  verifyAdminPassword,
  fetchAdminStats,
  fetchActionLogs,
  fetchUsers,
  trackEvent,
} from '../services/telemetry';

export function registerTelemetryHandlers(ctx: IpcContext): void {
  // Verify admin password (SHA-256 comparison)
  ipcMain.handle('admin-verify-password', async (_event, data: { password: string }) => {
    const ok = verifyAdminPassword(data?.password || '');
    return { ok };
  });

  // Fetch aggregated stats for charts
  ipcMain.handle('fetch-admin-stats', async (_event, data?: { dateFrom?: string; dateTo?: string }) => {
    return fetchAdminStats(data?.dateFrom, data?.dateTo);
  });

  // Fetch action logs with filters (for data table)
  ipcMain.handle('fetch-admin-logs', async (_event, data?: {
    limit?: number; offset?: number; actionType?: string;
    dateFrom?: string; dateTo?: string;
  }) => {
    return fetchActionLogs(
      data?.limit || 200,
      data?.offset || 0,
      data?.actionType,
      data?.dateFrom,
      data?.dateTo,
    );
  });

  // Fetch registered users/machines
  ipcMain.handle('fetch-admin-users', async () => {
    return fetchUsers();
  });

  // Open Admin Dashboard as a separate window
  ipcMain.handle('open-admin-window', async (_event, data?: {
    themePreset?: string; themeMode?: string; themeCustom?: string;
  }) => {
    // If window already open, focus it
    if (ctx.adminWindow && !ctx.adminWindow.isDestroyed()) {
      ctx.adminWindow.focus();
      return { ok: true, msg: 'focused' };
    }

    const htmlPath = path.join(__dirname, '..', '..', '..', 'src', 'renderer', 'admin-dashboard.html');
    const preset = data?.themePreset || 'default';
    const mode = data?.themeMode || 'dark';
    const queryParams = `?themePreset=${encodeURIComponent(preset)}&themeMode=${encodeURIComponent(mode)}${data?.themeCustom ? '&themeCustom=' + encodeURIComponent(data.themeCustom) : ''}`;

    const bgColorMap: Record<string, Record<string, string>> = {
      default:   { dark: '#0d1117', light: '#ffffff' },
      autonsi:   { dark: '#08080c', light: '#fafaff' },
      cyberpunk: { dark: '#05050a', light: '#eef4f8' },
      luxury:    { dark: '#14101a', light: '#faf5f8' },
    };
    const bgColor = bgColorMap[preset]?.[mode] || bgColorMap.default.dark;

    const adminWin = new BrowserWindow({
      width: 1100,
      height: 750,
      minWidth: 800,
      minHeight: 500,
      show: false,
      frame: false,
      titleBarStyle: 'hidden',
      title: 'Admin Dashboard',
      backgroundColor: bgColor,
      opacity: 0, // initially transparent to prevent black flash
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        preload: path.join(__dirname, '..', '..', 'preload', 'index.js'),
      },
    });

    // Show after all resources (CSS, JS, fonts) are fully loaded — prevents black flash
    adminWin.webContents.once('did-finish-load', () => {
      adminWin.show();
      // Restore opacity after DWM catches up
      setTimeout(() => adminWin.setOpacity(1), 50);
    });
    adminWin.loadFile(htmlPath, { search: queryParams });

    ctx.adminWindow = adminWin;

    adminWin.on('closed', () => {
      ctx.adminWindow = null;
    });

    return { ok: true, msg: 'opened' };
  });

  // Generic frontend action tracking
  ipcMain.handle('track-action', async (_event, data: { action: string; meta?: Record<string, any> }) => {
    trackEvent(data.action, data.meta || {}).catch(() => {});
    return { ok: true };
  });
}

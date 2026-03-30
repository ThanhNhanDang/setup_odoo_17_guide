import { ipcMain, shell, dialog, BrowserWindow } from 'electron';
import { IpcContext } from './context';

export function registerWindowHandlers(ctx: IpcContext): void {
  // --- Window Controls (frameless) ---
  ipcMain.handle('window-minimize', () => { ctx.mainWindow.minimize(); });
  ipcMain.handle('window-maximize', () => {
    if (ctx.mainWindow.isMaximized()) ctx.mainWindow.unmaximize();
    else ctx.mainWindow.maximize();
  });
  ipcMain.handle('window-close', () => { ctx.mainWindow.close(); });
  ipcMain.handle('window-is-maximized', () => ctx.mainWindow.isMaximized());

  // --- Pick Folder (dialog) ---
  ipcMain.handle('pick-folder', async () => {
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Addons Folder',
    });
    if (result.canceled || result.filePaths.length === 0) return { path: '' };
    return { path: result.filePaths[0].replace(/\\/g, '/') };
  });

  // --- Open VS Code ---
  // Launch VS Code as non-elevated user via Shell.Application COM object.
  // Without this, VS Code inherits admin elevation from our process,
  // which breaks IME software (e.g. Unikey for Vietnamese input).
  ipcMain.handle('open_vscode', async (_event, data: Record<string, string>) => {
    const targetPath = data?.path;
    if (!targetPath) return { ok: false, msg: 'No path provided' };
    try {
      const { findVSCode } = require('../services/detection');
      const vscodePath = findVSCode();
      if (!vscodePath) return { ok: false, msg: 'VS Code not found' };

      const { exec } = require('child_process');
      // Shell.Application.ShellExecute launches via Explorer's token (non-elevated)
      const psScript = `(New-Object -ComObject Shell.Application).ShellExecute('${vscodePath}', '"${targetPath}"', '', 'open', 1)`;
      const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
      exec(`powershell -NoProfile -WindowStyle Hidden -EncodedCommand ${encoded}`, { windowsHide: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  });

  // --- Open Browser ---
  ipcMain.handle('open_browser', async (_event, data: Record<string, string>) => {
    const url = data?.url;
    if (!url) return { ok: false, msg: 'No URL provided' };
    if (!/^https?:\/\//.test(url)) return { ok: false, msg: 'Invalid URL scheme' };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  });

  // --- Open Explorer ---
  ipcMain.handle('open_explorer', async (_event, data: Record<string, string>) => {
    const targetPath = data?.path;
    if (!targetPath) return { ok: false, msg: 'No path provided' };
    try {
      await shell.openPath(targetPath);
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  });

  // --- Pick a file (for restore DB etc.) ---
  ipcMain.handle('pick-file', async (event, data: { title?: string; filters?: { name: string; extensions: string[] }[] }) => {
    const parentWin = BrowserWindow.fromWebContents(event.sender) || ctx.mainWindow;
    const result = await dialog.showOpenDialog(parentWin, {
      properties: ['openFile'],
      title: data?.title || 'Select File',
      filters: data?.filters || [],
    });
    if (result.canceled || result.filePaths.length === 0) return { path: '' };
    return { path: result.filePaths[0] };
  });
}

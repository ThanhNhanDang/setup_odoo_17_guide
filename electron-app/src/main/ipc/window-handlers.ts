import { ipcMain, shell, dialog, BrowserWindow } from 'electron';
import { execFile, execFileSync } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
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

  // --- Open IDE (VS Code or Antigravity) ---
  // Launch the IDE as non-elevated user via Shell.Application COM object.
  // Without this, the IDE inherits admin elevation from our process,
  // which breaks IME software (e.g. Unikey for Vietnamese input).
  ipcMain.handle('open_vscode', async (_event, data: Record<string, string>) => {
    const targetPath = data?.path;
    const ide = (data?.ide || 'vscode').toLowerCase();
    if (!targetPath) return { ok: false, msg: 'No path provided' };
    try {
      const detection = require('../services/detection');

      let idePath: string | null = null;
      let cliName = 'code';
      let exeBaseName = 'Code.exe';
      let ideLabel = 'VS Code';

      if (ide === 'antigravity') {
        idePath = detection.findAntigravity();
        cliName = 'antigravity';
        exeBaseName = 'Antigravity.exe';
        ideLabel = 'Antigravity';
      } else {
        idePath = detection.findVSCode();
      }

      if (!idePath) {
        // Fallback: if preferred IDE not found, try the other one
        if (ide === 'antigravity') {
          idePath = detection.findVSCode();
          if (idePath) { cliName = 'code'; exeBaseName = 'Code.exe'; ideLabel = 'VS Code'; }
        } else {
          idePath = detection.findAntigravity();
          if (idePath) { cliName = 'antigravity'; exeBaseName = 'Antigravity.exe'; ideLabel = 'Antigravity'; }
        }
      }
      if (!idePath) return { ok: false, msg: `${ideLabel} not found` };

      // When detection returns a CLI alias (e.g. 'code' or 'antigravity'),
      // resolve it to the actual .exe. Shell.Application needs an executable.
      if (idePath === cliName) {
        try {
          const where = execFileSync('cmd.exe', ['/c', `where ${cliName}`], {
            timeout: 5000, windowsHide: true, encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          const lines = where.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
          const exeLine = lines.find(l => l.toLowerCase().endsWith(exeBaseName.toLowerCase()));
          if (exeLine && existsSync(exeLine)) {
            idePath = exeLine;
          } else {
            const first = lines[0];
            if (first) {
              const resolved = join(dirname(first), '..', exeBaseName);
              if (existsSync(resolved)) idePath = resolved;
            }
          }
        } catch { /* keep CLI alias as fallback */ }
      }

      // Use a temp VBScript + wscript //B (completely silent, no console).
      // Shell.Application.ShellExecute launches through Explorer's non-elevated token.
      const vbsPath = join(tmpdir(), `open_ide_${Date.now()}.vbs`);
      const vbsLines = [
        'Set objShell = CreateObject("Shell.Application")',
        `objShell.ShellExecute "${idePath}", """${targetPath}""", "", "open", 1`,
      ];
      const vbsContent = vbsLines.join('\r\n') + '\r\n';
      writeFileSync(vbsPath, vbsContent, 'utf-8');
      execFile('wscript.exe', ['//B', '//Nologo', vbsPath], { windowsHide: true }, () => {
        try { unlinkSync(vbsPath); } catch (_) { /* ignore */ }
      });
      return { ok: true, ide: ideLabel };
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

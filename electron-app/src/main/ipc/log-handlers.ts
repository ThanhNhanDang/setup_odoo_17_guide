import { ipcMain, BrowserWindow, app } from 'electron';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { runCmd, runCmdStreaming } from '../utils/shell';
import { IpcContext, LogWatcherEntry } from './context';
import { DEFAULT_ODOO_VERSION } from '../services/odoo-versions';
import { getDefaultBaseDir, getDefaultProjectsDir } from '../services/config';
import { invalidateStatusCache } from '../services/status';
import { ensurePgAndStartOdoo } from './project-handlers';

// Module-level color index for log viewer windows
let logColorIndex = 0;

export function registerLogHandlers(ctx: IpcContext): void {

  // =========================================================================
  // Watch project log file (realtime tail)
  // Primary: PowerShell Get-Content -Wait (reliable on Windows, like tail -f)
  // Fallback: stat-based polling if PowerShell fails
  // Supports multiple windows watching the same log file
  // =========================================================================

  function broadcastLogLines(logPath: string, lines: string[]): void {
    const entry = ctx.logWatchers.get(logPath);
    if (!entry) return;
    const payload = { logPath, lines };
    for (const win of entry.subscribers) {
      if (!win.isDestroyed()) {
        win.webContents.send('project-log', payload);
      }
    }
    // Also always send to main window (for detail modal)
    if (!ctx.mainWindow.isDestroyed() && !entry.subscribers.has(ctx.mainWindow)) {
      ctx.mainWindow.webContents.send('project-log', payload);
    }
  }

  /** Fallback: stat-based polling when PowerShell is unavailable */
  function startPollFallback(logPath: string, entry: LogWatcherEntry): void {
    if (entry.pollTimer) return; // already polling
    let reading = false;
    entry.pollTimer = setInterval(() => {
      if (reading) return;
      try {
        const newSize = fs.statSync(logPath).size;
        if (newSize === entry.lastSize) return;
        reading = true;
        const readStart = newSize < entry.lastSize ? 0 : entry.lastSize;
        const readLen = newSize - readStart;
        const buf = Buffer.alloc(readLen);
        const fd = fs.openSync(logPath, 'r');
        fs.readSync(fd, buf, 0, readLen, readStart);
        fs.closeSync(fd);
        entry.lastSize = newSize;
        const newLines = buf.toString('utf8').split('\n').filter(Boolean);
        if (newLines.length > 0) broadcastLogLines(logPath, newLines);
      } catch { /* ignore */ } finally {
        reading = false;
      }
    }, 300);
  }

  ipcMain.handle('watch-log', async (event, data: { logPath: string }) => {
    const logPath = data?.logPath;
    if (!logPath || !fs.existsSync(logPath)) return { ok: false, lines: [] };
    if (!logPath.endsWith('.log')) return { ok: false, lines: [] };

    // Read last ~64KB of the file (streaming tail, not entire file)
    const TAIL_BYTES = 64 * 1024;
    const fileSize = fs.statSync(logPath).size;
    const startPos = Math.max(0, fileSize - TAIL_BYTES);
    const tailBuf = Buffer.alloc(Math.min(TAIL_BYTES, fileSize));
    const fd = fs.openSync(logPath, 'r');
    fs.readSync(fd, tailBuf, 0, tailBuf.length, startPos);
    fs.closeSync(fd);
    const tailText = tailBuf.toString('utf8');
    const allLines = tailText.split('\n');
    // If we started mid-line (startPos > 0), drop the first partial line
    const last1000 = (startPos > 0 ? allLines.slice(1) : allLines).slice(-1000);

    const callerWindow = BrowserWindow.fromWebContents(event.sender) || ctx.mainWindow;

    // If watcher already exists, just add subscriber
    if (ctx.logWatchers.has(logPath)) {
      ctx.logWatchers.get(logPath)!.subscribers.add(callerWindow);
      return { ok: true, lines: last1000 };
    }

    // Create new watcher
    const subscribers = new Set<BrowserWindow>([callerWindow]);
    const entry: LogWatcherEntry = { tailProc: null, pollTimer: null, lastSize: fs.statSync(logPath).size, subscribers };

    // Primary: PowerShell Get-Content -Wait (like tail -f, reliable on Windows)
    try {
      const proc = spawn('powershell', [
        '-NoProfile', '-NoLogo', '-Command',
        `Get-Content -Path '${logPath.replace(/'/g, "''")}' -Wait -Tail 0 -Encoding UTF8`,
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });

      let buffer = '';
      proc.stdout!.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const parts = buffer.split('\n');
        buffer = parts.pop() || ''; // keep incomplete last line in buffer
        const lines = parts.filter(Boolean);
        if (lines.length > 0) broadcastLogLines(logPath, lines);
      });

      proc.on('error', () => {
        // PowerShell failed — start poll fallback
        entry.tailProc = null;
        startPollFallback(logPath, entry);
      });
      proc.on('exit', () => {
        // Process ended (e.g. file deleted) — start poll fallback if still watching
        if (ctx.logWatchers.has(logPath) && !entry.pollTimer) {
          entry.tailProc = null;
          startPollFallback(logPath, entry);
        }
      });
      entry.tailProc = proc;
    } catch {
      // PowerShell not available — use poll fallback
      startPollFallback(logPath, entry);
    }

    ctx.logWatchers.set(logPath, entry);
    return { ok: true, lines: last1000 };
  });

  ipcMain.handle('unwatch-log', async (event, data: { logPath: string }) => {
    const logPath = data?.logPath;
    if (!logPath || !ctx.logWatchers.has(logPath)) return { ok: true };
    const entry = ctx.logWatchers.get(logPath)!;
    const callerWindow = BrowserWindow.fromWebContents(event.sender);
    if (callerWindow) entry.subscribers.delete(callerWindow);
    // Close watcher only when no more subscribers
    if (entry.subscribers.size === 0) {
      if (entry.tailProc) { try { entry.tailProc.kill(); } catch {} }
      if (entry.pollTimer) clearInterval(entry.pollTimer);
      ctx.logWatchers.delete(logPath);
    }
    return { ok: true };
  });

  // =========================================================================
  // Separate Log Viewer Windows
  // =========================================================================

  const LOG_WINDOW_COLORS = [
    '#f0883e', '#7c3aed', '#00e5ff', '#c77dba', '#3fb950',
    '#58a6ff', '#d29922', '#f85149', '#56d364', '#bc8cff',
  ];

  ipcMain.handle('open-log-window', async (_event, data: {
    projectName: string; logPath: string;
    odooVersion?: string; baseDir?: string; projectsDir?: string;
    httpPort?: string; domain?: string; odooSourceDir?: string;
    themePreset?: string; themeMode?: string; themeCustom?: string;
  }) => {
    const { projectName, logPath } = data;
    const windowKey = projectName;

    // If window already open for this project, focus it
    if (ctx.logWindows.has(windowKey)) {
      const existing = ctx.logWindows.get(windowKey)!;
      if (!existing.isDestroyed()) {
        existing.focus();
        return { ok: true, msg: 'focused' };
      }
      ctx.logWindows.delete(windowKey);
    }

    // Pick next color
    const color = LOG_WINDOW_COLORS[logColorIndex % LOG_WINDOW_COLORS.length];
    logColorIndex++;

    const logViewerPath = path.join(__dirname, '..', '..', '..', 'src', 'renderer', 'log-viewer.html');
    const extraParams = [
      data.odooVersion ? `&odooVersion=${encodeURIComponent(data.odooVersion)}` : '',
      data.baseDir ? `&baseDir=${encodeURIComponent(data.baseDir)}` : '',
      data.projectsDir ? `&projectsDir=${encodeURIComponent(data.projectsDir)}` : '',
      data.httpPort ? `&httpPort=${encodeURIComponent(data.httpPort)}` : '',
      data.domain ? `&domain=${encodeURIComponent(data.domain)}` : '',
      data.odooSourceDir ? `&odooSourceDir=${encodeURIComponent(data.odooSourceDir)}` : '',
      data.themePreset ? `&themePreset=${encodeURIComponent(data.themePreset)}` : '',
      data.themeMode ? `&themeMode=${encodeURIComponent(data.themeMode)}` : '',
      data.themeCustom ? `&themeCustom=${encodeURIComponent(data.themeCustom)}` : '',
    ].join('');
    const queryParams = `?project=${encodeURIComponent(projectName)}&logPath=${encodeURIComponent(logPath)}&color=${encodeURIComponent(color)}${extraParams}`;

    // Resolve background color from theme to prevent flash on open/resize
    const bgColorMap: Record<string, Record<string, string>> = {
      default:   { dark: '#0d1117', light: '#ffffff' },
      autonsi:   { dark: '#08080c', light: '#fafaff' },
      cyberpunk: { dark: '#05050a', light: '#eef4f8' },
      luxury:    { dark: '#14101a', light: '#faf5f8' },
    };
    const preset = data.themePreset || 'default';
    const mode = data.themeMode || 'dark';
    const bgColor = bgColorMap[preset]?.[mode] || bgColorMap.default.dark;

    const logWin = new BrowserWindow({
      width: 800,
      height: 500,
      minWidth: 500,
      minHeight: 300,
      show: false,
      frame: false,
      titleBarStyle: 'hidden',
      title: `${projectName} — Monitor`,
      backgroundColor: bgColor,
      alwaysOnTop: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        preload: path.join(__dirname, '..', '..', 'preload', 'index.js'),
      },
    });

    logWin.once('ready-to-show', () => logWin.show());
    logWin.loadFile(logViewerPath, { search: queryParams });

    ctx.logWindows.set(windowKey, logWin);

    logWin.on('closed', () => {
      ctx.logWindows.delete(windowKey);
      // Cleanup: remove this window from all log watcher subscribers
      for (const [watchPath, entry] of ctx.logWatchers) {
        entry.subscribers.delete(logWin);
        if (entry.subscribers.size === 0) {
          if (entry.tailProc) { try { entry.tailProc.kill(); } catch {} }
          if (entry.pollTimer) clearInterval(entry.pollTimer);
          ctx.logWatchers.delete(watchPath);
        }
      }
    });

    return { ok: true, msg: 'opened', color };
  });

  // Broadcast theme changes to all log/monitor windows
  ipcMain.handle('broadcast-theme', async (_event, data: { preset: string; mode: string; custom: string }) => {
    const bgColorMap: Record<string, Record<string, string>> = {
      default:   { dark: '#0d1117', light: '#ffffff' },
      autonsi:   { dark: '#08080c', light: '#fafaff' },
      cyberpunk: { dark: '#05050a', light: '#eef4f8' },
      luxury:    { dark: '#14101a', light: '#faf5f8' },
    };
    const newBg = bgColorMap[data.preset || 'default']?.[data.mode || 'dark'] || '#0d1117';
    for (const [, win] of ctx.logWindows) {
      if (!win.isDestroyed()) {
        win.setBackgroundColor(newBg);
        win.webContents.send('theme-changed', data);
      }
    }
    return { ok: true };
  });

  // Pin/unpin log window (always on top)
  ipcMain.handle('log-window-pin', async (event, data: { pinned: boolean }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      // Use 'screen-saver' level on Windows to stay above other always-on-top windows
      win.setAlwaysOnTop(data.pinned, 'screen-saver');
    }
    return { ok: true };
  });

  ipcMain.handle('log-window-minimize', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.minimize();
  });

  ipcMain.handle('log-window-maximize', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
  });

  // =========================================================================
  // Log Viewer: server status, project list, info, restart
  // =========================================================================

  // --- Log Viewer: check if Odoo server is running on a given port ---
  ipcMain.handle('log-viewer-server-status', async (_event, data: { httpPort: string }) => {
    const port = data?.httpPort;
    if (!port || !/^\d{1,5}$/.test(port)) return { running: false };
    try {
      const { output } = await runCmd(`netstat -ano | findstr ":${port}.*LISTENING"`);
      return { running: output.trim().length > 0 };
    } catch {
      return { running: false };
    }
  });

  // --- Log Viewer: list all projects (for project switcher dropdown) ---
  ipcMain.handle('log-viewer-projects', async () => {
    try {
      // Read user settings to get current projectsDir
      const settingsFile = path.join(app.getPath('userData'), 'user-settings.json');
      let odooVersion = DEFAULT_ODOO_VERSION;
      if (fs.existsSync(settingsFile)) {
        try {
          const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
          if (raw.odooVersion) odooVersion = raw.odooVersion;
        } catch {}
      }
      const projectsDir = getDefaultProjectsDir(odooVersion);
      if (!fs.existsSync(projectsDir)) return { ok: true, projects: [] };
      const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
      const { parseIniFile: pif, iniGet: ig } = require('../services/ini-parser');
      const projects = entries
        .filter(e => e.isDirectory() && fs.existsSync(path.join(projectsDir, e.name, 'odoo.conf')))
        .map(e => {
          let port = '8069';
          try {
            const ini = pif(path.join(projectsDir, e.name, 'odoo.conf'));
            port = ig(ini, 'options', 'http_port', '8069');
          } catch {}
          return { name: e.name, logPath: path.join(projectsDir, e.name, 'odoo.log'), httpPort: port };
        });
      return { ok: true, projects };
    } catch {
      return { ok: true, projects: [] };
    }
  });

  // --- Log Viewer: get project info (log level + custom modules) ---
  ipcMain.handle('log-viewer-info', async (_event, data: { projectName: string; projectsDir?: string; baseDir?: string; odooVersion?: string }) => {
    try {
      const odooVersion = data.odooVersion || DEFAULT_ODOO_VERSION;
      const projectsDir = data.projectsDir || getDefaultProjectsDir(odooVersion);
      const baseDir = data.baseDir || getDefaultBaseDir(odooVersion);
      const projectPath = path.join(projectsDir, data.projectName);
      const confFile = path.join(projectPath, 'odoo.conf');

      if (!fs.existsSync(confFile)) return { ok: false, msg: 'CONFIG_NOT_FOUND' };

      const { parseIniFile, iniGet } = require('../services/ini-parser');
      const ini = parseIniFile(confFile);
      const logLevel = iniGet(ini, 'options', 'log_level', 'error');
      const addonsPath = iniGet(ini, 'options', 'addons_path', '');

      // Enumerate custom modules (non-base addon dirs)
      const customModules: string[] = [];
      if (addonsPath) {
        for (const rawPath of addonsPath.split(',')) {
          const p = rawPath.trim();
          const absP = path.isAbsolute(p) ? p : path.join(projectPath, p);
          const isBase = p.replace(/\\/g, '/').includes('odoo/addons');
          if (isBase) continue;
          if (fs.existsSync(absP) && fs.statSync(absP).isDirectory()) {
            try {
              for (const entry of fs.readdirSync(absP)) {
                const manifest = path.join(absP, entry, '__manifest__.py');
                if (fs.existsSync(manifest)) customModules.push(entry);
              }
            } catch { /* ignore */ }
          }
        }
      }

      return { ok: true, logLevel, customModules: customModules.sort() };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  });

  // --- Log Viewer: save log level + restart with module upgrade ---
  ipcMain.handle('log-viewer-restart', async (_event, data: {
    projectName: string; projectsDir?: string; baseDir?: string;
    odooVersion?: string; httpPort: string; logLevel?: string;
    upgradeModules?: string[]; odooSourceDir?: string;
  }) => {
    try {
      const odooVersion = data.odooVersion || DEFAULT_ODOO_VERSION;
      const projectsDir = data.projectsDir || getDefaultProjectsDir(odooVersion);
      const baseDir = data.baseDir || getDefaultBaseDir(odooVersion);
      const projectPath = path.join(projectsDir, data.projectName);
      const confFile = path.join(projectPath, 'odoo.conf');

      if (!fs.existsSync(confFile)) return { ok: false, msg: 'CONFIG_NOT_FOUND' };

      // Update log_level + log_handler in odoo.conf if provided
      if (data.logLevel) {
        const { parseIniFile, iniGet } = require('../services/ini-parser');
        const ini = parseIniFile(confFile);
        const currentLevel = iniGet(ini, 'options', 'log_level', 'error');
        if (data.logLevel !== currentLevel) {
          const handlerMap: Record<string, string> = {
            'critical': ':CRITICAL', 'error': ':ERROR', 'warn': ':WARNING', 'warning': ':WARNING',
            'info': ':INFO', 'debug': ':DEBUG', 'debug_rpc': ':DEBUG', 'debug_sql': ':DEBUG',
            'debug_rpc_answer': ':DEBUG',
          };
          const handlerVal = handlerMap[data.logLevel] || ':INFO';
          let raw = fs.readFileSync(confFile, 'utf8');
          if (raw.includes('log_level')) {
            raw = raw.replace(/^log_level\s*=\s*.+$/m, `log_level = ${data.logLevel}`);
          } else {
            raw = raw.replace(/^\[options\]\s*$/m, `[options]\nlog_level = ${data.logLevel}`);
          }
          if (raw.includes('log_handler')) {
            raw = raw.replace(/^log_handler\s*=\s*.+$/m, `log_handler = ${handlerVal}`);
          }
          fs.writeFileSync(confFile, raw, 'utf8');
          ctx.logger.log(`  > Log level changed to: ${data.logLevel} (handler: ${handlerVal})`);
        }
      }

      // Stop Odoo + gevent worker on their ports (if running)
      const port = data.httpPort;
      if (port && /^\d{1,5}$/.test(port)) {
        // Also find gevent port from odoo.conf
        const portsToKill = [port];
        try {
          const { parseIniFile: pif, iniGet: ig } = require('../services/ini-parser');
          const ini2 = pif(confFile);
          const gp = ig(ini2, 'options', 'gevent_port', '');
          if (gp && /^\d{1,5}$/.test(gp)) portsToKill.push(gp);
        } catch { /* ignore */ }

        const pids = new Set<string>();
        for (const p of portsToKill) {
          try {
            const { output } = await runCmd(`netstat -ano | findstr ":${p}.*LISTENING"`);
            for (const line of output.trim().split('\n').filter(Boolean)) {
              const parts = line.trim().split(/\s+/);
              const pid = parts[parts.length - 1];
              if (pid && pid !== '0') pids.add(pid);
            }
          } catch { /* port not listening */ }
        }
        for (const pid of pids) {
          await runCmd(`taskkill /F /PID ${pid}`);
        }
        if (pids.size > 0) {
          ctx.logger.log(`  > Odoo stopped (PID: ${[...pids].join(', ')}) [ports: ${portsToKill.join(', ')}]`);
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }

      // Build start command with optional -u flag
      const odooSourceDir = data.odooSourceDir || 'odoo';
      const venvPy = path.join(baseDir, 'venv', 'Scripts', 'python.exe');
      const odooBin = path.join(baseDir, odooSourceDir, 'odoo-bin');
      const logFile = path.join(projectPath, 'odoo.log').replace(/\\/g, '/');
      let cmd = `"${venvPy}" "${odooBin}" -c "${confFile}" --logfile "${logFile}"`;

      if (data.upgradeModules && data.upgradeModules.length > 0) {
        const safeModName = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
        const safeModules = data.upgradeModules.filter(m => safeModName.test(m));
        if (safeModules.length > 0) {
          cmd += ` -u ${safeModules.join(',')}`;
          ctx.logger.log(`  > Upgrading modules: ${safeModules.join(', ')}`);
        }
      }

      // Use shared function: ensure PG ready + start Odoo
      return await ensurePgAndStartOdoo(ctx, { baseDir, projectPath, confFile, odooSourceDir, cmd });
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  });

  // pick-file handler is in window-handlers.ts (shared across main app + monitor)

  // =========================================================================
  // Cleanup on app quit
  // =========================================================================
  app.on('before-quit', () => {
    // Close all log file watchers + poll timers
    for (const [, entry] of ctx.logWatchers) {
      if (entry.tailProc) { try { entry.tailProc.kill(); } catch {} }
      if (entry.pollTimer) clearInterval(entry.pollTimer);
    }
    ctx.logWatchers.clear();
    // Close all log viewer windows
    for (const [, win] of ctx.logWindows) {
      if (!win.isDestroyed()) win.destroy();
    }
    ctx.logWindows.clear();
  });
}

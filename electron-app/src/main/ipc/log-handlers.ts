import { ipcMain, BrowserWindow, app } from 'electron';
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
  // Native stat-based polling at 250ms — no PowerShell, no stdout buffering.
  // Reads only the new bytes (lastSize → newSize) each tick.
  // Supports multiple windows watching the same log file.
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

  /** Fast file-size polling. Opens an FD each tick to get the accurate
   *  size via fstat — fs.statSync goes through the directory entry which
   *  on NTFS can lag behind for actively-written files. */
  function startPolling(logPath: string, entry: LogWatcherEntry): void {
    if (entry.pollTimer) return;
    let reading = false;
    let tailBuffer = ''; // carry incomplete last line between ticks
    entry.pollTimer = setInterval(() => {
      if (reading) return;
      reading = true;
      let fd: number | null = null;
      try {
        fd = fs.openSync(logPath, 'r');
        const newSize = fs.fstatSync(fd).size;
        if (newSize === entry.lastSize) { fs.closeSync(fd); fd = null; return; }
        const readStart = newSize < entry.lastSize ? 0 : entry.lastSize;
        const readLen = newSize - readStart;
        const buf = Buffer.alloc(readLen);
        fs.readSync(fd, buf, 0, readLen, readStart);
        fs.closeSync(fd); fd = null;
        entry.lastSize = newSize;
        tailBuffer += buf.toString('utf8');
        const parts = tailBuffer.split('\n');
        tailBuffer = parts.pop() || ''; // keep incomplete last line
        const newLines = parts.map(s => s.replace(/\r$/, '')).filter(Boolean);
        if (newLines.length > 0) broadcastLogLines(logPath, newLines);
      } catch {
        if (fd !== null) { try { fs.closeSync(fd); } catch {} }
      } finally {
        reading = false;
      }
    }, 250);
  }

  ipcMain.handle('watch-log', async (event, data: { logPath: string }) => {
    const logPath = data?.logPath;
    if (!logPath || !fs.existsSync(logPath)) return { ok: false, lines: [] };
    if (!logPath.endsWith('.log')) return { ok: false, lines: [] };

    // Read last ~64KB of the file (streaming tail, not entire file)
    const TAIL_BYTES = 64 * 1024;
    const fdInit = fs.openSync(logPath, 'r');
    const fileSize = fs.fstatSync(fdInit).size;
    const startPos = Math.max(0, fileSize - TAIL_BYTES);
    const tailBuf = Buffer.alloc(Math.min(TAIL_BYTES, fileSize));
    fs.readSync(fdInit, tailBuf, 0, tailBuf.length, startPos);
    fs.closeSync(fdInit);
    const tailText = tailBuf.toString('utf8');
    const allLines = tailText.split('\n');
    // If we started mid-line (startPos > 0), drop the first partial line
    const last1000 = (startPos > 0 ? allLines.slice(1) : allLines)
      .map(s => s.replace(/\r$/, ''))
      .slice(-1000);

    const callerWindow = BrowserWindow.fromWebContents(event.sender) || ctx.mainWindow;

    // If watcher already exists, just add subscriber
    if (ctx.logWatchers.has(logPath)) {
      ctx.logWatchers.get(logPath)!.subscribers.add(callerWindow);
      return { ok: true, lines: last1000 };
    }

    // Create new watcher (poll from current end-of-file)
    const subscribers = new Set<BrowserWindow>([callerWindow]);
    const entry: LogWatcherEntry = { tailProc: null, pollTimer: null, lastSize: fileSize, subscribers };
    startPolling(logPath, entry);
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
      opacity: 0,
      alwaysOnTop: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        preload: path.join(__dirname, '..', '..', 'preload', 'index.js'),
      },
    });

    // Show after all resources (CSS, JS, fonts) are fully loaded — prevents black flash
    logWin.webContents.once('did-finish-load', () => {
      logWin.show();
      setTimeout(() => logWin.setOpacity(1), 50);
    });
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
    // Also broadcast to admin dashboard window
    if (ctx.adminWindow && !ctx.adminWindow.isDestroyed()) {
      ctx.adminWindow.setBackgroundColor(newBg);
      ctx.adminWindow.webContents.send('theme-changed', data);
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

  // Compact mode: shrink to small square widget, pin on top
  ipcMain.handle('log-window-compact', async (event, data: { compact: boolean }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false };
    if (data.compact) {
      const bounds = win.getBounds();
      win.webContents.send('compact-saved-bounds', bounds);
      // Start with modules panel expanded (default)
      win.setResizable(true);
      win.setMinimumSize(340, 200);
      win.setSize(340, 380);
      win.setAlwaysOnTop(true, 'screen-saver');
    } else {
      win.setMinimumSize(500, 300);
      win.setResizable(true);
      win.setAlwaysOnTop(false);
    }
    return { ok: true };
  });

  // Compact mode: expand/shrink for modules panel
  ipcMain.handle('log-window-compact-expand', async (event, data: { expanded: boolean }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false };
    const [w] = win.getSize();
    if (data.expanded) {
      win.setResizable(true);
      win.setMinimumSize(340, 200);
      win.setSize(w, 380);
    } else {
      win.setResizable(false);
      win.setMinimumSize(340, 130);
      win.setSize(w, 130);
    }
    return { ok: true };
  });

  // Restore window bounds after leaving compact mode
  ipcMain.handle('log-window-restore-bounds', async (event, data: { x: number; y: number; width: number; height: number }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.setBounds(data);
    return { ok: true };
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

      // Lightweight DB name list (no pg_database_size — that's what makes monitor-list-databases slow)
      let dbNames: string[] = [];
      try {
        const { parseIniFile: pif, iniGet: ig } = require('../services/ini-parser');
        const ini2 = pif(confFile);
        const dbHost = ig(ini2, 'options', 'db_host', 'localhost');
        const dbPort = ig(ini2, 'options', 'db_port', '5432');
        const dbUser = ig(ini2, 'options', 'db_user', 'odoo');
        const dbPassword = ig(ini2, 'options', 'db_password', 'odoo');
        const dbfilter = ig(ini2, 'options', 'dbfilter', '');

        const { findPostgresBin } = require('../services/detection');
        const pgBin = findPostgresBin();
        if (pgBin) {
          const psql = path.join(pgBin, 'psql.exe');
          const { output } = await runCmd(
            `"${psql}" -h ${dbHost} -p ${dbPort} -U ${dbUser} -d postgres -tAc "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname"`,
            undefined, { ...process.env, PGPASSWORD: dbPassword }
          );
          const allNames = output.trim().split('\n').map(s => s.trim()).filter(Boolean);
          // Filter by dbfilter (if set), always exclude 'postgres'
          const filtered = dbfilter
            ? (() => { try { const re = new RegExp(dbfilter.replace(/(?<!\[)-(?!_\])/g, '[-_]')); return allNames.filter(n => n !== 'postgres' && re.test(n)); } catch { return allNames.filter(n => n !== 'postgres'); } })()
            : allNames.filter(n => n !== 'postgres');
          dbNames = filtered;
        }
      } catch { /* DB list is best-effort */ }

      return { ok: true, logLevel, customModules: customModules.sort(), dbNames };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  });

  // --- Log Viewer: save log level + restart with module upgrade ---
  ipcMain.handle('log-viewer-restart', async (_event, data: {
    projectName: string; projectsDir?: string; baseDir?: string;
    odooVersion?: string; httpPort: string; logLevel?: string;
    upgradeModules?: string[]; upgradeDb?: string; odooSourceDir?: string;
    autoDetectUpgrade?: boolean;
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

      // Stop Odoo + gevent worker on their ports, then wait for ports to be free.
      const port = data.httpPort;
      if (port && /^\d{1,5}$/.test(port)) {
        const portsToKill = [port];
        try {
          const { parseIniFile: pif, iniGet: ig } = require('../services/ini-parser');
          const ini2 = pif(confFile);
          const gp = ig(ini2, 'options', 'gevent_port', '');
          if (gp && /^\d{1,5}$/.test(gp)) portsToKill.push(gp);
        } catch { /* ignore */ }

        const collectPids = async (): Promise<Set<string>> => {
          const found = new Set<string>();
          for (const p of portsToKill) {
            try {
              const { output } = await runCmd(`netstat -ano | findstr ":${p}.*LISTENING"`);
              for (const line of output.trim().split('\n').filter(Boolean)) {
                const parts = line.trim().split(/\s+/);
                const pid = parts[parts.length - 1];
                if (pid && pid !== '0') found.add(pid);
              }
            } catch { /* port not listening */ }
          }
          return found;
        };

        // Kill + children (taskkill /T to sweep worker sub-processes)
        const pids = await collectPids();
        for (const pid of pids) {
          await runCmd(`taskkill /F /T /PID ${pid}`);
        }
        if (pids.size > 0) {
          ctx.logger.log(`  > Odoo stopped (PID: ${[...pids].join(', ')}) [ports: ${portsToKill.join(', ')}]`);
        }
        // Poll until all target ports are free (max ~10s) to avoid bind races on Odoo 19 with workers > 0.
        for (let attempt = 0; attempt < 20; attempt++) {
          await new Promise(r => setTimeout(r, 500));
          const still = await collectPids();
          if (still.size === 0) break;
          for (const pid of still) { await runCmd(`taskkill /F /T /PID ${pid}`); }
          if (attempt === 19) ctx.logger.log(`  > Warning: ports still in use after wait: ${[...still].join(', ')}`);
        }
      }

      // Build start command with optional -u flag
      const odooSourceDir = data.odooSourceDir || 'odoo';
      const venvPy = path.join(baseDir, 'venv', 'Scripts', 'python.exe');
      const odooBin = path.join(baseDir, odooSourceDir, 'odoo-bin');
      const logFile = path.join(projectPath, 'odoo.log').replace(/\\/g, '/');
      let cmd = `"${venvPy}" "${odooBin}" -c "${confFile}" --logfile "${logFile}"`;

      // Auto-detect modules whose source files changed since last restart.
      // Skipped when autoDetectUpgrade is explicitly false.
      const autoDetected = new Set<string>();
      const stampFile = path.join(projectPath, '.odoo-last-restart');
      const autoDetectEnabled = data.autoDetectUpgrade !== false;
      let lastRestartMs = 0;
      try {
        lastRestartMs = parseInt(fs.readFileSync(stampFile, 'utf8').trim(), 10) || 0;
      } catch { /* first run or no stamp */ }

      if (autoDetectEnabled && lastRestartMs > 0) {
        try {
          const { parseIniFile: pif, iniGet: ig } = require('../services/ini-parser');
          const iniC = pif(confFile);
          const addonsPath = ig(iniC, 'options', 'addons_path', '');
          const hasRecentFile = (dir: string, after: number, depth = 0): boolean => {
            if (depth > 6) return false; // safety cap
            try {
              for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.name === '__pycache__' || entry.name === '.git' || entry.name === 'node_modules') continue;
                const full = path.join(dir, entry.name);
                try {
                  const st = fs.statSync(full);
                  if (st.isDirectory()) {
                    if (hasRecentFile(full, after, depth + 1)) return true;
                  } else if (st.mtimeMs > after) {
                    return true;
                  }
                } catch { /* unreadable */ }
              }
            } catch { /* unreadable dir */ }
            return false;
          };
          for (const rawPath of (addonsPath || '').split(',')) {
            const p = rawPath.trim();
            if (!p) continue;
            const absP = path.isAbsolute(p) ? p : path.join(projectPath, p);
            if (p.replace(/\\/g, '/').includes('odoo/addons')) continue; // skip base
            if (!fs.existsSync(absP)) continue;
            for (const entry of fs.readdirSync(absP)) {
              const modDir = path.join(absP, entry);
              const manifest = path.join(modDir, '__manifest__.py');
              if (!fs.existsSync(manifest)) continue;
              if (hasRecentFile(modDir, lastRestartMs)) autoDetected.add(entry);
            }
          }
        } catch (e) {
          ctx.logger.log(`  > Auto-detect modified modules failed: ${e}`);
        }
      }

      const manualModules = Array.isArray(data.upgradeModules) ? data.upgradeModules : [];
      const mergedModules = Array.from(new Set<string>([...manualModules, ...autoDetected]));
      if (mergedModules.length > 0) {
        const safeModName = /^[a-zA-Z_][a-zA-Z0-9_\-]*$/;
        const safeModules = mergedModules.filter(m => safeModName.test(m));
        const safeDbName = /^[a-zA-Z0-9_][a-zA-Z0-9_\-]*$/;
        const rawDb = (data.upgradeDb || '').trim();
        const isAllDbs = rawDb === '*';
        const upgradeDb = (!isAllDbs && rawDb && safeDbName.test(rawDb)) ? rawDb : '';

        if (safeModules.length === 0) {
          // Modules filtered out by safety regex — skip upgrade silently.
        } else if (isAllDbs) {
          // ── Multi-DB upgrade: iterate ALL DBs matching dbfilter, sequentially.
          // Each: `odoo-bin -d <db> -u <mods> --stop-after-init --no-http` (blocking).
          // After all done, fall through to normal start (cmd has no -u).
          const { parseIniFile: pif, iniGet: ig } = require('../services/ini-parser');
          const iniC = pif(confFile);
          const dbHost = ig(iniC, 'options', 'db_host', 'localhost');
          const dbPort2 = ig(iniC, 'options', 'db_port', '5432');
          const dbUser = ig(iniC, 'options', 'db_user', 'odoo');
          const dbPasswd = ig(iniC, 'options', 'db_password', 'odoo');
          const dbfilterRaw = ig(iniC, 'options', 'dbfilter', '');

          const { findPostgresBin } = require('../services/detection');
          const pgBin = findPostgresBin();
          if (!pgBin) {
            ctx.logger.log(`  > Error: PostgreSQL bin not found — cannot list DBs for upgrade-all`);
            return { ok: false, msg: 'PG_NOT_FOUND' };
          }
          const psql = path.join(pgBin, 'psql.exe');
          const psqlEnv = { ...process.env, PGPASSWORD: dbPasswd };

          const { output: listOut, code: listCode } = await runCmd(
            `"${psql}" -h ${dbHost} -p ${dbPort2} -U ${dbUser} -d postgres -tAc "SELECT datname FROM pg_database WHERE datistemplate=false AND datname<>'postgres'"`,
            undefined, psqlEnv,
          );
          if (listCode !== 0) {
            ctx.logger.log(`  > Error: failed listing DBs: ${listOut.trim()}`);
            return { ok: false, msg: 'DB_LIST_FAILED' };
          }
          let allDbs = listOut.split('\n').map(s => s.trim()).filter(Boolean);
          if (dbfilterRaw) {
            try {
              const normalized = dbfilterRaw.replace(/(?<!\[)-(?!_\])/g, '[-_]');
              const re = new RegExp(normalized);
              allDbs = allDbs.filter(n => re.test(n));
            } catch { /* invalid regex — use all */ }
          }
          // Filter safe names + dedupe
          allDbs = allDbs.filter(n => safeDbName.test(n));

          if (allDbs.length === 0) {
            ctx.logger.log(`  > No DBs matched dbfilter '${dbfilterRaw}' — nothing to upgrade`);
          } else {
            ctx.logger.log(`==================================================`);
            ctx.logger.log(`Upgrading ${safeModules.length} module(s) on ${allDbs.length} DB(s)`);
            ctx.logger.log(`Modules: ${safeModules.join(', ')}`);
            ctx.logger.log(`DBs: ${allDbs.join(', ')}`);
            ctx.logger.log(`==================================================`);

            const odooEnvU = { ...process.env };
            if (pgBin && !odooEnvU.PATH?.includes(pgBin)) {
              odooEnvU.PATH = `${pgBin};${odooEnvU.PATH || ''}`;
            }

            let failedCount = 0;
            for (let i = 0; i < allDbs.length; i++) {
              const db = allDbs[i];
              ctx.logger.log(``);
              ctx.logger.log(`[${i + 1}/${allDbs.length}] Upgrading '${db}'...`);
              // Push progress event so renderer can show "Upgrading 2/3 t4tek_sti_test..."
              ctx.mainWindow.webContents.send('upgrade-all-progress', {
                projectName: data.projectName, current: i + 1, total: allDbs.length, dbName: db,
              });
              const upCmd = `"${venvPy}" "${odooBin}" -c "${confFile}" -d "${db}" -u ${safeModules.join(',')} --stop-after-init --no-http`;
              const exitCode = await runCmdStreaming(upCmd, ctx.logger, { cwd: projectPath, env: odooEnvU });
              if (exitCode !== 0) {
                failedCount++;
                ctx.logger.log(`[${i + 1}/${allDbs.length}] FAILED '${db}' (exit ${exitCode}) — continuing...`);
              } else {
                ctx.logger.log(`[${i + 1}/${allDbs.length}] OK '${db}'`);
              }
            }
            ctx.logger.log(``);
            ctx.logger.log(`==================================================`);
            ctx.logger.log(`Upgrade-all done. Success: ${allDbs.length - failedCount}/${allDbs.length}. Starting Odoo...`);
            ctx.logger.log(`==================================================`);
            ctx.mainWindow.webContents.send('upgrade-all-progress', {
              projectName: data.projectName, current: allDbs.length, total: allDbs.length, dbName: '', done: true, failed: failedCount,
            });
          }
          // cmd already built without -u → fall through to normal start
        } else if (upgradeDb) {
          // Single-DB upgrade (original behavior): integrate -u into start command
          cmd += ` -d "${upgradeDb}" -u ${safeModules.join(',')}`;
          const src = autoDetected.size > 0
            ? ` (auto-detected since ${new Date(lastRestartMs).toISOString()}: ${[...autoDetected].join(', ')}${manualModules.length ? ' | manual: ' + manualModules.join(', ') : ''})`
            : '';
          ctx.logger.log(`  > Upgrading modules on DB '${upgradeDb}': ${safeModules.join(', ')}${src}`);
          ctx.logger.log(`  > Restart command: ${cmd}`);
        } else if (!rawDb) {
          ctx.logger.log(`  > Error: modules selected but no target database specified — aborting restart`);
          return { ok: false, msg: 'NO_UPGRADE_DB' };
        } else {
          ctx.logger.log(`  > Error: target database '${rawDb}' contains unsupported characters — aborting restart`);
          return { ok: false, msg: 'INVALID_UPGRADE_DB' };
        }
      }

      // Stamp current time so the next restart can diff from here.
      try { fs.writeFileSync(stampFile, String(Date.now()), 'utf8'); } catch { /* best effort */ }

      // Use shared function: ensure PG ready + start Odoo
      return await ensurePgAndStartOdoo(ctx, { baseDir, projectPath, confFile, odooSourceDir, cmd, odooVersion });
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

import { ipcMain, BrowserWindow, app, dialog } from 'electron';
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

export function registerMonitorHandlers(ctx: IpcContext): void {

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
    httpPort?: string; odooSourceDir?: string;
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

    const logViewerPath = path.join(__dirname, '..', '..', 'src', 'renderer', 'log-viewer.html');
    const extraParams = [
      data.odooVersion ? `&odooVersion=${encodeURIComponent(data.odooVersion)}` : '',
      data.baseDir ? `&baseDir=${encodeURIComponent(data.baseDir)}` : '',
      data.projectsDir ? `&projectsDir=${encodeURIComponent(data.projectsDir)}` : '',
      data.httpPort ? `&httpPort=${encodeURIComponent(data.httpPort)}` : '',
      data.odooSourceDir ? `&odooSourceDir=${encodeURIComponent(data.odooSourceDir)}` : '',
      data.themePreset ? `&themePreset=${encodeURIComponent(data.themePreset)}` : '',
      data.themeMode ? `&themeMode=${encodeURIComponent(data.themeMode)}` : '',
      data.themeCustom ? `&themeCustom=${encodeURIComponent(data.themeCustom)}` : '',
    ].join('');
    const queryParams = `?project=${encodeURIComponent(projectName)}&logPath=${encodeURIComponent(logPath)}&color=${encodeURIComponent(color)}${extraParams}`;

    const logWin = new BrowserWindow({
      width: 800,
      height: 500,
      minWidth: 500,
      minHeight: 300,
      show: false,              // Don't show until content is painted
      frame: false,
      title: `${projectName} — Monitor`,
      backgroundColor: '#0d1117',
      alwaysOnTop: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: path.join(__dirname, '..', 'preload', 'index.js'),
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
    for (const [, win] of ctx.logWindows) {
      if (!win.isDestroyed()) {
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

      // Stop Odoo on the port (if running)
      const port = data.httpPort;
      if (port && /^\d{1,5}$/.test(port)) {
        const { output } = await runCmd(`netstat -ano | findstr ":${port}.*LISTENING"`);
        const lines = output.trim().split('\n').filter(Boolean);
        const pids = new Set<string>();
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && pid !== '0') pids.add(pid);
        }
        for (const pid of pids) {
          await runCmd(`taskkill /F /PID ${pid}`);
        }
        if (pids.size > 0) {
          ctx.logger.log(`  > Odoo stopped (PID: ${[...pids].join(', ')})`);
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

  // =========================================================================
  // Project Monitor: Database Tab
  // =========================================================================

  /** Read DB connection config + admin_passwd + data_dir from project's odoo.conf */
  function readDbConfig(projectName: string, projectsDir: string) {
    if (!projectName || !/^[a-z_][a-z0-9_\-]*$/.test(projectName)) return null;
    const confFile = path.join(projectsDir, projectName, 'odoo.conf');
    if (!fs.existsSync(confFile)) return null;
    const { parseIniFile, iniGet } = require('../services/ini-parser');
    const ini = parseIniFile(confFile);
    return {
      host: iniGet(ini, 'options', 'db_host', 'localhost'),
      port: iniGet(ini, 'options', 'db_port', '5432'),
      user: iniGet(ini, 'options', 'db_user', 'odoo'),
      password: iniGet(ini, 'options', 'db_password', 'odoo'),
      adminPasswd: iniGet(ini, 'options', 'admin_passwd', 'odoo'),
      dataDir: iniGet(ini, 'options', 'data_dir', ''),
      confFile,
    };
  }

  /** Find psql bin dir, return { pgBin, env } or null */
  function getPgTools(dbPassword: string) {
    const { findPostgresBin } = require('../services/detection');
    const pgBin = findPostgresBin();
    if (!pgBin) return null;
    return { pgBin, env: { ...process.env, PGPASSWORD: dbPassword } as NodeJS.ProcessEnv };
  }

  /** Check prerequisites: PG running, venv exists, odoo-bin exists */
  function checkPrerequisites(baseDir: string, odooSourceDir: string, dbPort: string): { ok: boolean; msg?: string } {
    const venvPy = path.join(baseDir, 'venv', 'Scripts', 'python.exe');
    if (!fs.existsSync(venvPy)) return { ok: false, msg: 'VENV_NOT_FOUND' };
    const odooBin = path.join(baseDir, odooSourceDir, 'odoo-bin');
    if (!fs.existsSync(odooBin)) return { ok: false, msg: 'ODOO_NOT_FOUND' };
    // PG readiness is checked at runtime by the handlers
    return { ok: true };
  }

  /** Send progress event to all log windows for a project */
  function emitDbProgress(projectName: string, channel: string, data: Record<string, unknown>) {
    const win = ctx.logWindows.get(projectName);
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
    // Auto-persist on status transitions (not every streaming detail line)
    if (data.status === 'done' || data.status === 'error' || data.status === 'interrupted') {
      persistJobs();
    }
  }

  // --- DB Job tracking (persists across Monitor close/reopen AND app restart) ---
  interface DbJob {
    type: 'create' | 'restore' | 'drop';
    dbName: string;
    projectName: string;
    status: 'running' | 'done' | 'error' | 'interrupted';
    step: string;
    startTime: number;
    output: string[];
    error?: string;
  }
  const dbJobs = new Map<string, DbJob>();
  const DB_JOBS_FILE = path.join(app.getPath('userData'), 'db-jobs.json');

  function getJobKey(projectName: string, type: string, dbName?: string) {
    // Use dbName in key to allow multiple concurrent drops
    return type === 'drop' ? `${projectName}:drop:${dbName}` : `${projectName}:${type}`;
  }

  // Persist jobs to disk (only status transitions, not every output line)
  let _persistTimer: ReturnType<typeof setTimeout> | null = null;
  function persistJobs() {
    if (_persistTimer) return; // debounce 500ms
    _persistTimer = setTimeout(() => {
      _persistTimer = null;
      try {
        const data: Record<string, Omit<DbJob, 'output'>> = {};
        for (const [key, job] of dbJobs) {
          // Don't persist output array (too large), only metadata
          const { output, ...rest } = job;
          data[key] = rest;
        }
        fs.writeFileSync(DB_JOBS_FILE, JSON.stringify(data, null, 2), 'utf8');
      } catch { /* ignore write errors */ }
    }, 500);
  }

  // Load persisted jobs on startup — mark running jobs as interrupted
  try {
    if (fs.existsSync(DB_JOBS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DB_JOBS_FILE, 'utf8'));
      for (const [key, job] of Object.entries(raw) as [string, DbJob][]) {
        if (job.status === 'running') {
          job.status = 'interrupted';
          job.error = 'APP_RESTARTED';
          job.step = 'interrupted';
        }
        job.output = [];
        dbJobs.set(key, job);
      }
      persistJobs();
    }
  } catch { /* ignore read errors */ }

  // Cleanup completed/error jobs after 5 minutes
  function scheduleJobCleanup(key: string) {
    setTimeout(() => {
      dbJobs.delete(key);
      persistJobs();
    }, 5 * 60 * 1000);
  }

  ipcMain.handle('monitor-list-databases', async (_event, data: { projectName: string; projectsDir?: string; odooVersion?: string }) => {
    try {
      const odooVersion = data.odooVersion || DEFAULT_ODOO_VERSION;
      const projectsDir = data.projectsDir || getDefaultProjectsDir(odooVersion);
      const dbConf = readDbConfig(data.projectName, projectsDir);
      if (!dbConf) return { ok: false, msg: 'CONFIG_NOT_FOUND' };

      const connInfo = { host: dbConf.host, port: dbConf.port, user: dbConf.user, adminPasswd: dbConf.adminPasswd };
      const pg = getPgTools(dbConf.password);
      if (!pg) return { ok: false, msg: 'PG_NOT_FOUND', connInfo };

      const psql = path.join(pg.pgBin, 'psql.exe');
      const query = `SELECT d.datname, pg_size_pretty(pg_database_size(d.datname)) as size, r.rolname as owner, d.encoding, pg_encoding_to_char(d.encoding) as enc_name FROM pg_database d JOIN pg_roles r ON d.datdba = r.oid WHERE d.datistemplate = false ORDER BY d.datname`;
      const { output } = await runCmd(
        `"${psql}" -h ${dbConf.host} -p ${dbConf.port} -U ${dbConf.user} -d postgres -tAF "|" -c "${query.replace(/"/g, '\\"')}"`,
        undefined, pg.env
      );

      const databases = output.trim().split('\n').filter(Boolean).map(line => {
        const parts = line.split('|');
        return {
          name: (parts[0] || '').trim(),
          size: (parts[1] || '').trim(),
          owner: (parts[2] || '').trim(),
          encoding: (parts[4] || parts[3] || '').trim(),
        };
      }).filter(db => db.name);

      return { ok: true, databases, connInfo };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  });

  ipcMain.handle('monitor-create-database', async (_event, data: {
    projectName: string; dbName: string; demoData?: boolean;
    adminEmail?: string; adminPassword?: string; adminPhone?: string;
    lang?: string; country?: string;
    projectsDir?: string; baseDir?: string; odooVersion?: string; odooSourceDir?: string;
  }) => {
    const dbName = data.dbName;
    if (!dbName || !/^[a-zA-Z_][a-zA-Z0-9_\-]*$/.test(dbName)) return { ok: false, msg: 'INVALID_DB_NAME' };

    const odooVersion = data.odooVersion || DEFAULT_ODOO_VERSION;
    const projectsDir = data.projectsDir || getDefaultProjectsDir(odooVersion);
    const baseDir = data.baseDir || getDefaultBaseDir(odooVersion);
    const odooSourceDir = data.odooSourceDir || 'odoo';
    const dbConf = readDbConfig(data.projectName, projectsDir);
    if (!dbConf) return { ok: false, msg: 'CONFIG_NOT_FOUND' };

    // Check prerequisites
    const prereq = checkPrerequisites(baseDir, odooSourceDir, dbConf.port);
    if (!prereq.ok) return { ok: false, msg: prereq.msg };

    const pg = getPgTools(dbConf.password);
    if (!pg) return { ok: false, msg: 'PG_NOT_FOUND' };

    // Start async job — return immediately
    const jobKey = getJobKey(data.projectName, 'create');
    const job: DbJob = {
      type: 'create', dbName, projectName: data.projectName,
      status: 'running', step: 'creating_db', startTime: Date.now(), output: [],
    };
    dbJobs.set(jobKey, job); persistJobs();

    const emit = (step: string, progress: number, detail?: string) => {
      job.step = step;
      emitDbProgress(data.projectName, 'db-job-progress', {
        type: 'create', dbName, step, detail, status: 'running',
        elapsed: Date.now() - job.startTime, progress,
      });
    };

    // Run in background
    (async () => {
      try {
        // Step 1: Create empty DB
        emit('creating_db', 10);
        const createdb = path.join(pg.pgBin, 'createdb.exe');
        const { code: createCode, output: createOut } = await runCmd(
          `"${createdb}" -h ${dbConf.host} -p ${dbConf.port} -U ${dbConf.user} -E UTF8 "${dbName}"`,
          undefined, pg.env
        );
        if (createCode !== 0 && createOut.includes('already exists')) {
          job.status = 'error'; job.error = 'DB_EXISTS';
          emitDbProgress(data.projectName, 'db-job-progress', { type: 'create', dbName, step: 'error', status: 'error', error: 'DB_EXISTS' });
          scheduleJobCleanup(jobKey);
          return;
        }

        // Step 2: Init Odoo schema with odoo-bin
        emit('init_schema', 30);
        const venvPy = path.join(baseDir, 'venv', 'Scripts', 'python.exe');
        const odooBin = path.join(baseDir, odooSourceDir, 'odoo-bin');
        const projectPath = path.join(projectsDir, data.projectName);

        // Inject PG bin into PATH
        const odooEnv: NodeJS.ProcessEnv = { ...pg.env };
        if (!odooEnv.PATH?.includes(pg.pgBin)) {
          odooEnv.PATH = `${pg.pgBin};${odooEnv.PATH || ''}`;
        }

        const lang = data.lang || 'en_US';
        let initCmd = `"${venvPy}" "${odooBin}" -d "${dbName}" -c "${dbConf.confFile}" -i base --stop-after-init -l ${lang}`;
        if (!data.demoData) initCmd += ' --without-demo=all';

        const exitCode = await runCmdStreaming(initCmd, ctx.logger, {
          cwd: projectPath,
          env: odooEnv,
          onData: (line) => {
            job.output.push(line);
            if (job.output.length > 200) job.output.shift();
            emit('init_schema', 30, line);
          },
        });

        if (exitCode !== 0) {
          // Check for common errors in output
          const fullOut = job.output.join('\n');
          let errorMsg = 'INIT_FAILED';
          if (fullOut.includes('Module') && fullOut.includes('not found')) errorMsg = 'MISSING_ADDON';
          job.status = 'error'; job.error = errorMsg;
          emitDbProgress(data.projectName, 'db-job-progress', {
            type: 'create', dbName, step: 'error', status: 'error', error: errorMsg,
            detail: job.output.slice(-5).join('\n'),
          });
          scheduleJobCleanup(jobKey);
          return;
        }

        // Step 3: Configure admin user (email/password/phone/country) via SQL
        emit('configuring_admin', 90);
        const adminEmail = data.adminEmail || 'admin';
        const adminPassword = data.adminPassword || 'admin';
        const psqlExe = path.join(pg.pgBin, 'psql.exe');
        // Update admin login (res_users id=2 is the first real user created by Odoo)
        const safeEmail = adminEmail.replace(/'/g, "''");
        const safePassword = adminPassword.replace(/'/g, "''");
        await runCmd(
          `"${psqlExe}" -h ${dbConf.host} -p ${dbConf.port} -U ${dbConf.user} -d "${dbName}" -c "UPDATE res_users SET login='${safeEmail}' WHERE id=2"`,
          undefined, pg.env
        ).catch(() => {});

        // Set password via odoo-bin (hashed properly)
        await runCmdStreaming(
          `"${venvPy}" "${odooBin}" shell -d "${dbName}" -c "${dbConf.confFile}" --no-http -c "${dbConf.confFile}" <<< "env['res.users'].browse(2).write({'password': '${safePassword}'}); env.cr.commit()"`,
          ctx.logger, { cwd: projectPath, env: odooEnv }
        ).catch(() => {
          // Fallback: just log, password might need manual set
          ctx.logger.log('  > Note: Could not set admin password via shell. Default password may apply.');
        });

        // Set phone if provided
        if (data.adminPhone) {
          const safePhone = data.adminPhone.replace(/'/g, "''");
          await runCmd(
            `"${psqlExe}" -h ${dbConf.host} -p ${dbConf.port} -U ${dbConf.user} -d "${dbName}" -c "UPDATE res_partner SET phone='${safePhone}' WHERE id=(SELECT partner_id FROM res_users WHERE id=2)"`,
            undefined, pg.env
          ).catch(() => {});
        }

        // Set country if provided (country code like 'vn', 'us', etc.)
        if (data.country && /^[a-z]{2}$/i.test(data.country)) {
          const cc = data.country.toLowerCase();
          await runCmd(
            `"${psqlExe}" -h ${dbConf.host} -p ${dbConf.port} -U ${dbConf.user} -d "${dbName}" -c "UPDATE res_company SET country_id=(SELECT id FROM res_country WHERE code ILIKE '${cc}' LIMIT 1) WHERE id=1"`,
            undefined, pg.env
          ).catch(() => {});
        }

        // Done
        job.status = 'done'; job.step = 'done';
        ctx.logger.log(`[monitor] Database created + initialized: ${dbName} (admin: ${adminEmail})`);
        emitDbProgress(data.projectName, 'db-job-progress', {
          type: 'create', dbName, step: 'done', status: 'done',
          elapsed: Date.now() - job.startTime, progress: 100,
        });
        scheduleJobCleanup(jobKey);
      } catch (e) {
        job.status = 'error'; job.error = String(e);
        emitDbProgress(data.projectName, 'db-job-progress', {
          type: 'create', dbName, step: 'error', status: 'error', error: String(e), progress: 0,
        });
        scheduleJobCleanup(jobKey);
      }
    })();

    return { ok: true, msg: 'STARTED' };
  });

  ipcMain.handle('monitor-drop-database', async (_event, data: { projectName: string; dbName: string; projectsDir?: string; odooVersion?: string }) => {
    const dbName = data.dbName;
    if (!dbName || !/^[a-zA-Z_][a-zA-Z0-9_\-]*$/.test(dbName)) return { ok: false, msg: 'INVALID_DB_NAME' };

    // Protect system databases
    const protectedDbs = ['postgres', 'template0', 'template1'];
    if (protectedDbs.includes(dbName.toLowerCase())) return { ok: false, msg: 'PROTECTED_DB' };

    const odooVersion = data.odooVersion || DEFAULT_ODOO_VERSION;
    const projectsDir = data.projectsDir || getDefaultProjectsDir(odooVersion);
    const dbConf = readDbConfig(data.projectName, projectsDir);
    if (!dbConf) return { ok: false, msg: 'CONFIG_NOT_FOUND' };

    let pgSuperPassword = 'postgres';
    const sFile = path.join(app.getPath('userData'), 'user-settings.json');
    try {
      if (fs.existsSync(sFile)) {
        const raw = JSON.parse(fs.readFileSync(sFile, 'utf8'));
        if (raw.pgSuperPassword) pgSuperPassword = raw.pgSuperPassword;
      }
    } catch {}

    const pg = getPgTools(pgSuperPassword);
    if (!pg) return { ok: false, msg: 'PG_NOT_FOUND' };

    // Start async job — return immediately
    const jobKey = getJobKey(data.projectName, 'drop', dbName);
    const job: DbJob = {
      type: 'drop', dbName, projectName: data.projectName,
      status: 'running', step: 'terminating_connections', startTime: Date.now(), output: [],
    };
    dbJobs.set(jobKey, job); persistJobs();

    (async () => {
      try {
        // Step 1: Terminate connections
        emitDbProgress(data.projectName, 'db-job-progress', {
          type: 'drop', dbName, step: 'terminating_connections', status: 'running',
          elapsed: 0, progress: 30,
        });
        const psql = path.join(pg.pgBin, 'psql.exe');
        await runCmd(
          `"${psql}" -h ${dbConf.host} -p ${dbConf.port} -U postgres -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${dbName}' AND pid <> pg_backend_pid()"`,
          undefined, pg.env
        ).catch(() => {});

        // Step 2: Drop database
        job.step = 'dropping_db';
        emitDbProgress(data.projectName, 'db-job-progress', {
          type: 'drop', dbName, step: 'dropping_db', status: 'running',
          elapsed: Date.now() - job.startTime, progress: 70,
        });
        const dropdb = path.join(pg.pgBin, 'dropdb.exe');
        const { code, output } = await runCmd(
          `"${dropdb}" -h ${dbConf.host} -p ${dbConf.port} -U postgres "${dbName}"`,
          undefined, pg.env
        );

        if (code !== 0) {
          job.status = 'error'; job.error = 'DROP_FAILED'; job.step = 'error';
          emitDbProgress(data.projectName, 'db-job-progress', {
            type: 'drop', dbName, step: 'error', status: 'error', error: 'DROP_FAILED',
            detail: output,
          });
          scheduleJobCleanup(jobKey);
          return;
        }

        // Done
        job.status = 'done'; job.step = 'done';
        ctx.logger.log(`[monitor] Database dropped: ${dbName}`);
        emitDbProgress(data.projectName, 'db-job-progress', {
          type: 'drop', dbName, step: 'done', status: 'done',
          elapsed: Date.now() - job.startTime, progress: 100,
        });
        scheduleJobCleanup(jobKey);
      } catch (e) {
        job.status = 'error'; job.error = String(e); job.step = 'error';
        emitDbProgress(data.projectName, 'db-job-progress', {
          type: 'drop', dbName, step: 'error', status: 'error', error: String(e),
        });
        scheduleJobCleanup(jobKey);
      }
    })();

    return { ok: true, msg: 'STARTED' };
  });

  ipcMain.handle('monitor-restore-database', async (_event, data: {
    projectName: string; dbName: string; filePath: string;
    projectsDir?: string; baseDir?: string; odooVersion?: string; odooSourceDir?: string;
  }) => {
    const dbName = data.dbName;
    const filePath = data.filePath;
    if (!dbName || !/^[a-zA-Z_][a-zA-Z0-9_\-]*$/.test(dbName)) return { ok: false, msg: 'INVALID_DB_NAME' };
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, msg: 'FILE_NOT_FOUND' };

    const resolvedFile = path.resolve(filePath);
    if (!fs.statSync(resolvedFile).isFile()) return { ok: false, msg: 'FILE_NOT_FOUND' };

    const odooVersion = data.odooVersion || DEFAULT_ODOO_VERSION;
    const projectsDir = data.projectsDir || getDefaultProjectsDir(odooVersion);
    const baseDir = data.baseDir || getDefaultBaseDir(odooVersion);
    const dbConf = readDbConfig(data.projectName, projectsDir);
    if (!dbConf) return { ok: false, msg: 'CONFIG_NOT_FOUND' };

    const pg = getPgTools(dbConf.password);
    if (!pg) return { ok: false, msg: 'PG_NOT_FOUND' };

    const ext = path.extname(filePath).toLowerCase();

    // Start async job
    const jobKey = getJobKey(data.projectName, 'restore');
    const job: DbJob = {
      type: 'restore', dbName, projectName: data.projectName,
      status: 'running', step: 'preparing', startTime: Date.now(), output: [],
    };
    dbJobs.set(jobKey, job);

    const emit = (step: string, progress: number, detail?: string) => {
      job.step = step;
      emitDbProgress(data.projectName, 'db-job-progress', {
        type: 'restore', dbName, step, detail, status: 'running',
        elapsed: Date.now() - job.startTime, progress,
        objectCount: job.output.length,
      });
    };

    (async () => {
      try {
        let dumpFile = resolvedFile;
        let tempDir = '';
        let hasFilestore = false;

        // Step 1: Extract .zip if needed
        if (ext === '.zip') {
          emit('extracting', 10);
          tempDir = path.join(app.getPath('temp'), `odoo-restore-${Date.now()}`);
          fs.mkdirSync(tempDir, { recursive: true });
          await runCmd(`powershell -NoProfile -Command "Expand-Archive -Path '${resolvedFile}' -DestinationPath '${tempDir}' -Force"`);

          // Find dump file inside zip
          const dumpSql = path.join(tempDir, 'dump.sql');
          const dumpBin = path.join(tempDir, 'dump.dump');
          if (fs.existsSync(dumpBin)) dumpFile = dumpBin;
          else if (fs.existsSync(dumpSql)) dumpFile = dumpSql;
          else {
            // Search recursively for dump file
            const files = fs.readdirSync(tempDir);
            const found = files.find(f => f.endsWith('.dump') || f.endsWith('.sql'));
            if (found) dumpFile = path.join(tempDir, found);
            else {
              job.status = 'error'; job.error = 'NO_DUMP_IN_ZIP';
              emitDbProgress(data.projectName, 'db-job-progress', { type: 'restore', dbName, step: 'error', status: 'error', error: 'NO_DUMP_IN_ZIP' });
              scheduleJobCleanup(jobKey);
              try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
              return;
            }
          }
          hasFilestore = fs.existsSync(path.join(tempDir, 'filestore'));
        }

        // Step 2: Create empty DB
        emit('creating_db', 20);
        const createdb = path.join(pg.pgBin, 'createdb.exe');
        const { code: cCode, output: cOut } = await runCmd(
          `"${createdb}" -h ${dbConf.host} -p ${dbConf.port} -U ${dbConf.user} -E UTF8 "${dbName}"`,
          undefined, pg.env
        );
        if (cCode !== 0 && cOut.includes('already exists')) {
          job.status = 'error'; job.error = 'DB_EXISTS';
          emitDbProgress(data.projectName, 'db-job-progress', { type: 'restore', dbName, step: 'error', status: 'error', error: 'DB_EXISTS' });
          scheduleJobCleanup(jobKey);
          if (tempDir) try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
          return;
        }

        // Step 3: Restore dump with streaming
        emit('restoring_data', 30);
        const dumpExt = path.extname(dumpFile).toLowerCase();
        const pgEnv: NodeJS.ProcessEnv = { ...pg.env };
        if (!pgEnv.PATH?.includes(pg.pgBin)) pgEnv.PATH = `${pg.pgBin};${pgEnv.PATH || ''}`;

        let restoreCmd: string;
        if (dumpExt === '.dump') {
          const pgRestore = path.join(pg.pgBin, 'pg_restore.exe');
          restoreCmd = `"${pgRestore}" -h ${dbConf.host} -p ${dbConf.port} -U ${dbConf.user} -d "${dbName}" --no-owner --no-privileges --verbose "${dumpFile}"`;
        } else {
          const psql = path.join(pg.pgBin, 'psql.exe');
          restoreCmd = `"${psql}" -h ${dbConf.host} -p ${dbConf.port} -U ${dbConf.user} -d "${dbName}" -f "${dumpFile}"`;
        }

        const exitCode = await runCmdStreaming(restoreCmd, ctx.logger, {
          env: pgEnv,
          onData: (line) => {
            job.output.push(line);
            if (job.output.length > 200) job.output.shift();
            // Emit progress every 10 objects to avoid flooding
            if (job.output.length % 10 === 0) emit('restoring_data', 30, line);
          },
        });

        if (exitCode !== 0 && dumpExt !== '.dump') {
          // psql may return non-zero but data is still restored; pg_restore --verbose also returns warnings
          const lastLines = job.output.slice(-10).join('\n');
          if (lastLines.includes('FATAL') || lastLines.includes('does not exist')) {
            job.status = 'error'; job.error = 'RESTORE_FAILED';
            emitDbProgress(data.projectName, 'db-job-progress', {
              type: 'restore', dbName, step: 'error', status: 'error', error: 'RESTORE_FAILED',
              detail: job.output.slice(-5).join('\n'),
            });
            scheduleJobCleanup(jobKey);
            if (tempDir) try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
            return;
          }
        }

        // Step 4: Copy filestore if .zip had one
        if (hasFilestore && tempDir) {
          emit('copying_filestore', 85);
          const dataDir = dbConf.dataDir || path.join(projectsDir, data.projectName, 'data');
          const destFilestore = path.join(dataDir, 'filestore', dbName);
          const srcFilestore = path.join(tempDir, 'filestore');

          if (!fs.existsSync(path.dirname(destFilestore))) {
            fs.mkdirSync(path.dirname(destFilestore), { recursive: true });
          }
          // Use robocopy for large filestore (faster than Node.js copy)
          await runCmd(`robocopy "${srcFilestore}" "${destFilestore}" /E /NFL /NDL /NJH /NJS /NC /NS`).catch(() => {});
        }

        // Cleanup temp dir
        if (tempDir) {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
        }

        // Done
        job.status = 'done'; job.step = 'done';
        ctx.logger.log(`[monitor] Database restored: ${dbName} from ${path.basename(filePath)} (${job.output.length} objects)`);
        emitDbProgress(data.projectName, 'db-job-progress', {
          type: 'restore', dbName, step: 'done', status: 'done',
          elapsed: Date.now() - job.startTime, objectCount: job.output.length, progress: 100,
        });
        scheduleJobCleanup(jobKey);
      } catch (e) {
        job.status = 'error'; job.error = String(e);
        emitDbProgress(data.projectName, 'db-job-progress', {
          type: 'restore', dbName, step: 'error', status: 'error', error: String(e), progress: 0,
        });
        scheduleJobCleanup(jobKey);
      }
    })();

    return { ok: true, msg: 'STARTED' };
  });

  // --- DB Job status (for reconnecting after Monitor close/reopen) ---
  ipcMain.handle('monitor-db-job-status', async (_event, data: { projectName: string }) => {
    const jobs: DbJob[] = [];
    for (const [, job] of dbJobs) {
      if (job.projectName === data.projectName) jobs.push(job);
    }
    return { ok: true, jobs };
  });

  // --- Dismiss a completed/error/interrupted DB job ---
  ipcMain.handle('monitor-dismiss-db-job', async (_event, data: { projectName: string; type: string; dbName?: string }) => {
    const key = getJobKey(data.projectName, data.type, data.dbName);
    dbJobs.delete(key);
    persistJobs();
    return { ok: true };
  });

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

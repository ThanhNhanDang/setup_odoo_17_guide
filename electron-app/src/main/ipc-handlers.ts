import { ipcMain, BrowserWindow, shell, dialog, app } from 'electron';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { runCmd, runCmdStreaming } from './utils/shell';
import { LoggerService } from './services/logger';
import { StepLockManager } from './services/step-lock';
import { DEFAULT_BASE_DIR, DEFAULT_PROJECTS_DIR, getDefaultBaseDir, getDefaultProjectsDir, getTemplatesDir } from './services/config';
import { DEFAULT_ODOO_VERSION, ALL_VERSIONS, ODOO_VERSIONS, getEffectiveVersionConfig } from './services/odoo-versions';
import { detectStatus, invalidateStatusCache } from './services/status';
import {
  stepInstallNginx,
  stepInstallGit,
  stepInstallVSCode,
  stepInstallPython,
  stepInstallPostgres,
  stepCloneOdoo,
  stepCreateVenv,
  stepInstallRequirements,
  stepCreateProject,
  stepFullInstall,
} from './services/installer';
import {
  readProjectConfig,
  saveProjectConfig,
  deleteProject,
  duplicateProject,
} from './services/projects';

// ---------------------------------------------------------------------------
// IPC Handler Registration
// Replaces Python HTTP API (InstallerHandler.do_POST)
// ---------------------------------------------------------------------------

/** Wrap IPC handler with error catching */
function safe<T>(fn: () => Promise<T>): Promise<T | { ok: false; msg: string }> {
  return fn().catch((e: Error) => ({ ok: false as const, msg: `Error: ${e.message}` }));
}

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

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  const logger = new LoggerService(mainWindow);
  const stepLock = new StepLockManager();

  // --- App Info ---
  ipcMain.handle('app-version', () => {
    const { app } = require('electron');
    return app.getVersion();
  });

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
          // Also send defaults so UI can show "reset" hint
          defaultPythonUrl: ODOO_VERSIONS[v].pythonUrl,
          defaultPostgresUrl: ODOO_VERSIONS[v].postgresUrl,
        };
      }),
      default: DEFAULT_ODOO_VERSION,
    };
  });

  // --- Window Controls (frameless) ---
  ipcMain.handle('window-minimize', () => { mainWindow.minimize(); });
  ipcMain.handle('window-maximize', () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('window-close', () => { mainWindow.close(); });
  ipcMain.handle('window-is-maximized', () => mainWindow.isMaximized());

  // --- Status ---
  ipcMain.handle('status', async (_event, data: Record<string, string>) => {
    const baseDir = data?.base_dir || DEFAULT_BASE_DIR;
    const projectsDir = data?.projects_dir || DEFAULT_PROJECTS_DIR;
    const odooSourceDir = data?.odoo_source_dir || 'odoo';
    return safe(() => detectStatus(baseDir, projectsDir, odooSourceDir));
  });

  // --- Log ---
  ipcMain.handle('log', async () => {
    return {
      lines: logger.getLines(),
      task: logger.getTask(),
    };
  });

  // --- Full Install ---
  ipcMain.handle('full_install', async (_event, data: Record<string, string>) => {
    if (logger.getTask().status === 'running') {
      return { ok: false, msg: 'Install already in progress' };
    }
    const odooVersion = data?.odoo_version || DEFAULT_ODOO_VERSION;
    const baseDir = data?.base_dir || getDefaultBaseDir(odooVersion);
    const projectsDir = data?.projects_dir || getDefaultProjectsDir(odooVersion);
    const projectName = data?.project_name || 'my_project';
    const opts: Record<string, string> = {};
    for (const [k, v] of Object.entries(data || {})) {
      if (!['base_dir', 'projects_dir', 'project_name', 'odoo_version'].includes(k)) {
        opts[k] = v;
      }
    }

    // Set running status synchronously to prevent race condition on double-click
    logger.updateTask({ status: 'running', step: 'Starting...', progress: 0 });

    // Run in background (non-blocking)
    stepFullInstall(baseDir, projectsDir, projectName, logger, opts, stepLock, odooVersion, readUrlOverrides())
      .then(results => {
        invalidateStatusCache();
        logger.updateTask({ status: 'done', step: 'Complete!', progress: 100, results });
      })
      .catch(e => {
        logger.updateTask({ status: 'error', step: String(e), progress: 0 });
        logger.log(`[ERROR] Full install failed: ${e}`);
      });

    return { ok: true, msg: 'Install started in background. Check log for progress.' };
  });

  // --- Run Step ---
  ipcMain.handle('run_step', async (_event, data: Record<string, string>) => {
    const step = data?.step || '';
    const odooVersion = data?.odoo_version || DEFAULT_ODOO_VERSION;
    const baseDir = data?.base_dir || getDefaultBaseDir(odooVersion);

    const stepFns: Record<string, () => Promise<{ ok: boolean; msg: string }>> = {
      install_nginx: () => stepInstallNginx(baseDir, logger),
      install_git: () => stepInstallGit(baseDir, logger),
      install_vscode: () => stepInstallVSCode(baseDir, logger),
      install_python: () => stepInstallPython(baseDir, logger, odooVersion, readUrlOverrides()),
      install_postgres: () => stepInstallPostgres(
        baseDir, logger,
        data?.pg_super_password || 'postgres',
        data?.db_port || '5432',
        data?.db_user || 'odoo',
        data?.db_password || 'odoo',
        data?.pg_mode || 'auto',
        odooVersion,
        readUrlOverrides(),
      ),
      clone_odoo: () => stepCloneOdoo(baseDir, logger, odooVersion),
      create_venv: () => stepCreateVenv(baseDir, logger, odooVersion),
      install_requirements: () => stepInstallRequirements(baseDir, logger, odooVersion),
    };

    const fn = stepFns[step];
    if (!fn) {
      return { ok: false, msg: `Unknown step: ${step}` };
    }
    if (stepLock.isLocked(step)) {
      return { ok: false, msg: 'Step already running' };
    }
    const promise = fn();
    stepLock.acquire(step, 'run_step', promise);
    try {
      const result = await promise;
      invalidateStatusCache();
      return result;
    } finally {
      stepLock.release(step);
    }
  });

  // --- Create Project ---
  ipcMain.handle('create_project', async (_event, data: Record<string, string>) => {
    const odooVersion = data?.odoo_version || DEFAULT_ODOO_VERSION;
    const baseDir = data?.base_dir || getDefaultBaseDir(odooVersion);
    const projectsDir = data?.projects_dir || getDefaultProjectsDir(odooVersion);
    const projectName = data?.project_name || '';
    const opts: Record<string, string> = {};
    for (const [k, v] of Object.entries(data || {})) {
      if (!['base_dir', 'projects_dir', 'project_name', 'odoo_version'].includes(k)) {
        opts[k] = v;
      }
    }
    const onProgress = (step: string, done: boolean) => {
      mainWindow.webContents.send('create-progress', { step, done });
    };
    const result = await stepCreateProject(baseDir, projectsDir, projectName, logger, opts, odooVersion, onProgress);
    invalidateStatusCache();
    return result;
  });

  // --- Read Config ---
  ipcMain.handle('read_config', async (_event, data: Record<string, string>) => {
    const projectsDir = data?.projects_dir || DEFAULT_PROJECTS_DIR;
    const projectName = data?.project_name || '';
    return readProjectConfig(projectsDir, projectName);
  });

  // --- Save Config ---
  ipcMain.handle('save_config', async (_event, data: Record<string, string>) => {
    const projectsDir = data?.projects_dir || DEFAULT_PROJECTS_DIR;
    const projectName = data?.project_name || '';
    const content = data?.content || '';
    return saveProjectConfig(projectsDir, projectName, content);
  });

  // --- Delete Project ---
  ipcMain.handle('delete_project', async (_event, data: Record<string, string>) => {
    const projectsDir = data?.projects_dir || DEFAULT_PROJECTS_DIR;
    const projectName = data?.project_name || '';
    const dropDatabases = data?.drop_databases === 'true';

    // Close any log watchers for this project's files before deleting
    const projPath = path.join(projectsDir, projectName);
    for (const [logPath, entry] of logWatchers) {
      if (logPath.startsWith(projPath)) {
        if (entry.tailProc) { try { entry.tailProc.kill(); } catch {} }
        if (entry.pollTimer) clearInterval(entry.pollTimer);
        logWatchers.delete(logPath);
      }
    }
    // Close log viewer window for this project
    if (logWindows.has(projectName)) {
      const win = logWindows.get(projectName)!;
      if (!win.isDestroyed()) win.destroy();
      logWindows.delete(projectName);
    }

    const onProgress = (step: string, done: boolean) => {
      mainWindow.webContents.send('delete-progress', { step, done });
    };
    const result = await deleteProject(projectsDir, projectName, dropDatabases, onProgress);
    invalidateStatusCache();
    return result;
  });

  // --- Reset Templates ---
  ipcMain.handle('reset_templates', async (_event, data: Record<string, string>) => {
    const odooVersion = data?.odoo_version || DEFAULT_ODOO_VERSION;
    const baseDir = data?.base_dir || getDefaultBaseDir(odooVersion);
    const projectsDir = data?.projects_dir || getDefaultProjectsDir(odooVersion);
    const projectName = data?.project_name || '';
    const proj = path.join(projectsDir, projectName);

    if (!fs.existsSync(proj)) {
      return { ok: false, msg: 'Project not found' };
    }

    try {
      const templatesDir = getTemplatesDir();
      const venvPython = path.join(baseDir, 'venv', 'Scripts', 'python.exe').replace(/\\/g, '\\\\');
      const odooSourceDir2 = data?.odoo_source_dir || 'odoo';
      const odooBin = path.join(baseDir, odooSourceDir2, 'odoo-bin').replace(/\\/g, '\\\\');

      // Reset launch.json
      const vscodePath = path.join(proj, '.vscode');
      fs.mkdirSync(vscodePath, { recursive: true });
      let launchContent = fs.readFileSync(path.join(templatesDir, 'launch.json'), 'utf8');
      launchContent = launchContent.replace(/\{python_path\}/g, venvPython);
      launchContent = launchContent.replace(/\{odoo_bin_path\}/g, odooBin);
      fs.writeFileSync(path.join(vscodePath, 'launch.json'), launchContent, 'utf8');

      // Reset settings.json
      const settingsTemplate = path.join(templatesDir, 'settings.json');
      if (fs.existsSync(settingsTemplate)) {
        let settingsContent = fs.readFileSync(settingsTemplate, 'utf8');
        settingsContent = settingsContent.replace(/\{python_path\}/g, venvPython);
        fs.writeFileSync(path.join(vscodePath, 'settings.json'), settingsContent, 'utf8');
      }

      // Fix logfile in odoo.conf (set to False so VS Code F5 shows logs in terminal)
      const confPath = path.join(proj, 'odoo.conf');
      if (fs.existsSync(confPath)) {
        let confContent = fs.readFileSync(confPath, 'utf8');
        confContent = confContent.replace(/^logfile\s*=\s*.+$/m, 'logfile = False');
        fs.writeFileSync(confPath, confContent, 'utf8');
      }

      logger.log(`Templates reset for project '${projectName}'.`);
      return { ok: true, msg: 'Templates reset' };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  });

  // --- Duplicate Project ---
  ipcMain.handle('duplicate_project', async (_event, data: Record<string, string>) => {
    const baseDir = data?.base_dir || DEFAULT_BASE_DIR;
    const projectsDir = data?.projects_dir || DEFAULT_PROJECTS_DIR;
    const projectName = data?.project_name || '';
    const newName = data?.new_name || '';
    const newHttpPort = data?.new_http_port || '8070';
    const onProgress = (step: string, done: boolean) => {
      mainWindow.webContents.send('duplicate-progress', { step, done });
    };
    const result = await duplicateProject(baseDir, projectsDir, projectName, newName, newHttpPort, onProgress);
    invalidateStatusCache();
    return result;
  });

  // --- Shared: Ensure PostgreSQL ready + start Odoo process ---
  async function ensurePgAndStartOdoo(opts: {
    baseDir: string; projectPath: string; confFile: string;
    odooSourceDir: string; cmd: string;
  }): Promise<{ ok: boolean; msg: string }> {
    const { baseDir, projectPath, confFile, odooSourceDir, cmd } = opts;

    // Read project's DB config
    let projectDbPort = '5434';
    let projectDbUser = 'odoo';
    let projectDbPassword = 'odoo';
    try {
      const { parseIniFile, iniGet } = require('./services/ini-parser');
      const ini = parseIniFile(confFile);
      projectDbPort = iniGet(ini, 'options', 'db_port', '5434');
      projectDbUser = iniGet(ini, 'options', 'db_user', 'odoo');
      projectDbPassword = iniGet(ini, 'options', 'db_password', 'odoo');
    } catch { /* use defaults */ }

    logger.log(`  > Project DB config: port=${projectDbPort}, user=${projectDbUser}`);

    // Find PostgreSQL instance for this port
    const { findPostgresForPort, findPostgresBin, findDockerPostgres } = require('./services/detection');
    const pgInstance = findPostgresForPort(projectDbPort);
    const pgBin = pgInstance?.binPath || findPostgresBin();

    if (pgInstance) {
      logger.log(`  > PostgreSQL ${pgInstance.version} found for port ${projectDbPort}: ${pgInstance.binPath}`);
      const pgIsready = path.join(pgInstance.binPath, 'pg_isready.exe');
      let isReady = false;
      try {
        require('child_process').execSync(`"${pgIsready}" -p ${projectDbPort}`, { timeout: 5000, windowsHide: true, stdio: 'pipe' });
        isReady = true;
      } catch { /* not ready */ }

      if (!isReady) {
        logger.log(`PostgreSQL ${pgInstance.version} is stopped on port ${projectDbPort}. Starting...`);
        let started = false;
        for (const svc of [pgInstance.serviceName, `postgresql-${pgInstance.version}`]) {
          const { code } = await runCmd(`net start "${svc}"`);
          if (code === 0) { logger.log(`  > Service '${svc}' started!`); started = true; break; }
        }
        if (!started && pgInstance.dataDir) {
          const pgCtl = path.join(pgInstance.binPath, 'pg_ctl.exe');
          const { code, output } = await runCmd(`"${pgCtl}" start -D "${pgInstance.dataDir}" -w`);
          if (code === 0) { logger.log('  > PostgreSQL started via pg_ctl!'); started = true; }
        }
        if (started) await new Promise(r => setTimeout(r, 3000));
        else logger.log('  > Could not start PostgreSQL. Start it manually.');
      }
    } else if (pgBin) {
      logger.log(`  > No PostgreSQL instance found for port ${projectDbPort}. Using bin: ${pgBin}`);
    } else {
      logger.log('  > No native PostgreSQL found.');
    }

    // Verify PostgreSQL is ready
    let pgReady = false;
    if (pgBin) {
      const pgIsready = path.join(pgBin, 'pg_isready.exe');
      try {
        require('child_process').execSync(`"${pgIsready}" -p ${projectDbPort}`, { timeout: 5000, windowsHide: true, stdio: 'pipe' });
        pgReady = true;
      } catch { /* not ready */ }
    }
    if (!pgReady) {
      const dockerPg = findDockerPostgres();
      const dockerMatch = dockerPg.find((c: any) => c.port === projectDbPort);
      if (dockerMatch) { logger.log(`  > Using Docker PostgreSQL: ${dockerMatch.name}`); pgReady = true; }
    }
    if (!pgReady) {
      return { ok: false, msg: `PostgreSQL is not running on port ${projectDbPort}. Check your DB port in odoo.conf.` };
    }

    // Ensure DB user exists
    if (pgBin) {
      const psqlExe = path.join(pgBin, 'psql.exe');
      const safeId = /^[a-zA-Z0-9_]+$/;
      if (safeId.test(projectDbUser) && safeId.test(projectDbPassword)) {
        const { output: userCheck } = await runCmd(
          `"${psqlExe}" -U postgres -p ${projectDbPort} -tAc "SELECT 1 FROM pg_roles WHERE rolname='${projectDbUser}'"`,
          undefined, { ...process.env, PGPASSWORD: 'postgres' }
        );
        if (!userCheck.includes('1')) {
          logger.log(`  > Creating DB user '${projectDbUser}'...`);
          await runCmd(
            `"${psqlExe}" -U postgres -p ${projectDbPort} -c "CREATE ROLE ${projectDbUser} WITH LOGIN PASSWORD '${projectDbPassword}' CREATEDB;"`,
            undefined, { ...process.env, PGPASSWORD: 'postgres' }
          );
        }
      }
    }

    // Inject PostgreSQL bin into PATH
    const odooEnv = { ...process.env };
    if (pgBin && !odooEnv.PATH?.includes(pgBin)) {
      odooEnv.PATH = `${pgBin};${odooEnv.PATH || ''}`;
    }

    // Start Odoo process
    logger.log(`Starting Odoo: ${cmd}`);
    const { exec: execChild } = require('child_process');
    const odooProc = execChild(cmd, {
      cwd: projectPath, windowsHide: true, maxBuffer: 10 * 1024 * 1024, env: odooEnv,
    });
    odooProc.stdout?.on('data', (d: string) => {
      for (const line of d.toString().split('\n').filter(Boolean)) logger.log(`[odoo] ${line.trim()}`);
    });
    odooProc.stderr?.on('data', (d: string) => {
      for (const line of d.toString().split('\n').filter(Boolean)) logger.log(`[odoo:err] ${line.trim()}`);
    });
    odooProc.on('exit', (code: number | null) => {
      if (code !== null && code !== 0) logger.log(`[odoo] Process exited with code ${code}`);
    });

    invalidateStatusCache();
    return { ok: true, msg: 'Started' };
  }

  // --- Start Odoo ---
  ipcMain.handle('start_odoo', async (_event, data: Record<string, string>) => {
    const odooVersion = data?.odoo_version || DEFAULT_ODOO_VERSION;
    const baseDir = data?.base_dir || getDefaultBaseDir(odooVersion);
    const projectsDir = data?.projects_dir || getDefaultProjectsDir(odooVersion);
    const projectName = data?.project_name || '';
    const projPath = path.join(projectsDir, projectName);
    const conf = path.join(projPath, 'odoo.conf');
    const venvPy = path.join(baseDir, 'venv', 'Scripts', 'python.exe');
    const odooSourceDir = data?.odoo_source_dir || 'odoo';
    const odooBin = path.join(baseDir, odooSourceDir, 'odoo-bin');
    const logFile = path.join(projPath, 'odoo.log').replace(/\\/g, '/');
    const cmd = `"${venvPy}" "${odooBin}" -c "${conf}" --logfile "${logFile}"`;

    try {
      const result = await ensurePgAndStartOdoo({
        baseDir, projectPath: projPath, confFile: conf, odooSourceDir, cmd,
      });
      if (!result.ok) return result;

      // Start/reload Nginx for HTTPS proxy
      try {
        const { generateNginxConfig, startNginx, isNginxInstalled } = require('./utils/nginx');
        const { addHostEntry } = require('./utils/hosts');
        if (isNginxInstalled(baseDir)) {
          const { detectStatus } = require('./services/status');
          const status = await detectStatus(baseDir, projectsDir);
          const nginxProjects = (status.projects || [])
            .filter((p: any) => p.domain)
            .map((p: any) => ({ domain: p.domain, port: p.http_port, longpollingPort: p.longpolling_port }));
          // Ensure current project is included
          let projectDomain = '';
          try {
            const raw = require('fs').readFileSync(conf, 'utf8');
            const dm = raw.match(/^;\s*project_domain\s*=\s*(.+)$/m);
            if (dm) projectDomain = dm[1].trim();
          } catch {}
          if (projectDomain && !nginxProjects.some((p: any) => p.domain === projectDomain)) {
            const httpPort = data?.http_port || '8069';
            const lpPort = String(parseInt(httpPort, 10) + 3);
            nginxProjects.push({ domain: projectDomain, port: httpPort, longpollingPort: lpPort });
          }
          // Ensure all project domains are in hosts file
          for (const np of nginxProjects) {
            if (np.domain) addHostEntry(np.domain);
          }
          if (nginxProjects.length > 0) {
            await generateNginxConfig(baseDir, nginxProjects, logger);
            await startNginx(baseDir, logger);
            logger.log(`  > HTTPS: https://${projectDomain}`);
          }
        }
      } catch (e) {
        logger.log(`  > Nginx HTTPS proxy: ${e}`);
      }

      invalidateStatusCache();
      return { ok: true, command: cmd };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  });

  // --- Stop Odoo ---
  ipcMain.handle('stop_odoo', async (_event, data: Record<string, string>) => {
    const port = data?.http_port || '8069';
    if (!/^\d{1,5}$/.test(port)) return { ok: false, msg: 'Invalid port' };
    try {
      // Find and kill process on port
      const { output } = await runCmd(`netstat -ano | findstr ":${port}.*LISTENING"`);
      const lines = output.trim().split('\n').filter(Boolean);
      const pids = new Set<string>();
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== '0') pids.add(pid);
      }
      if (pids.size === 0) {
        return { ok: true, msg: 'Not running' };
      }
      for (const pid of pids) {
        await runCmd(`taskkill /F /PID ${pid}`);
      }
      logger.log(`Odoo stopped (killed PID: ${[...pids].join(', ')})`);
      invalidateStatusCache();
      return { ok: true, msg: 'Stopped' };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  });

  // --- Pick Folder (dialog) ---
  ipcMain.handle('pick-folder', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Addons Folder',
    });
    if (result.canceled || result.filePaths.length === 0) return { path: '' };
    // Convert backslashes to forward slashes for odoo.conf compatibility
    return { path: result.filePaths[0].replace(/\\/g, '/') };
  });

  // --- Open VS Code ---
  ipcMain.handle('open_vscode', async (_event, data: Record<string, string>) => {
    const targetPath = data?.path;
    if (!targetPath) return { ok: false, msg: 'No path provided' };
    try {
      const { findVSCode } = require('./services/detection');
      const vscodePath = findVSCode();
      if (!vscodePath) return { ok: false, msg: 'VS Code not found' };

      const { exec } = require('child_process');
      if (vscodePath === 'code') {
        // In PATH — use code command
        exec(`code "${targetPath}"`, { windowsHide: true });
      } else {
        // Portable/custom install — use full path to Code.exe
        exec(`"${vscodePath}" "${targetPath}"`, { windowsHide: true });
      }
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

  // --- Watch project log file (realtime tail) ---
  // Primary: PowerShell Get-Content -Wait (reliable on Windows, like tail -f)
  // Fallback: stat-based polling if PowerShell fails
  // Supports multiple windows watching the same log file
  type LogWatcherEntry = {
    tailProc: ReturnType<typeof spawn> | null;
    pollTimer: ReturnType<typeof setInterval> | null;
    lastSize: number;
    subscribers: Set<BrowserWindow>;
  };
  const logWatchers = new Map<string, LogWatcherEntry>();

  function broadcastLogLines(logPath: string, lines: string[]): void {
    const entry = logWatchers.get(logPath);
    if (!entry) return;
    const payload = { logPath, lines };
    for (const win of entry.subscribers) {
      if (!win.isDestroyed()) {
        win.webContents.send('project-log', payload);
      }
    }
    // Also always send to main window (for detail modal)
    if (!mainWindow.isDestroyed() && !entry.subscribers.has(mainWindow)) {
      mainWindow.webContents.send('project-log', payload);
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

    const callerWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;

    // If watcher already exists, just add subscriber
    if (logWatchers.has(logPath)) {
      logWatchers.get(logPath)!.subscribers.add(callerWindow);
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
        if (logWatchers.has(logPath) && !entry.pollTimer) {
          entry.tailProc = null;
          startPollFallback(logPath, entry);
        }
      });
      entry.tailProc = proc;
    } catch {
      // PowerShell not available — use poll fallback
      startPollFallback(logPath, entry);
    }

    logWatchers.set(logPath, entry);
    return { ok: true, lines: last1000 };
  });

  ipcMain.handle('unwatch-log', async (event, data: { logPath: string }) => {
    const logPath = data?.logPath;
    if (!logPath || !logWatchers.has(logPath)) return { ok: true };
    const entry = logWatchers.get(logPath)!;
    const callerWindow = BrowserWindow.fromWebContents(event.sender);
    if (callerWindow) entry.subscribers.delete(callerWindow);
    // Close watcher only when no more subscribers
    if (entry.subscribers.size === 0) {
      if (entry.tailProc) { try { entry.tailProc.kill(); } catch {} }
      if (entry.pollTimer) clearInterval(entry.pollTimer);
      logWatchers.delete(logPath);
    }
    return { ok: true };
  });

  // --- Separate Log Viewer Windows ---
  const LOG_WINDOW_COLORS = [
    '#f0883e', '#7c3aed', '#00e5ff', '#c77dba', '#3fb950',
    '#58a6ff', '#d29922', '#f85149', '#56d364', '#bc8cff',
  ];
  const logWindows = new Map<string, BrowserWindow>();
  let logColorIndex = 0;

  ipcMain.handle('open-log-window', async (_event, data: {
    projectName: string; logPath: string;
    odooVersion?: string; baseDir?: string; projectsDir?: string;
    httpPort?: string; odooSourceDir?: string;
  }) => {
    const { projectName, logPath } = data;
    const windowKey = projectName;

    // If window already open for this project, focus it
    if (logWindows.has(windowKey)) {
      const existing = logWindows.get(windowKey)!;
      if (!existing.isDestroyed()) {
        existing.focus();
        return { ok: true, msg: 'focused' };
      }
      logWindows.delete(windowKey);
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
    ].join('');
    const queryParams = `?project=${encodeURIComponent(projectName)}&logPath=${encodeURIComponent(logPath)}&color=${encodeURIComponent(color)}${extraParams}`;

    const logWin = new BrowserWindow({
      width: 800,
      height: 500,
      minWidth: 500,
      minHeight: 300,
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

    logWin.loadFile(logViewerPath, { search: queryParams });

    logWindows.set(windowKey, logWin);

    logWin.on('closed', () => {
      logWindows.delete(windowKey);
      // Cleanup: remove this window from all log watcher subscribers
      for (const [watchPath, entry] of logWatchers) {
        entry.subscribers.delete(logWin);
        if (entry.subscribers.size === 0) {
          if (entry.tailProc) { try { entry.tailProc.kill(); } catch {} }
          if (entry.pollTimer) clearInterval(entry.pollTimer);
          logWatchers.delete(watchPath);
        }
      }
    });

    return { ok: true, msg: 'opened', color };
  });

  // Pin/unpin log window (always on top)
  ipcMain.handle('log-window-pin', async (event, data: { pinned: boolean }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.setAlwaysOnTop(data.pinned);
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
      const { parseIniFile: pif, iniGet: ig } = require('./services/ini-parser');
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

      const { parseIniFile, iniGet } = require('./services/ini-parser');
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
        const { parseIniFile, iniGet } = require('./services/ini-parser');
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
          logger.log(`  > Log level changed to: ${data.logLevel} (handler: ${handlerVal})`);
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
          logger.log(`  > Odoo stopped (PID: ${[...pids].join(', ')})`);
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
          logger.log(`  > Upgrading modules: ${safeModules.join(', ')}`);
        }
      }

      // Use shared function: ensure PG ready + start Odoo
      return await ensurePgAndStartOdoo({ baseDir, projectPath, confFile, odooSourceDir, cmd });
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  });

  // --- Pick a file (for restore DB etc.) ---
  ipcMain.handle('pick-file', async (event, data: { title?: string; filters?: { name: string; extensions: string[] }[] }) => {
    const parentWin = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const result = await dialog.showOpenDialog(parentWin, {
      properties: ['openFile'],
      title: data?.title || 'Select File',
      filters: data?.filters || [],
    });
    if (result.canceled || result.filePaths.length === 0) return { path: '' };
    return { path: result.filePaths[0] };
  });

  // ========== Project Monitor: Database Tab ==========

  /** Read DB connection config + admin_passwd + data_dir from project's odoo.conf */
  function readDbConfig(projectName: string, projectsDir: string) {
    if (!projectName || !/^[a-z_][a-z0-9_\-]*$/.test(projectName)) return null;
    const confFile = path.join(projectsDir, projectName, 'odoo.conf');
    if (!fs.existsSync(confFile)) return null;
    const { parseIniFile, iniGet } = require('./services/ini-parser');
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
    const { findPostgresBin } = require('./services/detection');
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
    const win = logWindows.get(projectName);
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }

  // --- DB Job tracking (persists across Monitor close/reopen) ---
  interface DbJob {
    type: 'create' | 'restore';
    dbName: string;
    projectName: string;
    status: 'running' | 'done' | 'error';
    step: string;
    startTime: number;
    output: string[];
    error?: string;
  }
  const dbJobs = new Map<string, DbJob>();

  function getJobKey(projectName: string, type: string) { return `${projectName}:${type}`; }

  // Cleanup completed jobs after 5 minutes
  function scheduleJobCleanup(key: string) {
    setTimeout(() => { dbJobs.delete(key); }, 5 * 60 * 1000);
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
    dbJobs.set(jobKey, job);

    const emit = (step: string, detail?: string) => {
      job.step = step;
      emitDbProgress(data.projectName, 'db-job-progress', {
        type: 'create', dbName, step, detail, status: 'running',
        elapsed: Date.now() - job.startTime,
      });
    };

    // Run in background
    (async () => {
      try {
        // Step 1: Create empty DB
        emit('creating_db');
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
        emit('init_schema');
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

        const exitCode = await runCmdStreaming(initCmd, logger, {
          cwd: projectPath,
          env: odooEnv,
          onData: (line) => {
            job.output.push(line);
            if (job.output.length > 200) job.output.shift();
            emit('init_schema', line);
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
        emit('configuring_admin');
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
          logger, { cwd: projectPath, env: odooEnv }
        ).catch(() => {
          // Fallback: just log, password might need manual set
          logger.log('  > Note: Could not set admin password via shell. Default password may apply.');
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
        logger.log(`[monitor] Database created + initialized: ${dbName} (admin: ${adminEmail})`);
        emitDbProgress(data.projectName, 'db-job-progress', {
          type: 'create', dbName, step: 'done', status: 'done',
          elapsed: Date.now() - job.startTime,
        });
        scheduleJobCleanup(jobKey);
      } catch (e) {
        job.status = 'error'; job.error = String(e);
        emitDbProgress(data.projectName, 'db-job-progress', {
          type: 'create', dbName, step: 'error', status: 'error', error: String(e),
        });
        scheduleJobCleanup(jobKey);
      }
    })();

    return { ok: true, msg: 'STARTED' };
  });

  ipcMain.handle('monitor-drop-database', async (_event, data: { projectName: string; dbName: string; projectsDir?: string; odooVersion?: string }) => {
    try {
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

      const psql = path.join(pg.pgBin, 'psql.exe');
      await runCmd(
        `"${psql}" -h ${dbConf.host} -p ${dbConf.port} -U postgres -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${dbName}' AND pid <> pg_backend_pid()"`,
        undefined, pg.env
      ).catch(() => {});

      const dropdb = path.join(pg.pgBin, 'dropdb.exe');
      await runCmd(`"${dropdb}" -h ${dbConf.host} -p ${dbConf.port} -U postgres "${dbName}"`, undefined, pg.env);
      logger.log(`[monitor] Database dropped: ${dbName}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
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

    const emit = (step: string, detail?: string) => {
      job.step = step;
      emitDbProgress(data.projectName, 'db-job-progress', {
        type: 'restore', dbName, step, detail, status: 'running',
        elapsed: Date.now() - job.startTime,
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
          emit('extracting');
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
        emit('creating_db');
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
        emit('restoring_data');
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

        const exitCode = await runCmdStreaming(restoreCmd, logger, {
          env: pgEnv,
          onData: (line) => {
            job.output.push(line);
            if (job.output.length > 200) job.output.shift();
            // Emit progress every 10 objects to avoid flooding
            if (job.output.length % 10 === 0) emit('restoring_data', line);
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
          emit('copying_filestore');
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
        logger.log(`[monitor] Database restored: ${dbName} from ${path.basename(filePath)} (${job.output.length} objects)`);
        emitDbProgress(data.projectName, 'db-job-progress', {
          type: 'restore', dbName, step: 'done', status: 'done',
          elapsed: Date.now() - job.startTime, objectCount: job.output.length,
        });
        scheduleJobCleanup(jobKey);
      } catch (e) {
        job.status = 'error'; job.error = String(e);
        emitDbProgress(data.projectName, 'db-job-progress', {
          type: 'restore', dbName, step: 'error', status: 'error', error: String(e),
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

  // --- Get current app icon as data URL ---
  ipcMain.handle('get-icon', async () => {
    const customDir = path.join(app.getPath('userData'), 'custom-icon');
    const defaultDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', 'resources');
    // Check custom icon first
    for (const ext of ['.ico', '.png', '.svg']) {
      const p = path.join(customDir, `icon${ext}`);
      if (fs.existsSync(p)) {
        const buf = fs.readFileSync(p);
        const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : 'image/x-icon';
        return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, path: p, isCustom: true };
      }
    }
    // Fallback to bundled default
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

  // --- Pick and apply a custom icon (immediate) ---
  ipcMain.handle('pick-icon', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select App Icon',
      filters: [
        { name: 'Icons', extensions: ['ico', 'png', 'svg'] },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, msg: 'cancelled' };
    const src = result.filePaths[0];
    const ext = path.extname(src).toLowerCase();
    const customDir = path.join(app.getPath('userData'), 'custom-icon');
    try {
      // Ensure custom-icon directory exists
      if (!fs.existsSync(customDir)) fs.mkdirSync(customDir, { recursive: true });
      // Remove old custom icons
      for (const old of ['.ico', '.png', '.svg']) {
        const oldPath = path.join(customDir, `icon${old}`);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      // Copy new icon
      const destName = `icon${ext}`;
      const destPath = path.join(customDir, destName);
      fs.copyFileSync(src, destPath);
      // Apply to window immediately
      if (ext === '.ico' || ext === '.png') {
        const { nativeImage } = require('electron');
        mainWindow.setIcon(nativeImage.createFromPath(destPath));
      }
      // Return preview data
      const buf = fs.readFileSync(src);
      const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : 'image/x-icon';
      return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, fileName: destName };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  });

  // --- User Settings Persistence ---
  const settingsFile = path.join(app.getPath('userData'), 'user-settings.json');

  ipcMain.handle('load-settings', async () => {
    try {
      if (fs.existsSync(settingsFile)) {
        const raw = fs.readFileSync(settingsFile, 'utf8');
        return { ok: true, settings: JSON.parse(raw) };
      }
    } catch {
      // corrupted file — ignore
    }
    return { ok: true, settings: {} };
  });

  ipcMain.handle('save-settings', async (_event, data: Record<string, string>) => {
    try {
      const dir = path.dirname(settingsFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify(data, null, 2), 'utf8');

      // Broadcast language change to all log/monitor windows
      if (data.language) {
        for (const [, win] of logWindows) {
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

  // --- Reset icon to default ---
  ipcMain.handle('reset-icon', async () => {
    const customDir = path.join(app.getPath('userData'), 'custom-icon');
    try {
      if (fs.existsSync(customDir)) {
        for (const ext of ['.ico', '.png', '.svg']) {
          const p = path.join(customDir, `icon${ext}`);
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }
      }
      // Restore default icon
      const defaultIcon = app.isPackaged
        ? path.join(process.resourcesPath, 'icon.ico')
        : path.join(__dirname, '..', '..', 'resources', 'icon.ico');
      if (fs.existsSync(defaultIcon)) {
        const { nativeImage } = require('electron');
        mainWindow.setIcon(nativeImage.createFromPath(defaultIcon));
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  });

  // --- Cleanup on app quit ---
  app.on('before-quit', () => {
    // Close all log file watchers + poll timers
    for (const [, entry] of logWatchers) {
      if (entry.tailProc) { try { entry.tailProc.kill(); } catch {} }
      if (entry.pollTimer) clearInterval(entry.pollTimer);
    }
    logWatchers.clear();
    // Close all log viewer windows
    for (const [, win] of logWindows) {
      if (!win.isDestroyed()) win.destroy();
    }
    logWindows.clear();
  });
}

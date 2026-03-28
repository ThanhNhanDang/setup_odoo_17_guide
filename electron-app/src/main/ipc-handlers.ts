import { ipcMain, BrowserWindow, shell, dialog, app } from 'electron';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { runCmd } from './utils/shell';
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
        if (entry.watcher) entry.watcher.close();
        clearInterval(entry.pollTimer);
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

  // --- Start Odoo ---
  ipcMain.handle('start_odoo', async (_event, data: Record<string, string>) => {
    // Read odoo_version from project config to use correct base dir
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
      // Read project's DB config from odoo.conf
      let projectDbPort = '5434';
      let projectDbUser = 'odoo';
      let projectDbPassword = 'odoo';
      try {
        const { parseIniFile, iniGet } = require('./services/ini-parser');
        const ini = parseIniFile(conf);
        projectDbPort = iniGet(ini, 'options', 'db_port', '5434');
        projectDbUser = iniGet(ini, 'options', 'db_user', 'odoo');
        projectDbPassword = iniGet(ini, 'options', 'db_password', 'odoo');
      } catch { /* use defaults */ }

      logger.log(`  > Project DB config: port=${projectDbPort}, user=${projectDbUser}`);

      // Find the PostgreSQL instance matching this project's port
      const { findPostgresForPort, findPostgresBin, findDockerPostgres } = require('./services/detection');
      const pgInstance = findPostgresForPort(projectDbPort);
      const pgBin = pgInstance?.binPath || findPostgresBin();

      if (pgInstance) {
        logger.log(`  > PostgreSQL ${pgInstance.version} found for port ${projectDbPort}: ${pgInstance.binPath}`);

        // Check if this specific instance is ready
        const pgIsready = path.join(pgInstance.binPath, 'pg_isready.exe');
        let isReady = false;
        try {
          require('child_process').execSync(`"${pgIsready}" -p ${projectDbPort}`, { timeout: 5000, windowsHide: true, stdio: 'pipe' });
          isReady = true;
        } catch { /* not ready */ }

        if (!isReady) {
          logger.log(`PostgreSQL ${pgInstance.version} is stopped on port ${projectDbPort}. Starting...`);
          let started = false;

          // Method 1: net start with exact service name
          for (const svc of [pgInstance.serviceName, `postgresql-${pgInstance.version}`]) {
            const { code } = await runCmd(`net start "${svc}"`);
            if (code === 0) {
              logger.log(`  > Service '${svc}' started!`);
              started = true;
              break;
            }
          }

          // Method 2: pg_ctl (no Admin needed)
          if (!started && pgInstance.dataDir) {
            const pgCtl = path.join(pgInstance.binPath, 'pg_ctl.exe');
            logger.log(`  > Trying pg_ctl start -D "${pgInstance.dataDir}" -w`);
            const { code, output } = await runCmd(`"${pgCtl}" start -D "${pgInstance.dataDir}" -w`);
            logger.log(`  > pg_ctl exit code: ${code}`);
            if (output.trim()) logger.log(`  > ${output.trim().split('\n').pop()}`);
            if (code === 0) {
              logger.log('  > PostgreSQL started via pg_ctl!');
              started = true;
            }
          }

          if (started) {
            await new Promise(resolve => setTimeout(resolve, 3000));
          } else {
            logger.log('  > Could not start PostgreSQL. Start it manually.');
          }
        }
      } else if (pgBin) {
        logger.log(`  > No PostgreSQL instance found for port ${projectDbPort}. Using bin: ${pgBin}`);
      } else {
        logger.log('  > No native PostgreSQL found.');
      }

      // Verify PostgreSQL is ready on the project's port
      let pgReady = false;
      if (pgBin) {
        const pgIsready = path.join(pgBin, 'pg_isready.exe');
        try {
          require('child_process').execSync(`"${pgIsready}" -p ${projectDbPort}`, { timeout: 5000, windowsHide: true, stdio: 'pipe' });
          pgReady = true;
        } catch { /* not ready */ }
      }
      logger.log(`  > PostgreSQL ready check on port ${projectDbPort}: ${pgReady}`);

      if (!pgReady) {
        // Also check Docker containers on this port
        const dockerPg = findDockerPostgres();
        const dockerMatch = dockerPg.find((c: any) => c.port === projectDbPort);
        if (dockerMatch) {
          logger.log(`  > Using Docker PostgreSQL: ${dockerMatch.name} on port ${projectDbPort}`);
          pgReady = true;
        } else if (dockerPg.length > 0) {
          logger.log(`  > Docker PostgreSQL found but not on port ${projectDbPort}: ${dockerPg.map((c: any) => `${c.name}:${c.port}`).join(', ')}`);
        }
      }

      if (!pgReady) {
        return { ok: false, msg: `PostgreSQL is not running on port ${projectDbPort}. Check your DB port in odoo.conf.` };
      }

      // Ensure per-project DB user exists
      if (pgBin) {
        logger.log(`  > Ensuring DB user '${projectDbUser}' exists on port ${projectDbPort}...`);
        const psqlExe = path.join(pgBin, 'psql.exe');
        // Validate DB identifiers to prevent SQL injection
        const safeId = /^[a-zA-Z0-9_]+$/;
        if (!safeId.test(projectDbUser) || !safeId.test(projectDbPassword)) {
          logger.log(`  > Skipping DB user creation — invalid characters in db_user or db_password`);
        } else {
        const { output: userCheck } = await runCmd(
          `"${psqlExe}" -U postgres -p ${projectDbPort} -tAc "SELECT 1 FROM pg_roles WHERE rolname='${projectDbUser}'"`,
          undefined,
          { ...process.env, PGPASSWORD: 'postgres' }
        );
        if (!userCheck.includes('1')) {
          logger.log(`  > Creating DB user '${projectDbUser}'...`);
          await runCmd(
            `"${psqlExe}" -U postgres -p ${projectDbPort} -c "CREATE ROLE ${projectDbUser} WITH LOGIN PASSWORD '${projectDbPassword}' CREATEDB;"`,
            undefined,
            { ...process.env, PGPASSWORD: 'postgres' }
          );
          logger.log(`  > DB user '${projectDbUser}' created.`);
        }
        } // end safeId check
      }

      // Start Odoo using exec (no terminal window)
      // Inject PostgreSQL bin into PATH so Odoo can find psql/pg_restore for DB operations
      const odooEnv = { ...process.env };
      if (pgBin && !odooEnv.PATH?.includes(pgBin)) {
        odooEnv.PATH = `${pgBin};${odooEnv.PATH || ''}`;
        logger.log(`  > Added PostgreSQL bin to PATH: ${pgBin}`);
      }
      logger.log(`Starting Odoo: ${cmd}`);
      const { exec: execChild } = require('child_process');
      const odooProc = execChild(cmd, {
        cwd: projPath,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        env: odooEnv,
      });

      // Log Odoo stdout/stderr to installer log
      odooProc.stdout?.on('data', (data: string) => {
        for (const line of data.toString().split('\n').filter(Boolean)) {
          logger.log(`[odoo] ${line.trim()}`);
        }
      });
      odooProc.stderr?.on('data', (data: string) => {
        for (const line of data.toString().split('\n').filter(Boolean)) {
          logger.log(`[odoo:err] ${line.trim()}`);
        }
      });
      odooProc.on('exit', (code: number | null) => {
        if (code !== null && code !== 0) {
          logger.log(`[odoo] Process exited with code ${code}`);
        }
      });

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
  // Supports multiple windows watching the same log file
  const logWatchers = new Map<string, { watcher: fs.FSWatcher | null; pollTimer: ReturnType<typeof setInterval>; subscribers: Set<BrowserWindow> }>();

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

    // Create new watcher — fs.watch + polling fallback for reliability on Windows
    let lastSize = fs.statSync(logPath).size;
    const subscribers = new Set<BrowserWindow>([callerWindow]);

    function readNewLines() {
      try {
        const newSize = fs.statSync(logPath).size;
        if (newSize === lastSize) return;
        const readStart = newSize < lastSize ? 0 : lastSize;
        const stream = fs.createReadStream(logPath, { start: readStart, encoding: 'utf8' });
        let newData = '';
        stream.on('data', (chunk) => { newData += String(chunk); });
        stream.on('end', () => {
          lastSize = newSize;
          const newLines = newData.split('\n').filter(Boolean);
          if (newLines.length > 0) broadcastLogLines(logPath, newLines);
        });
      } catch { /* ignore */ }
    }

    // Primary: fs.watch (instant on most Windows setups)
    let watcher: fs.FSWatcher | null = null;
    try {
      watcher = fs.watch(logPath, () => readNewLines());
    } catch { /* fs.watch may fail on some paths — polling will cover it */ }

    // Fallback: poll every 1s (fs.watch is unreliable on some Windows configs)
    const pollTimer = setInterval(readNewLines, 1000);

    logWatchers.set(logPath, { watcher, pollTimer, subscribers });
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
      if (entry.watcher) entry.watcher.close();
      clearInterval(entry.pollTimer);
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
      title: `${projectName} — Log`,
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
          if (entry.watcher) entry.watcher.close();
          clearInterval(entry.pollTimer);
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

      // Update log_level in odoo.conf if provided
      if (data.logLevel) {
        const { parseIniFile, iniGet, iniSet, stringifyIni } = require('./services/ini-parser');
        const ini = parseIniFile(confFile);
        const currentLevel = iniGet(ini, 'options', 'log_level', 'error');
        if (data.logLevel !== currentLevel) {
          const newIni = iniSet(ini, 'options', 'log_level', data.logLevel);
          // Preserve comments — read raw, replace the log_level line
          let raw = fs.readFileSync(confFile, 'utf8');
          if (raw.includes('log_level')) {
            raw = raw.replace(/^log_level\s*=\s*.+$/m, `log_level = ${data.logLevel}`);
          } else {
            // Append under [options]
            raw = raw.replace(/^\[options\]\s*$/m, `[options]\nlog_level = ${data.logLevel}`);
          }
          fs.writeFileSync(confFile, raw, 'utf8');
          logger.log(`  > Log level changed to: ${data.logLevel}`);
        }
      }

      // Stop Odoo on the port
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
        // Validate module names
        const safeModName = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
        const safeModules = data.upgradeModules.filter(m => safeModName.test(m));
        if (safeModules.length > 0) {
          cmd += ` -u ${safeModules.join(',')}`;
          logger.log(`  > Upgrading modules: ${safeModules.join(', ')}`);
        }
      }

      // Find PostgreSQL bin for PATH injection
      const { findPostgresForPort, findPostgresBin } = require('./services/detection');
      const { parseIniFile: pif, iniGet: ig } = require('./services/ini-parser');
      const iniForPg = pif(confFile);
      const dbPort = ig(iniForPg, 'options', 'db_port', '5434');
      const pgInstance = findPostgresForPort(dbPort);
      const pgBin = pgInstance?.binPath || findPostgresBin();

      const odooEnv = { ...process.env };
      if (pgBin && !odooEnv.PATH?.includes(pgBin)) {
        odooEnv.PATH = `${pgBin};${odooEnv.PATH || ''}`;
      }

      logger.log(`Restarting Odoo: ${cmd}`);
      const { exec: execChild } = require('child_process');
      const odooProc = execChild(cmd, {
        cwd: projectPath,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        env: odooEnv,
      });

      odooProc.stdout?.on('data', (d: string) => {
        for (const line of d.toString().split('\n').filter(Boolean)) {
          logger.log(`[odoo] ${line.trim()}`);
        }
      });
      odooProc.stderr?.on('data', (d: string) => {
        for (const line of d.toString().split('\n').filter(Boolean)) {
          logger.log(`[odoo:err] ${line.trim()}`);
        }
      });
      odooProc.on('exit', (code: number | null) => {
        if (code !== null && code !== 0) {
          logger.log(`[odoo] Process exited with code ${code}`);
        }
      });

      invalidateStatusCache();
      return { ok: true, msg: 'Restarted' };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
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
      if (entry.watcher) entry.watcher.close();
      clearInterval(entry.pollTimer);
    }
    logWatchers.clear();
    // Close all log viewer windows
    for (const [, win] of logWindows) {
      if (!win.isDestroyed()) win.destroy();
    }
    logWindows.clear();
  });
}

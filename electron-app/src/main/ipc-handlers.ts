import { ipcMain, BrowserWindow, shell, dialog, app } from 'electron';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { runCmd } from './utils/shell';
import { LoggerService } from './services/logger';
import { StepLockManager } from './services/step-lock';
import { DEFAULT_BASE_DIR, DEFAULT_PROJECTS_DIR } from './services/config';
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

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  const logger = new LoggerService(mainWindow);
  const stepLock = new StepLockManager();

  // --- App Info ---
  ipcMain.handle('app-version', () => {
    const { app } = require('electron');
    return app.getVersion();
  });

  ipcMain.handle('default-paths', () => {
    return { base_dir: DEFAULT_BASE_DIR, projects_dir: DEFAULT_PROJECTS_DIR };
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
    return safe(() => detectStatus(baseDir, projectsDir));
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
    const baseDir = data?.base_dir || DEFAULT_BASE_DIR;
    const projectsDir = data?.projects_dir || DEFAULT_PROJECTS_DIR;
    const projectName = data?.project_name || 'my_project';
    const opts: Record<string, string> = {};
    for (const [k, v] of Object.entries(data || {})) {
      if (!['base_dir', 'projects_dir', 'project_name'].includes(k)) {
        opts[k] = v;
      }
    }

    // Run in background (non-blocking)
    stepFullInstall(baseDir, projectsDir, projectName, logger, opts, stepLock)
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
    const baseDir = data?.base_dir || DEFAULT_BASE_DIR;

    const stepFns: Record<string, () => Promise<{ ok: boolean; msg: string }>> = {
      install_nginx: () => stepInstallNginx(baseDir, logger),
      install_git: () => stepInstallGit(baseDir, logger),
      install_vscode: () => stepInstallVSCode(baseDir, logger),
      install_python: () => stepInstallPython(baseDir, logger),
      install_postgres: () => stepInstallPostgres(
        baseDir, logger,
        data?.pg_super_password || 'postgres',
        data?.db_port || '5432',
        data?.db_user || 'odoo',
        data?.db_password || 'odoo',
        data?.pg_mode || 'auto',
      ),
      clone_odoo: () => stepCloneOdoo(baseDir, logger),
      create_venv: () => stepCreateVenv(baseDir, logger),
      install_requirements: () => stepInstallRequirements(baseDir, logger),
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
    const baseDir = data?.base_dir || DEFAULT_BASE_DIR;
    const projectsDir = data?.projects_dir || DEFAULT_PROJECTS_DIR;
    const projectName = data?.project_name || '';
    const opts: Record<string, string> = {};
    for (const [k, v] of Object.entries(data || {})) {
      if (!['base_dir', 'projects_dir', 'project_name'].includes(k)) {
        opts[k] = v;
      }
    }
    return stepCreateProject(baseDir, projectsDir, projectName, logger, opts);
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
    return deleteProject(projectsDir, projectName);
  });

  // --- Duplicate Project ---
  ipcMain.handle('duplicate_project', async (_event, data: Record<string, string>) => {
    const baseDir = data?.base_dir || DEFAULT_BASE_DIR;
    const projectsDir = data?.projects_dir || DEFAULT_PROJECTS_DIR;
    const projectName = data?.project_name || '';
    const newName = data?.new_name || '';
    const newHttpPort = data?.new_http_port || '8070';
    return duplicateProject(baseDir, projectsDir, projectName, newName, newHttpPort);
  });

  // --- Start Odoo ---
  ipcMain.handle('start_odoo', async (_event, data: Record<string, string>) => {
    const baseDir = data?.base_dir || DEFAULT_BASE_DIR;
    const projectsDir = data?.projects_dir || DEFAULT_PROJECTS_DIR;
    const projectName = data?.project_name || '';
    const projPath = path.join(projectsDir, projectName);
    const conf = path.join(projPath, 'odoo.conf');
    const venvPy = path.join(baseDir, 'venv', 'Scripts', 'python.exe');
    const odooBin = path.join(baseDir, 'odoo', 'odoo-bin');
    const cmd = `"${venvPy}" "${odooBin}" -c "${conf}"`;

    try {
      // Auto-start native PostgreSQL if stopped
      const { detectNativePostgresDetails, findPostgresBin } = require('./services/detection');
      const pgBin = findPostgresBin();
      if (pgBin) {
        const pgDetails = detectNativePostgresDetails();
        const pgPort = pgDetails?.port || '5432';
        logger.log(`  > PostgreSQL detected: bin=${pgBin}, port=${pgPort}, ready=${pgDetails?.is_ready}`);

        if (pgDetails && !pgDetails.is_ready) {
          logger.log('PostgreSQL is stopped. Starting...');
          let started = false;

          // Method 1: net start (requires Admin)
          for (const svc of ['postgresql-x64-17', 'postgresql-x64-16', 'postgresql-x64-15', 'postgresql-x64-14']) {
            const { code, output } = await runCmd(`net start "${svc}"`);
            if (code === 0) {
              logger.log(`  > Service '${svc}' started!`);
              started = true;
              break;
            }
          }

          // Method 2: pg_ctl (no Admin needed)
          if (!started && pgDetails.data_dir) {
            const pgCtl = path.join(pgBin, 'pg_ctl.exe');
            logger.log(`  > Trying pg_ctl start -D "${pgDetails.data_dir}" -w`);
            const { code, output } = await runCmd(`"${pgCtl}" start -D "${pgDetails.data_dir}" -w`);
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
      } else {
        logger.log('  > No native PostgreSQL found.');
      }

      // Verify PostgreSQL is ready - check directly with pg_isready
      const pgDetailsAfter = detectNativePostgresDetails();
      const pgReady = pgDetailsAfter?.is_ready ?? false;
      logger.log(`  > PostgreSQL ready check: ${pgReady} (port: ${pgDetailsAfter?.port || 'unknown'})`);
      if (!pgReady) {
        // Also check Docker containers
        const { findDockerPostgres } = require('./services/detection');
        const dockerPg = findDockerPostgres();
        if (dockerPg.length === 0) {
          return { ok: false, msg: `PostgreSQL is not running on port ${pgDetailsAfter?.port || '5434'}. Run as Admin: net start postgresql-x64-15` };
        }
        logger.log('  > Using Docker PostgreSQL instead.');
      }

      // Ensure per-project DB user exists before starting Odoo
      // Read db_user from project's odoo.conf
      const pgDetailsReady = detectNativePostgresDetails();
      if (pgDetailsReady?.is_ready) {
        const pgPort = pgDetailsReady.port || '5434';
        let projectDbUser = 'odoo';
        try {
          const { parseIniFile, iniGet } = require('./services/ini-parser');
          const ini = parseIniFile(conf);
          projectDbUser = iniGet(ini, 'options', 'db_user', 'odoo');
        } catch { /* use default */ }

        logger.log(`  > Ensuring DB user '${projectDbUser}' exists on port ${pgPort}...`);
        const { output: userCheck } = await runCmd(
          `"${path.join(pgDetailsReady.bin_path, 'psql.exe')}" -U postgres -p ${pgPort} -tAc "SELECT 1 FROM pg_roles WHERE rolname='${projectDbUser}'"`,
          undefined,
          { ...process.env, PGPASSWORD: 'postgres' }
        );
        if (!userCheck.includes('1')) {
          const dbPwd = 'odoo';
          logger.log(`  > Creating DB user '${projectDbUser}'...`);
          await runCmd(
            `"${path.join(pgDetailsReady.bin_path, 'psql.exe')}" -U postgres -p ${pgPort} -c "CREATE ROLE ${projectDbUser} WITH LOGIN PASSWORD '${dbPwd}' CREATEDB;"`,
            undefined,
            { ...process.env, PGPASSWORD: 'postgres' }
          );
          logger.log(`  > DB user '${projectDbUser}' created.`);
        }
      }

      // Start Odoo using exec (no terminal window)
      logger.log(`Starting Odoo: ${cmd}`);
      const { exec: execChild } = require('child_process');
      const odooProc = execChild(cmd, {
        cwd: projPath,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
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
          if (nginxProjects.length > 0) {
            await generateNginxConfig(baseDir, nginxProjects, logger);
            await startNginx(baseDir, logger);
            logger.log(`  > HTTPS: https://${projectDomain}`);
          }
        }
      } catch (e) {
        logger.log(`  > Nginx HTTPS proxy: ${e}`);
      }

      return { ok: true, command: cmd };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  });

  // --- Stop Odoo ---
  ipcMain.handle('stop_odoo', async (_event, data: Record<string, string>) => {
    const port = data?.http_port || '8069';
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
    return { path: result.filePaths[0] };
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
  const logWatchers = new Map<string, fs.FSWatcher>();

  ipcMain.handle('watch-log', async (_event, data: { logPath: string }) => {
    const logPath = data?.logPath;
    if (!logPath || !fs.existsSync(logPath)) return { ok: false, lines: [] };

    // Read last 1000 lines
    const content = fs.readFileSync(logPath, 'utf8');
    const allLines = content.split('\n');
    const last1000 = allLines.slice(-1000);

    // Stop existing watcher for this path
    if (logWatchers.has(logPath)) {
      logWatchers.get(logPath)!.close();
      logWatchers.delete(logPath);
    }

    // Watch for changes
    let lastSize = fs.statSync(logPath).size;
    const watcher = fs.watch(logPath, () => {
      try {
        const newSize = fs.statSync(logPath).size;
        if (newSize <= lastSize) { lastSize = newSize; return; }
        // Read only new bytes
        const stream = fs.createReadStream(logPath, { start: lastSize, encoding: 'utf8' });
        let newData = '';
        stream.on('data', (chunk) => { newData += String(chunk); });
        stream.on('end', () => {
          lastSize = newSize;
          const newLines = newData.split('\n').filter(Boolean);
          if (newLines.length > 0 && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('project-log', { logPath, lines: newLines });
          }
        });
      } catch { /* ignore */ }
    });

    logWatchers.set(logPath, watcher);
    return { ok: true, lines: last1000 };
  });

  ipcMain.handle('unwatch-log', async (_event, data: { logPath: string }) => {
    const logPath = data?.logPath;
    if (logPath && logWatchers.has(logPath)) {
      logWatchers.get(logPath)!.close();
      logWatchers.delete(logPath);
    }
    return { ok: true };
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
}

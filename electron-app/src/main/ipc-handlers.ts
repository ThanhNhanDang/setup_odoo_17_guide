import { ipcMain, BrowserWindow, shell } from 'electron';
import { spawn } from 'child_process';
import * as path from 'path';
import { runCmd } from './utils/shell';
import { LoggerService } from './services/logger';
import { DEFAULT_BASE_DIR, DEFAULT_PROJECTS_DIR } from './services/config';
import { detectStatus } from './services/status';
import {
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
    return safe(() => Promise.resolve(detectStatus(baseDir, projectsDir)));
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
    stepFullInstall(baseDir, projectsDir, projectName, logger, opts)
      .then(results => {
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
    return fn();
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

      logger.log(`Starting Odoo: ${cmd}`);
      const proc = spawn('cmd.exe', ['/c', cmd], {
        cwd: projPath,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      proc.unref();
      return { ok: true, command: cmd };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  });

  // --- Open VS Code ---
  ipcMain.handle('open_vscode', async (_event, data: Record<string, string>) => {
    const targetPath = data?.path;
    if (!targetPath) return { ok: false, msg: 'No path provided' };
    try {
      // Use exec with windowsHide to avoid black terminal flash
      const { exec } = require('child_process');
      exec(`code "${targetPath}"`, { windowsHide: true });
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
}

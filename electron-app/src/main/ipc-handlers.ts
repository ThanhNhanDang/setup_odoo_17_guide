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
      const { exec } = require('child_process');
      // Open folder then focus Explorer sidebar
      exec(`code "${targetPath}" && code -r --command workbench.view.explorer`, { windowsHide: true });
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

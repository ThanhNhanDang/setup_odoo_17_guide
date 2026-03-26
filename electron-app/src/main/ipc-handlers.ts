import { ipcMain, BrowserWindow, shell } from 'electron';
import { spawn } from 'child_process';
import * as path from 'path';
import { LoggerService } from './services/logger';
import { DEFAULT_BASE_DIR, DEFAULT_PROJECTS_DIR } from './services/config';
import { detectStatus } from './services/status';
import {
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
      spawn('cmd.exe', ['/c', `code "${targetPath}"`], {
        detached: true,
        stdio: 'ignore',
        shell: true,
      }).unref();
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

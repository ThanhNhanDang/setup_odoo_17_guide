import { ipcMain } from 'electron';
import { IpcContext } from './context';
import { readUrlOverrides } from './settings-handlers';
import { DEFAULT_BASE_DIR, DEFAULT_PROJECTS_DIR, getDefaultBaseDir, getDefaultProjectsDir } from '../services/config';
import { DEFAULT_ODOO_VERSION, ALL_VERSIONS } from '../services/odoo-versions';
import { detectStatus, invalidateStatusCache, StatusResult, ProjectInfo } from '../services/status';
import {
  stepInstallNginx, stepInstallGit, stepInstallVSCode, stepInstallWkhtmltopdf,
  stepInstallPython, stepInstallPostgres, stepCloneOdoo, stepCreateVenv,
  stepInstallRequirements, stepFullInstall,
} from '../services/installer';

/** Wrap IPC handler with error catching */
function safe<T>(fn: () => Promise<T>): Promise<T | { ok: false; msg: string }> {
  return fn().catch((e: Error) => ({ ok: false as const, msg: `Error: ${e.message}` }));
}

export function registerInstallHandlers(ctx: IpcContext): void {
  // --- Status ---
  ipcMain.handle('status', async (_event, data: Record<string, string>) => {
    const odooVersion = data?.odoo_version || DEFAULT_ODOO_VERSION;
    const baseDir = data?.base_dir || DEFAULT_BASE_DIR;
    const projectsDir = data?.projects_dir || DEFAULT_PROJECTS_DIR;
    const odooSourceDir = data?.odoo_source_dir || 'odoo';
    return safe(() => detectStatus(baseDir, projectsDir, odooSourceDir, odooVersion));
  });

  // --- Status All Versions (for "All" filter) ---
  ipcMain.handle('status-all', async () => {
    return safe(async () => {
      const allProjects: ProjectInfo[] = [];
      let baseResult: StatusResult | null = null;

      for (const ver of ALL_VERSIONS) {
        const baseDir = getDefaultBaseDir(ver);
        const projectsDir = getDefaultProjectsDir(ver);
        try {
          const s = await detectStatus(baseDir, projectsDir, 'odoo', ver);
          if (!baseResult) baseResult = s;
          allProjects.push(...s.projects);
        } catch { /* skip unavailable version */ }
      }

      if (!baseResult) {
        return detectStatus(DEFAULT_BASE_DIR, DEFAULT_PROJECTS_DIR, 'odoo', DEFAULT_ODOO_VERSION);
      }
      // Return base status with merged projects from all versions
      return { ...baseResult, projects: allProjects };
    });
  });

  // --- Log ---
  ipcMain.handle('log', async () => {
    return { lines: ctx.logger.getLines(), task: ctx.logger.getTask() };
  });

  // --- Full Install ---
  ipcMain.handle('full_install', async (_event, data: Record<string, string>) => {
    if (ctx.logger.getTask().status === 'running') {
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

    ctx.logger.updateTask({ status: 'running', step: 'Starting...', progress: 0 });

    stepFullInstall(baseDir, projectsDir, projectName, ctx.logger, opts, ctx.stepLock, odooVersion, readUrlOverrides())
      .then(results => {
        invalidateStatusCache();
        ctx.logger.updateTask({ status: 'done', step: 'Complete!', progress: 100, results });
      })
      .catch(e => {
        ctx.logger.updateTask({ status: 'error', step: String(e), progress: 0 });
        ctx.logger.log(`[ERROR] Full install failed: ${e}`);
      });

    return { ok: true, msg: 'Install started in background. Check log for progress.' };
  });

  // --- Run Step ---
  ipcMain.handle('run_step', async (_event, data: Record<string, string>) => {
    const step = data?.step || '';
    const odooVersion = data?.odoo_version || DEFAULT_ODOO_VERSION;
    const baseDir = data?.base_dir || getDefaultBaseDir(odooVersion);
    const odooSourceDir = data?.odoo_source_dir || 'odoo';

    const stepFns: Record<string, () => Promise<{ ok: boolean; msg: string }>> = {
      install_nginx: () => stepInstallNginx(baseDir, ctx.logger),
      install_git: () => stepInstallGit(baseDir, ctx.logger),
      install_vscode: () => stepInstallVSCode(baseDir, ctx.logger),
      install_wkhtmltopdf: () => stepInstallWkhtmltopdf(baseDir, ctx.logger),
      install_python: () => stepInstallPython(baseDir, ctx.logger, odooVersion, readUrlOverrides()),
      install_postgres: () => stepInstallPostgres(
        baseDir, ctx.logger,
        data?.pg_super_password || 'postgres',
        data?.db_port || '5432',
        data?.db_user || 'odoo',
        data?.db_password || 'odoo',
        data?.pg_mode || 'auto',
        odooVersion,
        readUrlOverrides(),
      ),
      clone_odoo: () => stepCloneOdoo(baseDir, ctx.logger, odooVersion, odooSourceDir),
      create_venv: () => stepCreateVenv(baseDir, ctx.logger, odooVersion),
      install_requirements: () => stepInstallRequirements(baseDir, ctx.logger, odooVersion, odooSourceDir),
    };

    const fn = stepFns[step];
    if (!fn) return { ok: false, msg: `Unknown step: ${step}` };
    if (ctx.stepLock.isLocked(step)) return { ok: false, msg: 'Step already running' };
    const promise = fn();
    ctx.stepLock.acquire(step, 'run_step', promise);
    try {
      const result = await promise;
      invalidateStatusCache();
      return result;
    } finally {
      ctx.stepLock.release(step);
    }
  });
}

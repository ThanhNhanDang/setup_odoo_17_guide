import { ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { runCmd } from '../utils/shell';
import { IpcContext } from './context';
import { DEFAULT_BASE_DIR, DEFAULT_PROJECTS_DIR, getDefaultBaseDir, getDefaultProjectsDir, getTemplatesDir } from '../services/config';
import { DEFAULT_ODOO_VERSION } from '../services/odoo-versions';
import { invalidateStatusCache } from '../services/status';
import { stepCreateProject } from '../services/installer';
import { readProjectConfig, saveProjectConfig, deleteProject, duplicateProject } from '../services/projects';

export function registerProjectHandlers(ctx: IpcContext): void {
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
      ctx.mainWindow.webContents.send('create-progress', { step, done });
    };
    const result = await stepCreateProject(baseDir, projectsDir, projectName, ctx.logger, opts, odooVersion, onProgress);
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
    for (const [logPath, entry] of ctx.logWatchers) {
      if (logPath.startsWith(projPath)) {
        if (entry.tailProc) { try { entry.tailProc.kill(); } catch {} }
        if (entry.pollTimer) clearInterval(entry.pollTimer);
        ctx.logWatchers.delete(logPath);
      }
    }
    // Close log viewer window for this project
    if (ctx.logWindows.has(projectName)) {
      const win = ctx.logWindows.get(projectName)!;
      if (!win.isDestroyed()) win.destroy();
      ctx.logWindows.delete(projectName);
    }

    const onProgress = (step: string, done: boolean) => {
      ctx.mainWindow.webContents.send('delete-progress', { step, done });
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

    if (!fs.existsSync(proj)) return { ok: false, msg: 'Project not found' };

    try {
      const templatesDir = getTemplatesDir();
      const venvPython = path.join(baseDir, 'venv', 'Scripts', 'python.exe').replace(/\\/g, '\\\\');
      const odooSourceDir2 = data?.odoo_source_dir || 'odoo';
      const odooBin = path.join(baseDir, odooSourceDir2, 'odoo-bin').replace(/\\/g, '\\\\');

      const vscodePath = path.join(proj, '.vscode');
      fs.mkdirSync(vscodePath, { recursive: true });
      let launchContent = fs.readFileSync(path.join(templatesDir, 'launch.json'), 'utf8');
      launchContent = launchContent.replace(/\{python_path\}/g, venvPython);
      launchContent = launchContent.replace(/\{odoo_bin_path\}/g, odooBin);
      fs.writeFileSync(path.join(vscodePath, 'launch.json'), launchContent, 'utf8');

      const settingsTemplate = path.join(templatesDir, 'settings.json');
      if (fs.existsSync(settingsTemplate)) {
        let settingsContent = fs.readFileSync(settingsTemplate, 'utf8');
        settingsContent = settingsContent.replace(/\{python_path\}/g, venvPython);
        fs.writeFileSync(path.join(vscodePath, 'settings.json'), settingsContent, 'utf8');
      }

      const confPath = path.join(proj, 'odoo.conf');
      if (fs.existsSync(confPath)) {
        let confContent = fs.readFileSync(confPath, 'utf8');
        confContent = confContent.replace(/^logfile\s*=\s*.+$/m, 'logfile = False');
        fs.writeFileSync(confPath, confContent, 'utf8');
      }

      ctx.logger.log(`Templates reset for project '${projectName}'.`);
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
      ctx.mainWindow.webContents.send('duplicate-progress', { step, done });
    };
    const result = await duplicateProject(baseDir, projectsDir, projectName, newName, newHttpPort, onProgress);
    invalidateStatusCache();
    return result;
  });

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
      const result = await ensurePgAndStartOdoo(ctx, {
        baseDir, projectPath: projPath, confFile: conf, odooSourceDir, cmd,
      });
      if (!result.ok) return result;

      // Start/reload Nginx for HTTPS proxy
      try {
        const { generateNginxConfig, startNginx, isNginxInstalled } = require('../utils/nginx');
        const { addHostEntry } = require('../utils/hosts');
        if (isNginxInstalled(baseDir)) {
          const { detectStatus } = require('../services/status');
          const status = await detectStatus(baseDir, projectsDir);
          const nginxProjects = (status.projects || [])
            .filter((p: any) => p.domain)
            .map((p: any) => ({ domain: p.domain, port: p.http_port, longpollingPort: p.longpolling_port }));
          let projectDomain = '';
          try {
            const raw = fs.readFileSync(conf, 'utf8');
            const dm = raw.match(/^;\s*project_domain\s*=\s*(.+)$/m);
            if (dm) projectDomain = dm[1].trim();
          } catch {}
          if (projectDomain && !nginxProjects.some((p: any) => p.domain === projectDomain)) {
            const httpPort = data?.http_port || '8069';
            const lpPort = String(parseInt(httpPort, 10) + 3);
            nginxProjects.push({ domain: projectDomain, port: httpPort, longpollingPort: lpPort });
          }
          for (const np of nginxProjects) {
            if (np.domain) addHostEntry(np.domain);
          }
          if (nginxProjects.length > 0) {
            await generateNginxConfig(baseDir, nginxProjects, ctx.logger);
            await startNginx(baseDir, ctx.logger);
            ctx.logger.log(`  > HTTPS: https://${projectDomain}`);
          }
        }
      } catch (e) {
        ctx.logger.log(`  > Nginx HTTPS proxy: ${e}`);
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
      const { output } = await runCmd(`netstat -ano | findstr ":${port}.*LISTENING"`);
      const lines = output.trim().split('\n').filter(Boolean);
      const pids = new Set<string>();
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== '0') pids.add(pid);
      }
      if (pids.size === 0) return { ok: true, msg: 'Not running' };
      for (const pid of pids) {
        await runCmd(`taskkill /F /PID ${pid}`);
      }
      ctx.logger.log(`Odoo stopped (killed PID: ${[...pids].join(', ')})`);
      invalidateStatusCache();
      return { ok: true, msg: 'Stopped' };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  });
}

/** Shared: Ensure PostgreSQL ready + start Odoo process */
export async function ensurePgAndStartOdoo(ctx: IpcContext, opts: {
  baseDir: string; projectPath: string; confFile: string;
  odooSourceDir: string; cmd: string;
}): Promise<{ ok: boolean; msg: string }> {
  const { baseDir, projectPath, confFile, odooSourceDir, cmd } = opts;

  let projectDbPort = '5434';
  let projectDbUser = 'odoo';
  let projectDbPassword = 'odoo';
  try {
    const { parseIniFile, iniGet } = require('../services/ini-parser');
    const ini = parseIniFile(confFile);
    projectDbPort = iniGet(ini, 'options', 'db_port', '5434');
    projectDbUser = iniGet(ini, 'options', 'db_user', 'odoo');
    projectDbPassword = iniGet(ini, 'options', 'db_password', 'odoo');
  } catch { /* use defaults */ }

  ctx.logger.log(`  > Project DB config: port=${projectDbPort}, user=${projectDbUser}`);

  const { findPostgresForPort, findPostgresBin, findDockerPostgres } = require('../services/detection');
  const pgInstance = findPostgresForPort(projectDbPort);
  const pgBin = pgInstance?.binPath || findPostgresBin();

  if (pgInstance) {
    ctx.logger.log(`  > PostgreSQL ${pgInstance.version} found for port ${projectDbPort}: ${pgInstance.binPath}`);
    const pgIsready = path.join(pgInstance.binPath, 'pg_isready.exe');
    let isReady = false;
    try {
      require('child_process').execSync(`"${pgIsready}" -p ${projectDbPort}`, { timeout: 5000, windowsHide: true, stdio: 'pipe' });
      isReady = true;
    } catch { /* not ready */ }

    if (!isReady) {
      ctx.logger.log(`PostgreSQL ${pgInstance.version} is stopped on port ${projectDbPort}. Starting...`);
      let started = false;
      for (const svc of [pgInstance.serviceName, `postgresql-${pgInstance.version}`]) {
        const { code } = await runCmd(`net start "${svc}"`);
        if (code === 0) { ctx.logger.log(`  > Service '${svc}' started!`); started = true; break; }
      }
      if (!started && pgInstance.dataDir) {
        const pgCtl = path.join(pgInstance.binPath, 'pg_ctl.exe');
        const { code } = await runCmd(`"${pgCtl}" start -D "${pgInstance.dataDir}" -w`);
        if (code === 0) { ctx.logger.log('  > PostgreSQL started via pg_ctl!'); started = true; }
      }
      if (started) await new Promise(r => setTimeout(r, 3000));
      else ctx.logger.log('  > Could not start PostgreSQL. Start it manually.');
    }
  } else if (pgBin) {
    ctx.logger.log(`  > No PostgreSQL instance found for port ${projectDbPort}. Using bin: ${pgBin}`);
  } else {
    ctx.logger.log('  > No native PostgreSQL found.');
  }

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
    if (dockerMatch) { ctx.logger.log(`  > Using Docker PostgreSQL: ${dockerMatch.name}`); pgReady = true; }
  }
  if (!pgReady) {
    return { ok: false, msg: `PostgreSQL is not running on port ${projectDbPort}. Check your DB port in odoo.conf.` };
  }

  if (pgBin) {
    const psqlExe = path.join(pgBin, 'psql.exe');
    const safeId = /^[a-zA-Z0-9_]+$/;
    if (safeId.test(projectDbUser) && safeId.test(projectDbPassword)) {
      const { output: userCheck } = await runCmd(
        `"${psqlExe}" -U postgres -p ${projectDbPort} -tAc "SELECT 1 FROM pg_roles WHERE rolname='${projectDbUser}'"`,
        undefined, { ...process.env, PGPASSWORD: 'postgres' }
      );
      if (!userCheck.includes('1')) {
        ctx.logger.log(`  > Creating DB user '${projectDbUser}'...`);
        await runCmd(
          `"${psqlExe}" -U postgres -p ${projectDbPort} -c "CREATE ROLE ${projectDbUser} WITH LOGIN PASSWORD '${projectDbPassword}' CREATEDB;"`,
          undefined, { ...process.env, PGPASSWORD: 'postgres' }
        );
      }
    }
  }

  const odooEnv = { ...process.env };
  if (pgBin && !odooEnv.PATH?.includes(pgBin)) {
    odooEnv.PATH = `${pgBin};${odooEnv.PATH || ''}`;
  }

  ctx.logger.log(`Starting Odoo: ${cmd}`);
  const { exec: execChild } = require('child_process');
  const odooProc = execChild(cmd, {
    cwd: projectPath, windowsHide: true, maxBuffer: 10 * 1024 * 1024, env: odooEnv,
  });
  odooProc.stdout?.on('data', (d: string) => {
    for (const line of d.toString().split('\n').filter(Boolean)) ctx.logger.log(`[odoo] ${line.trim()}`);
  });
  odooProc.stderr?.on('data', (d: string) => {
    for (const line of d.toString().split('\n').filter(Boolean)) ctx.logger.log(`[odoo:err] ${line.trim()}`);
  });
  odooProc.on('exit', (code: number | null) => {
    if (code !== null && code !== 0) ctx.logger.log(`[odoo] Process exited with code ${code}`);
  });

  invalidateStatusCache();
  return { ok: true, msg: 'Started' };
}

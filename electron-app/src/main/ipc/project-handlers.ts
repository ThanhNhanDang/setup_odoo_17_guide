import { ipcMain, dialog } from 'electron';
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
    const odooVersion = data?.odoo_version || '17';
    const baseDir = data?.base_dir || getDefaultBaseDir(odooVersion);
    const projectsDir = data?.projects_dir || getDefaultProjectsDir(odooVersion);
    const projectName = data?.project_name || '';
    const newName = data?.new_name || '';
    const newHttpPort = data?.new_http_port || '8070';
    const onProgress = (step: string, done: boolean) => {
      ctx.mainWindow.webContents.send('duplicate-progress', { step, done });
    };
    const result = await duplicateProject(baseDir, projectsDir, projectName, newName, newHttpPort, onProgress, odooVersion);
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
        const { generateNginxConfig, startNginx, isNginxInstalled, findNginxAcrossBaseDirs } = require('../utils/nginx');
        const { ALL_VERSIONS } = require('../services/odoo-versions');
        const { getDefaultBaseDir } = require('../services/config');
        const { addHostEntry } = require('../utils/hosts');
        // Find Nginx in current or any version's base dir
        const nginxBaseDir = isNginxInstalled(baseDir)
          ? baseDir
          : findNginxAcrossBaseDirs(ALL_VERSIONS.map((v: string) => getDefaultBaseDir(v)));
        if (nginxBaseDir) {
          const { detectStatus } = require('../services/status');
          const { getDefaultProjectsDir } = require('../services/config');
          // Collect projects from ALL versions for Nginx (shared proxy)
          const nginxProjects: { domain: string; port: string; longpollingPort: string }[] = [];
          for (const v of ALL_VERSIONS) {
            const vProjDir = getDefaultProjectsDir(v);
            try {
              const vStatus = await detectStatus(getDefaultBaseDir(v), vProjDir);
              for (const p of (vStatus.projects || [])) {
                if (p.domain) nginxProjects.push({ domain: p.domain, port: p.http_port, longpollingPort: p.longpolling_port });
              }
            } catch { /* skip */ }
          }
          // Add current project domain if not already in list
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
            await generateNginxConfig(nginxBaseDir, nginxProjects, ctx.logger);
            await startNginx(nginxBaseDir, ctx.logger);
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

  // Auto-upgrade workers=0 → workers=2 for legacy projects
  try {
    const { parseIniFile, iniGet, iniSet, stringifyIni } = require('../services/ini-parser');
    const ini = parseIniFile(confFile);
    const currentWorkers = iniGet(ini, 'options', 'workers', '0');
    if (currentWorkers === '0') {
      ctx.logger.log('  > Upgrading workers=0 → workers=2 for better performance...');
      const updated = iniSet(ini, 'options', 'workers', '2');
      // Preserve comment lines (project_domain, odoo_version) at top of file
      const rawConf = fs.readFileSync(confFile, 'utf8');
      const commentLines = rawConf.split('\n').filter((l: string) => l.startsWith(';'));
      const newContent = commentLines.length > 0
        ? commentLines.join('\n') + '\n' + stringifyIni(updated)
        : stringifyIni(updated);
      fs.writeFileSync(confFile, newContent, 'utf8');
      ctx.logger.log('  > odoo.conf updated: workers=2');
    }
  } catch (e) {
    ctx.logger.log(`  > Auto-upgrade workers check failed: ${e}`);
  }

  const odooEnv = { ...process.env };
  // Isolate PYTHONPATH — remove paths from other Odoo versions to prevent
  // cross-version module loading (e.g. odoo_18_base addons loaded in v19 process)
  if (odooEnv.PYTHONPATH) {
    const baseDirNorm = baseDir.replace(/\\/g, '/').toLowerCase();
    odooEnv.PYTHONPATH = odooEnv.PYTHONPATH.split(';')
      .filter(p => {
        const norm = p.replace(/\\/g, '/').toLowerCase();
        // Keep paths that are: in current baseDir, or not in any odoo base dir
        return norm.includes(baseDirNorm) || !norm.includes('odoo_') || !norm.includes('_base');
      })
      .join(';') || '';
  }
  if (pgBin && !odooEnv.PATH?.includes(pgBin)) {
    odooEnv.PATH = `${pgBin};${odooEnv.PATH || ''}`;
  }
  // Add wkhtmltopdf to PATH if installed but not already in PATH
  const wkhtmlBin = 'C:\\Program Files\\wkhtmltopdf\\bin';
  if (fs.existsSync(path.join(wkhtmlBin, 'wkhtmltopdf.exe')) && !odooEnv.PATH?.includes(wkhtmlBin)) {
    odooEnv.PATH = `${wkhtmlBin};${odooEnv.PATH || ''}`;
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

// --- Pick & Save Logo ---
export function registerLogoHandlers(ctx: IpcContext): void {
  ipcMain.handle('pick-logo', async (_event, data: Record<string, string>) => {
    const projectsDir = data?.projects_dir || DEFAULT_PROJECTS_DIR;
    const projectName = data?.project_name || '';
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: 'Select Project Logo',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'svg', 'webp'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false };
    const src = result.filePaths[0];
    try {
      const destDir = projectName ? path.join(projectsDir, projectName) : '';
      if (destDir && fs.existsSync(destDir)) {
        fs.copyFileSync(src, path.join(destDir, 'logo.png'));
        invalidateStatusCache();
      }
      const buf = fs.readFileSync(src);
      return { ok: true, dataUrl: `data:image/png;base64,${buf.toString('base64')}` };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  });

  ipcMain.handle('save-logo', async (_event, data: { projects_dir: string; project_name: string; dataUrl: string }) => {
    const projectDir = path.join(data.projects_dir, data.project_name);
    if (!fs.existsSync(projectDir)) return { ok: false, msg: 'Project not found' };
    try {
      const base64 = data.dataUrl.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(path.join(projectDir, 'logo.png'), Buffer.from(base64, 'base64'));
      invalidateStatusCache();
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  });
}

import * as fs from 'fs';
import * as path from 'path';
import { LoggerService } from './logger';
import {
  PYTHON_311_URL,
  POSTGRES_URL,
  VSCODE_URL,
  GIT_URL,
  ODOO_GIT_URL,
  ODOO_BRANCH,
  PROJECT_DEFAULTS,
  getTemplatesDir,
} from './config';
import { findPython311, findPostgresBin, findDocker, findDockerPostgres, findVSCode, findGit } from './detection';
import { runCmd, runCmdStreaming } from '../utils/shell';
import { downloadFile } from '../utils/download';
import { installNginx, isNginxInstalled } from '../utils/nginx';
import { StepLockManager } from './step-lock';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

interface StepResult {
  readonly ok: boolean;
  readonly msg: string;
}

// ---------------------------------------------------------------------------
// Installation Steps
// Ports: step_install_python, step_install_postgres, step_create_pg_user,
//        step_clone_odoo, step_create_venv, step_install_requirements,
//        step_create_project, step_full_install
// ---------------------------------------------------------------------------

export async function stepInstallNginx(baseDir: string, logger: LoggerService): Promise<StepResult> {
  if (isNginxInstalled(baseDir)) {
    logger.log('Nginx already installed.');
    return { ok: true, msg: 'Already installed' };
  }
  const success = await installNginx(baseDir, logger);
  return success
    ? { ok: true, msg: 'Installed' }
    : { ok: false, msg: 'Download failed' };
}

export async function stepInstallGit(baseDir: string, logger: LoggerService): Promise<StepResult> {
  // Check PATH first
  if (findGit()) {
    logger.log(`Git already installed (${findGit()}).`);
    return { ok: true, msg: `Already installed (${findGit()})` };
  }
  // Check file-based (PATH may not be updated yet)
  const gitExe = 'C:\\Program Files\\Git\\cmd\\git.exe';
  if (fs.existsSync(gitExe)) {
    process.env.PATH = `C:\\Program Files\\Git\\cmd;${process.env.PATH}`;
    logger.log('Git found at ' + gitExe);
    return { ok: true, msg: 'Already installed' };
  }

  logger.log('Downloading Git for Windows...');
  fs.mkdirSync(baseDir, { recursive: true });
  const installer = path.join(baseDir, 'git-installer.exe');
  try {
    await downloadFile(GIT_URL, installer, logger, 'install_git');
  } catch (e) {
    return { ok: false, msg: `Download failed: ${e}` };
  }
  logger.log('Installing Git (silent)...');
  // /CLOSEAPPLICATIONS kills running git processes to avoid conflict
  await runCmd(`"${installer}" /VERYSILENT /NORESTART /NOCANCEL /SP- /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS /COMPONENTS="icons,ext\\reg\\shellhere,assoc,assoc_sh"`);
  await new Promise(resolve => setTimeout(resolve, 5000));
  // Add to PATH for current process
  if (fs.existsSync(gitExe)) {
    process.env.PATH = `C:\\Program Files\\Git\\cmd;${process.env.PATH}`;
    logger.log('Git installed!');
    return { ok: true, msg: 'Installed' };
  }
  return { ok: false, msg: 'Install may need admin rights.' };
}

export async function stepInstallVSCode(baseDir: string, logger: LoggerService): Promise<StepResult> {
  if (findVSCode()) {
    logger.log('VS Code already installed.');
    return { ok: true, msg: 'Already installed' };
  }
  logger.log('Downloading VS Code (latest stable)...');
  fs.mkdirSync(baseDir, { recursive: true });
  const installer = path.join(baseDir, 'vscode-installer.exe');
  try {
    await downloadFile(VSCODE_URL, installer, logger, 'install_vscode');
  } catch (e) {
    return { ok: false, msg: `Download failed: ${e}` };
  }
  logger.log('Installing VS Code (silent, user-level)...');
  // User installer: no admin needed, installs to %LOCALAPPDATA%
  // /VERYSILENT = no UI, /MERGETASKS = add to PATH + context menu + file associations
  await runCmd(
    `"${installer}" /VERYSILENT /NORESTART /CURRENTUSER /MERGETASKS="!runcode,addcontextmenufiles,addcontextmenufolders,associatewithfiles,addtopath"`
  );
  // Wait for installer to finish
  await new Promise(resolve => setTimeout(resolve, 5000));
  if (findVSCode()) {
    logger.log('VS Code installed!');
    return { ok: true, msg: 'Installed' };
  }
  // Even if detection fails, installer may have succeeded (PATH not updated in current process)
  if (fs.existsSync('C:\\Program Files\\Microsoft VS Code\\Code.exe') ||
      fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'))) {
    logger.log('VS Code installed! (restart app to detect in PATH)');
    return { ok: true, msg: 'Installed (restart to detect in PATH)' };
  }
  return { ok: false, msg: 'Install may need admin rights.' };
}

export async function stepInstallPython(baseDir: string, logger: LoggerService): Promise<StepResult> {
  if (findPython311()) {
    logger.log('Python 3.11 already installed.');
    return { ok: true, msg: 'Already installed' };
  }
  logger.log('Downloading Python 3.11.4...');
  fs.mkdirSync(baseDir, { recursive: true });
  const installer = path.join(baseDir, 'python-3.11.4-amd64.exe');
  try {
    await downloadFile(PYTHON_311_URL, installer, logger, 'install_python');
  } catch (e) {
    return { ok: false, msg: `Download failed: ${e}` };
  }
  logger.log('Installing Python 3.11.4 (silent)...');
  await runCmd(`"${installer}" /quiet InstallAllUsers=0 PrependPath=0 Include_launcher=1 Include_pip=1`);
  // Wait for installation to finish
  await new Promise(resolve => setTimeout(resolve, 5000));
  if (findPython311()) {
    logger.log('Python 3.11.4 installed!');
    return { ok: true, msg: 'Installed' };
  }
  return { ok: false, msg: 'Install may need admin rights. Run as Administrator.' };
}

export async function stepInstallPostgres(
  baseDir: string,
  logger: LoggerService,
  pgSuperPassword: string = 'postgres',
  dbPort: string = '5432',
  dbUser: string = 'odoo',
  dbPassword: string = 'odoo',
  pgMode: string = 'auto',
): Promise<StepResult> {
  // Check existing installations
  const hasNative = findPostgresBin() !== null;
  const dockerPg = findDockerPostgres();
  const hasDocker = dockerPg.length > 0;

  if (hasNative && pgMode !== 'docker') {
    logger.log('PostgreSQL already installed locally.');
    return { ok: true, msg: 'Already installed (local)' };
  }
  if (hasDocker && pgMode !== 'native') {
    logger.log(`PostgreSQL running in Docker: ${dockerPg.map(c => c.name).join(', ')}`);
    return { ok: true, msg: 'Already running (Docker)' };
  }

  // Install based on mode
  if (pgMode === 'docker' || (pgMode === 'auto' && findDocker())) {
    if (!findDocker()) {
      return { ok: false, msg: 'Docker not available. Install Docker Desktop or choose Native mode.' };
    }
    const cname = `odoo-postgres-${dbPort}`;
    logger.log(`Creating PostgreSQL 16 Docker container '${cname}'...`);
    const { code, output } = await runCmd(
      `docker run -d --name ${cname} -e POSTGRES_USER=${dbUser} -e POSTGRES_PASSWORD=${dbPassword} ` +
      `-e POSTGRES_DB=postgres -p ${dbPort}:5432 --restart unless-stopped postgres:16`
    );
    if (code === 0) {
      // Wait for PostgreSQL to be ready
      logger.log(`  > Waiting for PostgreSQL container to start...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      logger.log(`Docker container '${cname}' started on port ${dbPort}!`);
      return { ok: true, msg: `Docker container '${cname}' on port ${dbPort}` };
    }
    if (pgMode === 'docker') {
      return { ok: false, msg: `Docker failed: ${output.trim().split('\n').pop()}` };
    }
    logger.log('  > Docker container creation failed, falling back to native install...');
  }

  // Native install
  if (pgMode === 'native' || pgMode === 'auto') {
    logger.log('Downloading PostgreSQL 16 (native installer)...');
    fs.mkdirSync(baseDir, { recursive: true });
    const installer = path.join(baseDir, 'postgresql-16-installer.exe');
    try {
      await downloadFile(POSTGRES_URL, installer, logger, 'install_postgres');
    } catch (e) {
      return { ok: false, msg: `Download failed: ${e}` };
    }
    logger.log('Installing PostgreSQL 16 (this may take a few minutes)...');
    const { code, output } = await runCmd(
      `"${installer}" --mode unattended --superpassword "${pgSuperPassword}" --servicename postgresql-16 ` +
      `--servicepassword "${pgSuperPassword}" --serverport ${dbPort} --prefix "C:\\Program Files\\PostgreSQL\\16"`
    );
    logger.log(`  > Installer exit code: ${code}`);
    await new Promise(resolve => setTimeout(resolve, 10000));
    if (findPostgresBin()) {
      // Start service + set to auto-start on boot
      logger.log('  > Starting PostgreSQL service...');
      await runCmd(`net start postgresql-16`);
      await runCmd(`sc.exe config postgresql-16 start=auto`);
      // Also try with -x64 suffix
      await runCmd(`net start postgresql-x64-16`);
      await runCmd(`sc.exe config postgresql-x64-16 start=auto`);
      await new Promise(resolve => setTimeout(resolve, 3000));
      logger.log('  > PostgreSQL service started and set to auto-start.');
      return { ok: true, msg: 'Installed (native)' };
    }
    return { ok: false, msg: 'Install failed. Run as Administrator.' };
  }

  return { ok: false, msg: 'No PostgreSQL installation method available.' };
}

export async function stepCreatePgUser(
  logger: LoggerService,
  dbUser: string = 'odoo',
  dbPassword: string = 'odoo',
  dbPort: string = '5432',
  pgSuperPassword: string = 'postgres',
  pgMode: string = 'auto',
): Promise<StepResult> {
  // Docker: only check if mode is docker or auto
  if (pgMode === 'docker' || pgMode === 'auto') {
    const dockerPg = findDockerPostgres();
    // Only use Docker containers that were created by this installer (odoo-postgres-*)
    // or if mode is explicitly 'docker'
    for (const c of dockerPg) {
      if (c.port !== dbPort) continue;
      const cname = c.name.replace(/"/g, '');

      // Skip non-odoo containers in auto mode (e.g. reelmind-db belongs to other project)
      if (pgMode === 'auto' && !cname.startsWith('odoo-postgres')) {
        logger.log(`  > Skipping Docker container '${cname}' (not created by this installer)`);
        continue;
      }

      logger.log(`  > Using Docker container '${cname}' on port ${dbPort}...`);
      const { output: checkOut } = await runCmd(
        `docker exec ${cname} psql -U postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='${dbUser}'"`
      );
      if (checkOut.includes('1')) {
        return { ok: true, msg: `User exists (Docker: ${cname})` };
      }
      logger.log(`  > Creating user '${dbUser}' in Docker container '${cname}'...`);
      const { code, output } = await runCmd(
        `docker exec ${cname} sh -c "psql -U postgres -c \\"CREATE ROLE ${dbUser} WITH LOGIN PASSWORD '${dbPassword}' CREATEDB;\\""`
      );
      if (code === 0) {
        return { ok: true, msg: `User created (Docker: ${cname})` };
      }
      logger.log(`  > Docker exec failed: ${output.trim()}`);
    }
    if (pgMode === 'docker') {
      return { ok: false, msg: 'No matching Docker PostgreSQL container found on port ' + dbPort };
    }
  }

  // Native PostgreSQL
  const pgBin = findPostgresBin();
  if (!pgBin) {
    return { ok: false, msg: 'PostgreSQL not found' };
  }
  const psql = path.join(pgBin, 'psql.exe');
  const env = { ...process.env, PGPASSWORD: pgSuperPassword };

  logger.log(`  > Checking if user '${dbUser}' exists...`);
  try {
    const { output: checkOut } = await runCmd(
      `"${psql}" -U postgres -p ${dbPort} -tAc "SELECT 1 FROM pg_roles WHERE rolname='${dbUser}'"`,
      undefined, env
    );
    if (checkOut.includes('1')) {
      return { ok: true, msg: 'User already exists' };
    }
  } catch (e) {
    logger.log(`    [ERROR] ${e}`);
  }

  logger.log(`  > Creating user '${dbUser}'...`);
  try {
    const { code, output } = await runCmd(
      `"${psql}" -U postgres -p ${dbPort} -c "CREATE ROLE ${dbUser} WITH LOGIN PASSWORD '${dbPassword}' CREATEDB;"`,
      undefined, env
    );
    if (code === 0) {
      return { ok: true, msg: 'User created' };
    }
    return { ok: false, msg: `Failed: ${output}` };
  } catch (e) {
    return { ok: false, msg: `Failed: ${e}` };
  }
}

export async function stepCloneOdoo(baseDir: string, logger: LoggerService): Promise<StepResult> {
  fs.mkdirSync(baseDir, { recursive: true });
  const odooBin = path.join(baseDir, 'odoo', 'odoo-bin');
  if (fs.existsSync(odooBin)) {
    logger.log('Odoo source already cloned.');
    return { ok: true, msg: 'Already cloned' };
  }
  logger.log('Cloning Odoo 17.0 (shallow clone)...');
  const code = await runCmdStreaming(
    `git clone --progress --branch ${ODOO_BRANCH} --single-branch --depth 1 ${ODOO_GIT_URL}`,
    logger,
    {
      cwd: baseDir,
      onData: (line) => {
        // Parse git clone progress: "Receiving objects:  45% (1234/2740)"
        const match = line.match(/(\w[\w ]+):\s+(\d+)%/);
        if (match) {
          const phase = match[1]; // "Receiving objects", "Resolving deltas"
          const pct = parseInt(match[2], 10);
          // Map git phases to overall progress: Receiving 0-80%, Resolving 80-100%
          const overall = phase.includes('Resolving')
            ? 80 + Math.round(pct * 0.2)
            : Math.round(pct * 0.8);
          logger.emitDownloadProgress({
            step: 'clone_odoo',
            percent: overall,
            downloadedMB: `${phase}`,
            totalMB: `${pct}%`,
          });
        }
      },
    }
  );
  if (fs.existsSync(odooBin)) {
    return { ok: true, msg: 'Cloned' };
  }
  return { ok: false, msg: `Clone failed (exit code: ${code})` };
}

export async function stepCreateVenv(baseDir: string, logger: LoggerService): Promise<StepResult> {
  const venvDir = path.join(baseDir, 'venv');
  const venvPython = path.join(venvDir, 'Scripts', 'python.exe');
  const pythonPath = findPython311();
  logger.log(`  > Python 3.11 path: ${pythonPath || 'NOT FOUND'}`);
  if (!pythonPath) {
    return { ok: false, msg: 'Python 3.11 not found. Install Python first.' };
  }
  if (fs.existsSync(venvPython)) {
    const { output } = await runCmd(`"${venvPython}" --version`);
    logger.log(`  > Existing venv python: ${output.trim()}`);
    if (output.includes('3.11')) {
      return { ok: true, msg: 'Already exists' };
    }
    logger.log('  > Wrong Python version in venv, recreating...');
    fs.rmSync(venvDir, { recursive: true, force: true });
  }
  logger.log(`Creating virtual environment at ${venvDir}...`);
  const { code, output } = await runCmd(`"${pythonPath}" -m venv "${venvDir}"`);
  logger.log(`  > venv command exit code: ${code}`);
  if (output.trim()) {
    for (const line of output.trim().split('\n').slice(-5)) {
      logger.log(`    ${line.trim()}`);
    }
  }
  if (fs.existsSync(venvPython)) {
    return { ok: true, msg: 'Created' };
  }
  return { ok: false, msg: `Failed to create venv (exit code: ${code}). Check Python 3.11 installation.` };
}

export async function stepInstallRequirements(baseDir: string, logger: LoggerService): Promise<StepResult> {
  const pipExe = path.join(baseDir, 'venv', 'Scripts', 'pip.exe');
  const reqFile = path.join(baseDir, 'odoo', 'requirements.txt');
  if (!fs.existsSync(pipExe)) {
    return { ok: false, msg: 'Venv not found.' };
  }
  if (!fs.existsSync(reqFile)) {
    return { ok: false, msg: 'requirements.txt not found.' };
  }
  logger.log('Installing dependencies...');
  // Count total packages for progress tracking
  const reqLines = fs.readFileSync(reqFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.trim().startsWith('#'));
  const totalPkgs = reqLines.length || 1;
  let installedCount = 0;
  let success = false;

  const code = await runCmdStreaming(
    `"${pipExe}" install -r "${reqFile}"`,
    logger,
    {
      onData: (line) => {
        // Track "Successfully installed ..." or "Collecting ..." or "Downloading ..."
        if (line.startsWith('Collecting') || line.startsWith('Downloading') || line.match(/^Installing collected/)) {
          installedCount++;
          const pct = Math.min(99, Math.round((installedCount / totalPkgs) * 100));
          logger.emitDownloadProgress({
            step: 'install_requirements',
            percent: pct,
            downloadedMB: `${installedCount}`,
            totalMB: `${totalPkgs} pkgs`,
          });
        }
        if (line.includes('Successfully installed')) {
          success = true;
          logger.emitDownloadProgress({
            step: 'install_requirements',
            percent: 100,
            downloadedMB: `${totalPkgs}`,
            totalMB: `${totalPkgs} pkgs`,
          });
        }
      },
    }
  );

  if (code === 0 || success) {
    return { ok: true, msg: 'Installed' };
  }
  return { ok: false, msg: 'Failed. Check logs.' };
}

export async function stepCreateProject(
  baseDir: string,
  projectsDir: string,
  projectName: string,
  logger: LoggerService,
  opts: Record<string, string> = {},
): Promise<StepResult> {
  fs.mkdirSync(projectsDir, { recursive: true });
  const proj = path.join(projectsDir, projectName);

  if (!projectName.trim()) {
    return { ok: false, msg: 'Project name is required' };
  }
  if (fs.existsSync(path.join(proj, 'odoo.conf'))) {
    return { ok: false, msg: `Project '${projectName}' already exists` };
  }

  logger.log(`Creating project '${projectName}'...`);
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(path.join(proj, 'addons'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.vscode'), { recursive: true });

  // Junction link
  const odooLink = path.join(proj, 'odoo');
  const odooSource = path.join(baseDir, 'odoo');
  if (!fs.existsSync(odooLink)) {
    await runCmd(`cmd /c mklink /J "${odooLink}" "${odooSource}"`);
    if (!fs.existsSync(odooLink)) {
      return { ok: false, msg: 'Failed to create symlink. Run as Administrator.' };
    }
  }

  // Build config values with defaults
  const cfg: Record<string, string> = { ...PROJECT_DEFAULTS };
  for (const [k, v] of Object.entries(opts)) {
    if (v) cfg[k] = v;
  }
  if (!cfg.longpolling_port) {
    const httpPort = parseInt(cfg.http_port, 10);
    cfg.longpolling_port = isNaN(httpPort) ? '8072' : String(httpPort + 3);
  }

  // Log file in project directory
  cfg.logfile = path.join(proj, 'odoo.log').replace(/\\/g, '/');

  // Per-project domain (isolate browser sessions)
  const { projectToDomain, addHostEntry } = require('../utils/hosts');
  const projectDomain = opts.project_domain || projectToDomain(projectName);
  cfg.project_domain = projectDomain;

  // Auto-set dbfilter from domain's first subdomain (DB isolation without manual config)
  // e.g. "test.odoo.local" → dbfilter "^test.*$", "w2.odoo.local" → "^w2.*$"
  if (!cfg.dbfilter) {
    const firstSubdomain = projectDomain.split('.')[0];
    cfg.dbfilter = `^${firstSubdomain}.*$`;
  }

  // odoo.conf from template
  const templatesDir = getTemplatesDir();
  const confTemplate = fs.readFileSync(path.join(templatesDir, 'odoo.conf'), 'utf8');
  // Replace {key} placeholders with config values
  let confContent = confTemplate;
  for (const [key, value] of Object.entries(cfg)) {
    confContent = confContent.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  // Replace {project_name} for dbfilter
  confContent = confContent.replace(/\{project_name\}/g, projectName);
  fs.writeFileSync(path.join(proj, 'odoo.conf'), confContent, 'utf8');

  // launch.json from template
  const venvPython = path.join(baseDir, 'venv', 'Scripts', 'python.exe').replace(/\\/g, '\\\\');
  const odooBin = path.join(baseDir, 'odoo', 'odoo-bin').replace(/\\/g, '\\\\');
  let launchContent = fs.readFileSync(path.join(templatesDir, 'launch.json'), 'utf8');
  launchContent = launchContent.replace(/\{python_path\}/g, venvPython);
  launchContent = launchContent.replace(/\{odoo_bin_path\}/g, odooBin);
  fs.writeFileSync(path.join(proj, '.vscode', 'launch.json'), launchContent, 'utf8');

  // settings.json - force VS Code to use venv Python interpreter
  const settingsTemplate = path.join(templatesDir, 'settings.json');
  if (fs.existsSync(settingsTemplate)) {
    let settingsContent = fs.readFileSync(settingsTemplate, 'utf8');
    settingsContent = settingsContent.replace(/\{python_path\}/g, venvPython);
    fs.writeFileSync(path.join(proj, '.vscode', 'settings.json'), settingsContent, 'utf8');
  }

  // Add domain to hosts file
  const hostsResult = addHostEntry(projectDomain);
  if (hostsResult.ok) {
    logger.log(`  > Domain '${projectDomain}' added to hosts file.`);
  } else {
    logger.log(`  > Could not add domain to hosts: ${hostsResult.msg}`);
  }

  logger.log(`Project '${projectName}' ready at ${proj}`);
  logger.log(`  > URL: http://${projectDomain}:${cfg.http_port}`);
  return { ok: true, msg: proj };
}

// ---------------------------------------------------------------------------
// Full Install Orchestrator
// ---------------------------------------------------------------------------

interface FullInstallResult {
  readonly step: string;
  readonly ok: boolean;
  readonly msg: string;
}

/**
 * Run a named step with lock support.
 * If step is already locked (running via run_step), wait for its result instead of re-running.
 */
async function runNamedStep(
  label: string,
  stepId: string,
  fn: () => Promise<StepResult>,
  logger: LoggerService,
  lock: StepLockManager,
): Promise<FullInstallResult> {
  // If already running (e.g. user clicked individual step), wait for that result
  if (lock.isLocked(stepId)) {
    logger.log('');
    logger.log(`>> ${label} - already running, waiting for result...`);
    const existing = await lock.getResult(stepId);
    const result = existing || { ok: true, msg: 'Already handled' };
    logger.log(`[OK] ${label} - ${result.msg} (from individual step)`);
    return { step: label, ok: result.ok, msg: result.msg };
  }

  // Normal: acquire lock, run, release
  logger.updateTask({ status: 'running', step: label, progress: 0 });
  logger.log('');
  logger.log(`>> ${label}`);

  const promise = fn();
  lock.acquire(stepId, 'full_install', promise);
  try {
    const result = await promise;
    if (!result.ok) {
      logger.log(`[WARN] ${label} - ${result.msg}`);
    } else {
      logger.log(`[OK] ${label} - ${result.msg}`);
    }
    return { step: label, ok: result.ok, msg: result.msg };
  } finally {
    lock.release(stepId);
  }
}

/**
 * Full Install Orchestrator - pipeline with maximum parallelism.
 *
 * Pipeline:
 *   1. Git + VS Code + Python + PostgreSQL (all parallel)
 *   2. Git done → Clone Odoo (parallel with others still running)
 *   3. Python done → Create Venv
 *   4. Venv + Odoo done → Pip Install
 *   5. Create Project (no need to wait for PG - checked at Start Odoo)
 *   6. DB User created when PG ready (parallel with pip)
 *
 * PostgreSQL is NOT blocking - it's checked when user clicks "Start Odoo".
 */
export async function stepFullInstall(
  baseDir: string,
  projectsDir: string,
  projectName: string,
  logger: LoggerService,
  opts: Record<string, string> = {},
  lock: StepLockManager = new StepLockManager(),
): Promise<readonly FullInstallResult[]> {
  fs.mkdirSync(baseDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });

  const dbPort = opts.db_port || '5434';
  const dbUser = opts.db_user || 'odoo';
  const dbPassword = opts.db_password || 'odoo';
  const pgSuperPassword = opts.pg_super_password || 'postgres';
  const pgMode = opts.pg_mode || 'auto';
  const results: FullInstallResult[] = [];

  // ── Start all independent downloads/installs at once ──
  logger.log('==================================================');
  logger.log('Starting parallel installation pipeline...');
  logger.log('==================================================');

  // Fire all independent tasks simultaneously (with lock support)
  const gitPromise = runNamedStep('Installing Git...', 'install_git', () => stepInstallGit(baseDir, logger), logger, lock);
  const vscodePromise = runNamedStep('Installing VS Code...', 'install_vscode', () => stepInstallVSCode(baseDir, logger), logger, lock);
  const pythonPromise = runNamedStep('Installing Python 3.11...', 'install_python', () => stepInstallPython(baseDir, logger), logger, lock);
  const pgPromise = runNamedStep('Installing PostgreSQL...', 'install_postgres', () => stepInstallPostgres(baseDir, logger, pgSuperPassword, dbPort, dbUser, dbPassword, pgMode), logger, lock);
  const nginxPromise = runNamedStep('Installing Nginx (HTTPS)...', 'install_nginx', () => stepInstallNginx(baseDir, logger), logger, lock);

  // ── Chain: Git done → Clone Odoo ──
  const clonePromise = gitPromise.then(gitResult => {
    results.push(gitResult);
    logger.updateTask({ status: 'running', step: 'Cloning Odoo 17...', progress: 20 });
    return runNamedStep('Cloning Odoo 17...', 'clone_odoo', () => stepCloneOdoo(baseDir, logger), logger, lock);
  });

  // ── Chain: Python done → Venv → Pip Install ──
  const pipPromise = pythonPromise.then(async pyResult => {
    results.push(pyResult);
    logger.updateTask({ status: 'running', step: 'Creating venv...', progress: 30 });
    const venvResult = await runNamedStep('Creating virtual environment...', 'create_venv', () => stepCreateVenv(baseDir, logger), logger, lock);
    results.push(venvResult);

    // Wait for Odoo clone too (need requirements.txt)
    const cloneResult = await clonePromise;
    results.push(cloneResult);
    logger.updateTask({ status: 'running', step: 'Installing pip requirements...', progress: 50 });
    return runNamedStep('Installing requirements...', 'install_requirements', () => stepInstallRequirements(baseDir, logger), logger, lock);
  });

  // ── Chain: PG done → Create DB User ──
  const dbUserPromise = pgPromise.then(pgResult => {
    results.push(pgResult);
    logger.updateTask({ status: 'running', step: 'Creating DB user...', progress: 60 });
    return runNamedStep('Creating DB user...', 'create_db_user', () => stepCreatePgUser(logger, dbUser, dbPassword, dbPort, pgSuperPassword, pgMode), logger, lock);
  });

  // ── Wait for VS Code + Nginx (independent, just collect results) ──
  const vscodeResult = await vscodePromise;
  results.push(vscodeResult);
  const nginxResult = await nginxPromise;
  results.push(nginxResult);

  // ── Wait for pip + DB user (parallel) ──
  const [pipResult, dbUserResult] = await Promise.all([pipPromise, dbUserPromise]);
  results.push(pipResult);
  results.push(dbUserResult);
  // ── Done ──
  const allOk = results.every(r => r.ok);
  const failCount = results.filter(r => !r.ok).length;
  logger.log('');
  logger.log('==================================================');
  logger.log(allOk ? 'All steps completed successfully!' : `Completed with ${failCount} warning(s).`);
  logger.log('==================================================');

  logger.updateTask({
    status: 'done',
    step: 'Complete!',
    progress: 100,
    results,
  });

  return results;
}

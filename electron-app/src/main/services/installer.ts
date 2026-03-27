import * as fs from 'fs';
import * as path from 'path';
import { LoggerService } from './logger';
import {
  VSCODE_URL,
  GIT_URL,
  ODOO_GIT_URL,
  PROJECT_DEFAULTS,
  getTemplatesDir,
} from './config';
import { getVersionConfig, getPythonCandidates, DEFAULT_ODOO_VERSION } from './odoo-versions';
import { findPython, findPythonViaLauncher, findPostgresBin, findDocker, findDockerPostgres, findVSCode, findGit } from './detection';
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

export async function stepInstallPython(baseDir: string, logger: LoggerService, odooVersion: string = DEFAULT_ODOO_VERSION): Promise<StepResult> {
  const vCfg = getVersionConfig(odooVersion);
  const candidates = getPythonCandidates(odooVersion);
  if (findPython(candidates)) {
    logger.log(`${vCfg.pythonVersion} already installed.`);
    return { ok: true, msg: 'Already installed' };
  }
  const installerName = path.basename(new URL(vCfg.pythonUrl).pathname);
  logger.log(`Downloading ${vCfg.pythonVersion}...`);
  fs.mkdirSync(baseDir, { recursive: true });
  const installer = path.join(baseDir, installerName);
  try {
    await downloadFile(vCfg.pythonUrl, installer, logger, 'install_python');
  } catch (e) {
    return { ok: false, msg: `Download failed: ${e}` };
  }
  logger.log(`Installing ${vCfg.pythonVersion} (silent, InstallAllUsers=1)...`);
  const { code: pyCode, output: pyOut } = await runCmd(
    `"${installer}" /quiet InstallAllUsers=1 PrependPath=0 Include_launcher=1 Include_pip=1`
  );
  logger.log(`  > Installer exit code: ${pyCode}`);
  if (pyOut.trim()) logger.log(`  > Installer output: ${pyOut.trim()}`);
  await new Promise(resolve => setTimeout(resolve, 5000));
  if (findPython(candidates)) {
    logger.log(`${vCfg.pythonVersion} installed!`);
    return { ok: true, msg: 'Installed' };
  }
  // Try finding via py launcher (works regardless of install location)
  const pyLauncherVersion = `-${vCfg.pythonVersionPrefix}`;
  const { code: pyLCode, output: pyLOut } = await runCmd(`py ${pyLauncherVersion} -c "import sys; print(sys.executable)"`);
  if (pyLCode === 0 && pyLOut.trim()) {
    logger.log(`${vCfg.pythonVersion} found via py launcher: ${pyLOut.trim()}`);
    return { ok: true, msg: 'Installed' };
  }
  // Retry per-user install if system-wide failed
  logger.log('System-wide install not detected. Trying per-user install...');
  const { code: pyCode2, output: pyOut2 } = await runCmd(
    `"${installer}" /quiet InstallAllUsers=0 PrependPath=0 Include_launcher=1 Include_pip=1`
  );
  logger.log(`  > Per-user installer exit code: ${pyCode2}`);
  if (pyOut2.trim()) logger.log(`  > Per-user output: ${pyOut2.trim()}`);
  await new Promise(resolve => setTimeout(resolve, 5000));
  if (findPython(candidates)) {
    logger.log(`${vCfg.pythonVersion} installed (per-user)!`);
    return { ok: true, msg: 'Installed' };
  }
  // Final check via py launcher
  const { code: pyL2, output: pyL2Out } = await runCmd(`py ${pyLauncherVersion} -c "import sys; print(sys.executable)"`);
  if (pyL2 === 0 && pyL2Out.trim()) {
    logger.log(`${vCfg.pythonVersion} found via py launcher: ${pyL2Out.trim()}`);
    return { ok: true, msg: 'Installed' };
  }
  return { ok: false, msg: `Failed to install ${vCfg.pythonVersion}. Check log for details.` };
}

export async function stepInstallPostgres(
  baseDir: string,
  logger: LoggerService,
  pgSuperPassword: string = 'postgres',
  dbPort: string = '5432',
  dbUser: string = 'odoo',
  dbPassword: string = 'odoo',
  pgMode: string = 'auto',
  odooVersion: string = DEFAULT_ODOO_VERSION,
): Promise<StepResult> {
  const vCfg = getVersionConfig(odooVersion);
  const pgVer = vCfg.postgresVersion;

  // Check if the required PG version is already installed
  const requiredBinDir = `C:\\Program Files\\PostgreSQL\\${pgVer}\\bin`;
  const hasRequiredVersion = fs.existsSync(path.join(requiredBinDir, 'psql.exe'));

  // Check if ANY PG is listening on the target port (native or docker)
  const { findPostgresForPort } = require('./detection');
  const pgOnPort = findPostgresForPort(dbPort);
  const dockerPg = findDockerPostgres();
  const dockerOnPort = dockerPg.find((c: any) => c.port === dbPort);

  if (hasRequiredVersion && pgMode !== 'docker') {
    logger.log(`PostgreSQL ${pgVer} already installed at ${requiredBinDir}.`);
    return { ok: true, msg: `Already installed (PG ${pgVer})` };
  }
  if (pgOnPort && pgMode !== 'docker') {
    if (parseInt(pgOnPort.version) < parseInt(pgVer)) {
      logger.log(`  > WARNING: PG ${pgOnPort.version} on port ${dbPort} is older than recommended PG ${pgVer} for ${vCfg.label}.`);
      logger.log(`  > Using existing PG ${pgOnPort.version}. Odoo should still work, but upgrading is recommended.`);
    }
    logger.log(`PostgreSQL ${pgOnPort.version} is configured on port ${dbPort}. Using existing installation.`);
    return { ok: true, msg: `Using PG ${pgOnPort.version} on port ${dbPort}` };
  }
  if (dockerOnPort && pgMode !== 'native') {
    logger.log(`PostgreSQL running in Docker on port ${dbPort}: ${dockerOnPort.name}`);
    return { ok: true, msg: `Already running (Docker: ${dockerOnPort.name})` };
  }

  // If other PG versions exist but not on the right port, log and continue install
  const anyNative = findPostgresBin();
  if (anyNative) {
    logger.log(`  > Found PostgreSQL at ${anyNative}, but not version ${pgVer} or not on port ${dbPort}. Installing PG ${pgVer}...`);
  }

  // Install based on mode
  if (pgMode === 'docker' || (pgMode === 'auto' && findDocker())) {
    if (!findDocker()) {
      return { ok: false, msg: 'Docker not available. Install Docker Desktop or choose Native mode.' };
    }
    const cname = `odoo-postgres-v${odooVersion}-${dbPort}`;
    const dockerImage = vCfg.postgresDockerImage;
    logger.log(`Creating ${dockerImage} Docker container '${cname}'...`);
    let dockerRunCmd =
      `docker run -d --name ${cname} -e POSTGRES_USER=${dbUser} -e POSTGRES_PASSWORD=${dbPassword} ` +
      `-e POSTGRES_DB=postgres -p ${dbPort}:5432 --restart unless-stopped ${dockerImage}`;
    const { code, output } = await runCmd(dockerRunCmd);
    if (code === 0) {
      logger.log(`  > Waiting for PostgreSQL container to start...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      // Enable pgvector extension for Odoo 19
      if (vCfg.pgvector) {
        logger.log(`  > Enabling pgvector extension for AI modules...`);
        await runCmd(`docker exec ${cname} psql -U ${dbUser} -c "CREATE EXTENSION IF NOT EXISTS vector;"`);
      }
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
    logger.log(`Downloading PostgreSQL ${pgVer} (native installer)...`);
    fs.mkdirSync(baseDir, { recursive: true });
    const installer = path.join(baseDir, `postgresql-${pgVer}-installer.exe`);
    try {
      await downloadFile(vCfg.postgresUrl, installer, logger, 'install_postgres');
    } catch (e) {
      return { ok: false, msg: `Download failed: ${e}` };
    }
    logger.log(`Installing PostgreSQL ${pgVer} (this may take a few minutes)...`);
    const serviceName = `postgresql-${pgVer}`;
    const { code, output } = await runCmd(
      `"${installer}" --mode unattended --superpassword "${pgSuperPassword}" --servicename ${serviceName} ` +
      `--servicepassword "${pgSuperPassword}" --serverport ${dbPort} --prefix "C:\\Program Files\\PostgreSQL\\${pgVer}"`
    );
    logger.log(`  > Installer exit code: ${code}`);
    await new Promise(resolve => setTimeout(resolve, 10000));
    if (findPostgresBin()) {
      logger.log('  > Starting PostgreSQL service...');
      await runCmd(`net start ${serviceName}`);
      await runCmd(`sc.exe config ${serviceName} start=auto`);
      await runCmd(`net start postgresql-x64-${pgVer}`);
      await runCmd(`sc.exe config postgresql-x64-${pgVer} start=auto`);
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

export async function stepCloneOdoo(baseDir: string, logger: LoggerService, odooVersion: string = DEFAULT_ODOO_VERSION): Promise<StepResult> {
  const vCfg = getVersionConfig(odooVersion);
  fs.mkdirSync(baseDir, { recursive: true });
  const odooBin = path.join(baseDir, 'odoo', 'odoo-bin');
  if (fs.existsSync(odooBin)) {
    logger.log('Odoo source already cloned.');
    return { ok: true, msg: 'Already cloned' };
  }
  logger.log(`Cloning ${vCfg.label} (branch ${vCfg.branch}, shallow clone)...`);
  const code = await runCmdStreaming(
    `git clone --progress --branch ${vCfg.branch} --single-branch --depth 1 ${ODOO_GIT_URL}`,
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

export async function stepCreateVenv(baseDir: string, logger: LoggerService, odooVersion: string = DEFAULT_ODOO_VERSION): Promise<StepResult> {
  const vCfg = getVersionConfig(odooVersion);
  const candidates = getPythonCandidates(odooVersion);
  const venvDir = path.join(baseDir, 'venv');
  const venvPython = path.join(venvDir, 'Scripts', 'python.exe');
  let pythonPath = findPython(candidates) || findPythonViaLauncher(vCfg.pythonVersionPrefix);
  logger.log(`  > ${vCfg.pythonVersion} path: ${pythonPath || 'NOT FOUND'}`);
  if (!pythonPath) {
    return { ok: false, msg: `${vCfg.pythonVersion} not found. Install Python first.` };
  }
  if (fs.existsSync(venvPython)) {
    const { output } = await runCmd(`"${venvPython}" --version`);
    logger.log(`  > Existing venv python: ${output.trim()}`);
    if (output.includes(vCfg.pythonVersionPrefix)) {
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
  return { ok: false, msg: `Failed to create venv (exit code: ${code}). Check ${vCfg.pythonVersion} installation.` };
}

export async function stepInstallRequirements(baseDir: string, logger: LoggerService, odooVersion: string = DEFAULT_ODOO_VERSION): Promise<StepResult> {
  const vCfg = getVersionConfig(odooVersion);
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
  const extraPkgs = vCfg.extraPipPackages;
  const totalPkgs = (reqLines.length + extraPkgs.length) || 1;
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
          const pct = Math.min(80, Math.round((installedCount / totalPkgs) * 100));
          logger.emitDownloadProgress({
            step: 'install_requirements',
            percent: pct,
            downloadedMB: `${installedCount}`,
            totalMB: `${totalPkgs} pkgs`,
          });
        }
        if (line.includes('Successfully installed')) {
          success = true;
        }
      },
    }
  );

  if (code !== 0 && !success) {
    return { ok: false, msg: 'Failed installing requirements.txt. Check logs.' };
  }

  // Install extra packages for this Odoo version
  if (extraPkgs.length > 0) {
    logger.log(`Installing ${extraPkgs.length} extra packages for ${vCfg.label}...`);
    const pkgList = extraPkgs.join(' ');
    let extraSuccess = false;

    const extraCode = await runCmdStreaming(
      `"${pipExe}" install ${pkgList}`,
      logger,
      {
        onData: (line) => {
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
            extraSuccess = true;
          }
        },
      }
    );

    if (extraCode !== 0 && !extraSuccess) {
      logger.log('Warning: Some extra packages failed to install. Check logs.');
    }
  }

  logger.emitDownloadProgress({
    step: 'install_requirements',
    percent: 100,
    downloadedMB: `${totalPkgs}`,
    totalMB: `${totalPkgs} pkgs`,
  });

  return { ok: true, msg: 'Installed' };
}

export async function stepCreateProject(
  baseDir: string,
  projectsDir: string,
  projectName: string,
  logger: LoggerService,
  opts: Record<string, string> = {},
  odooVersion: string = DEFAULT_ODOO_VERSION,
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

  // logfile = False in odoo.conf (log to stdout by default)
  // Installer start_odoo passes --logfile via command line instead

  // data_dir inside project to prevent Odoo from creating version subdirs in addons/
  if (!cfg.data_dir) {
    cfg.data_dir = path.join(proj, 'data').replace(/\\/g, '/');
  }

  // Tag project with Odoo version
  cfg.odoo_version = odooVersion;

  // Per-project domain (isolate browser sessions)
  const { projectToDomain, addHostEntry } = require('../utils/hosts');
  const projectDomain = opts.project_domain || projectToDomain(projectName);
  cfg.project_domain = projectDomain;

  // Auto-set dbfilter from project name (DB isolation without manual config)
  // e.g. project "test_db" → dbfilter "^test_db.*$"
  // Uses project name (not domain) to preserve underscores in DB names
  if (!cfg.dbfilter) {
    cfg.dbfilter = `^${projectName}.*$`;
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
  odooVersion: string = DEFAULT_ODOO_VERSION,
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

  const vCfg = getVersionConfig(odooVersion);

  // Fire all independent tasks simultaneously (with lock support)
  const gitPromise = runNamedStep('Installing Git...', 'install_git', () => stepInstallGit(baseDir, logger), logger, lock);
  const vscodePromise = runNamedStep('Installing VS Code...', 'install_vscode', () => stepInstallVSCode(baseDir, logger), logger, lock);
  const pythonPromise = runNamedStep(`Installing ${vCfg.pythonVersion}...`, 'install_python', () => stepInstallPython(baseDir, logger, odooVersion), logger, lock);
  const pgPromise = runNamedStep(`Installing PostgreSQL ${vCfg.postgresVersion}...`, 'install_postgres', () => stepInstallPostgres(baseDir, logger, pgSuperPassword, dbPort, dbUser, dbPassword, pgMode, odooVersion), logger, lock);
  const nginxPromise = runNamedStep('Installing Nginx (HTTPS)...', 'install_nginx', () => stepInstallNginx(baseDir, logger), logger, lock);

  // ── Chain: Git done → Clone Odoo ──
  const clonePromise = gitPromise.then(gitResult => {
    results.push(gitResult);
    logger.updateTask({ status: 'running', step: `Cloning ${vCfg.label}...`, progress: 20 });
    return runNamedStep(`Cloning ${vCfg.label}...`, 'clone_odoo', () => stepCloneOdoo(baseDir, logger, odooVersion), logger, lock);
  });

  // ── Chain: Python done → Venv → Pip Install ──
  const pipPromise = pythonPromise.then(async pyResult => {
    results.push(pyResult);
    logger.updateTask({ status: 'running', step: 'Creating venv...', progress: 30 });
    const venvResult = await runNamedStep('Creating virtual environment...', 'create_venv', () => stepCreateVenv(baseDir, logger, odooVersion), logger, lock);
    results.push(venvResult);

    // Wait for Odoo clone too (need requirements.txt)
    const cloneResult = await clonePromise;
    results.push(cloneResult);
    logger.updateTask({ status: 'running', step: 'Installing pip requirements...', progress: 50 });
    return runNamedStep('Installing requirements...', 'install_requirements', () => stepInstallRequirements(baseDir, logger, odooVersion), logger, lock);
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

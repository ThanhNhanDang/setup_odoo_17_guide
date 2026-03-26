import * as fs from 'fs';
import * as path from 'path';
import { LoggerService } from './logger';
import {
  PYTHON_311_URL,
  POSTGRES_URL,
  ODOO_GIT_URL,
  ODOO_BRANCH,
  PROJECT_DEFAULTS,
  getTemplatesDir,
} from './config';
import { findPython311, findPostgresBin, findDocker, findDockerPostgres } from './detection';
import { runCmd } from '../utils/shell';
import { downloadFile } from '../utils/download';

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

export async function stepInstallPython(baseDir: string, logger: LoggerService): Promise<StepResult> {
  if (findPython311()) {
    logger.log('Python 3.11 already installed.');
    return { ok: true, msg: 'Already installed' };
  }
  logger.log('Downloading Python 3.11.4...');
  fs.mkdirSync(baseDir, { recursive: true });
  const installer = path.join(baseDir, 'python-3.11.4-amd64.exe');
  try {
    await downloadFile(PYTHON_311_URL, installer, logger);
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
): Promise<StepResult> {
  if (findPostgresBin()) {
    logger.log('PostgreSQL already installed locally.');
    return { ok: true, msg: 'Already installed (local)' };
  }
  const dockerPg = findDockerPostgres();
  if (dockerPg.length > 0) {
    logger.log(`PostgreSQL running in Docker: ${dockerPg.map(c => c.name).join(', ')}`);
    return { ok: true, msg: 'Already running (Docker)' };
  }
  if (findDocker()) {
    const cname = `odoo-postgres-${dbPort}`;
    logger.log(`Creating PostgreSQL container '${cname}'...`);
    const { code } = await runCmd(
      `docker run -d --name ${cname} -e POSTGRES_USER=${dbUser} -e POSTGRES_PASSWORD=${dbPassword} ` +
      `-e POSTGRES_DB=postgres -p ${dbPort}:5432 --restart unless-stopped postgres:16`
    );
    if (code === 0) {
      logger.log(`Docker container '${cname}' started on port ${dbPort}!`);
      return { ok: true, msg: `Docker container '${cname}' on port ${dbPort}` };
    }
  }
  logger.log('Downloading PostgreSQL 16...');
  fs.mkdirSync(baseDir, { recursive: true });
  const installer = path.join(baseDir, 'postgresql-16-installer.exe');
  try {
    await downloadFile(POSTGRES_URL, installer, logger);
  } catch (e) {
    return { ok: false, msg: `Download failed: ${e}` };
  }
  logger.log('Installing PostgreSQL 16...');
  await runCmd(
    `"${installer}" --mode unattended --superpassword "${pgSuperPassword}" --servicename postgresql-16 ` +
    `--servicepassword "${pgSuperPassword}" --serverport ${dbPort} --prefix "C:\\Program Files\\PostgreSQL\\16"`
  );
  await new Promise(resolve => setTimeout(resolve, 10000));
  if (findPostgresBin()) {
    return { ok: true, msg: 'Installed (native)' };
  }
  return { ok: false, msg: 'Install failed. Run as Administrator or install Docker.' };
}

export async function stepCreatePgUser(
  logger: LoggerService,
  dbUser: string = 'odoo',
  dbPassword: string = 'odoo',
  dbPort: string = '5432',
  pgSuperPassword: string = 'postgres',
): Promise<StepResult> {
  // Check Docker containers first
  const dockerPg = findDockerPostgres();
  for (const c of dockerPg) {
    if (c.port === dbPort) {
      const { output: checkOut } = await runCmd(
        `docker exec ${c.name} psql -U postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='${dbUser}'"`
      );
      if (checkOut.includes('1')) {
        return { ok: true, msg: `User exists (Docker: ${c.name})` };
      }
      const { code } = await runCmd(
        `docker exec ${c.name} psql -U postgres -c "CREATE ROLE ${dbUser} WITH LOGIN PASSWORD '${dbPassword}' CREATEDB;"`
      );
      if (code === 0) {
        return { ok: true, msg: `User created (Docker: ${c.name})` };
      }
      return { ok: false, msg: `Failed to create user in Docker: ${c.name}` };
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
  const { code } = await runCmd(
    `git clone --branch ${ODOO_BRANCH} --single-branch --depth 1 ${ODOO_GIT_URL}`,
    baseDir
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
  if (!pythonPath) {
    return { ok: false, msg: 'Python 3.11 not found.' };
  }
  if (fs.existsSync(venvPython)) {
    const { output } = await runCmd(`"${venvPython}" --version`);
    if (output.includes('3.11')) {
      return { ok: true, msg: 'Already exists' };
    }
    // Wrong version, recreate
    fs.rmSync(venvDir, { recursive: true, force: true });
  }
  logger.log('Creating virtual environment...');
  await runCmd(`"${pythonPath}" -m venv "${venvDir}"`);
  if (fs.existsSync(venvPython)) {
    return { ok: true, msg: 'Created' };
  }
  return { ok: false, msg: 'Failed to create venv' };
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
  const { code, output } = await runCmd(`"${pipExe}" install -r "${reqFile}"`);
  if (code === 0 || output.includes('Successfully installed')) {
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

  // odoo.conf from template
  const templatesDir = getTemplatesDir();
  const confTemplate = fs.readFileSync(path.join(templatesDir, 'odoo.conf'), 'utf8');
  // Replace {key} placeholders with config values
  let confContent = confTemplate;
  for (const [key, value] of Object.entries(cfg)) {
    confContent = confContent.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  fs.writeFileSync(path.join(proj, 'odoo.conf'), confContent, 'utf8');

  // launch.json from template
  const venvPython = path.join(baseDir, 'venv', 'Scripts', 'python.exe').replace(/\\/g, '\\\\');
  const odooBin = path.join(baseDir, 'odoo', 'odoo-bin').replace(/\\/g, '\\\\');
  let launchContent = fs.readFileSync(path.join(templatesDir, 'launch.json'), 'utf8');
  launchContent = launchContent.replace(/\{python_path\}/g, venvPython);
  launchContent = launchContent.replace(/\{odoo_bin_path\}/g, odooBin);
  fs.writeFileSync(path.join(proj, '.vscode', 'launch.json'), launchContent, 'utf8');

  logger.log(`Project '${projectName}' ready at ${proj}`);
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

export async function stepFullInstall(
  baseDir: string,
  projectsDir: string,
  projectName: string,
  logger: LoggerService,
  opts: Record<string, string> = {},
): Promise<readonly FullInstallResult[]> {
  fs.mkdirSync(baseDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });

  const dbPort = opts.db_port || '5432';
  const dbUser = opts.db_user || 'odoo';
  const dbPassword = opts.db_password || 'odoo';
  const pgSuperPassword = opts.pg_super_password || 'postgres';

  const steps: Array<[string, () => Promise<StepResult>]> = [
    ['Installing Python 3.11...', () => stepInstallPython(baseDir, logger)],
    ['Installing PostgreSQL...', () => stepInstallPostgres(baseDir, logger, pgSuperPassword, dbPort, dbUser, dbPassword)],
    ['Creating DB user...', () => stepCreatePgUser(logger, dbUser, dbPassword, dbPort, pgSuperPassword)],
    ['Cloning Odoo 17...', () => stepCloneOdoo(baseDir, logger)],
    ['Creating virtual environment...', () => stepCreateVenv(baseDir, logger)],
    ['Installing requirements...', () => stepInstallRequirements(baseDir, logger)],
    ['Creating project...', () => stepCreateProject(baseDir, projectsDir, projectName, logger, opts)],
  ];

  const results: FullInstallResult[] = [];

  for (let i = 0; i < steps.length; i++) {
    const [label, fn] = steps[i];
    logger.updateTask({
      status: 'running',
      step: label,
      progress: Math.round((i / steps.length) * 100),
    });
    logger.log('');
    logger.log('==================================================');
    logger.log(`Step ${i + 1}/${steps.length}: ${label}`);

    const result = await fn();
    results.push({ step: label, ok: result.ok, msg: result.msg });

    if (!result.ok) {
      logger.log(`[WARN] ${result.msg} - continuing...`);
    }
  }

  logger.updateTask({
    status: 'done',
    step: 'Complete!',
    progress: 100,
    results,
  });

  return results;
}

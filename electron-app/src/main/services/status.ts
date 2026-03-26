import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import {
  findPython311,
  findPostgresBin,
  findDocker,
  findDockerPostgres,
  detectNativePostgresDetails,
  findGit,
  findVSCode,
  getVSCodeVersion,
  findVSCodeAsync,
  findGitAsync,
  findDockerAsync,
  findDockerPostgresAsync,
  detectNativePostgresDetailsAsync,
  DockerContainer,
  NativePostgresDetails,
} from './detection';
import { parseIniFile, iniGet } from './ini-parser';
import { DEFAULT_BASE_DIR } from './config';
import { isNginxInstalled } from '../utils/nginx';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AddonDir {
  readonly path: string;
  readonly count: number;
  readonly is_base: boolean;
}

export interface ProjectInfo {
  readonly name: string;
  readonly path: string;
  readonly http_port: string;
  readonly longpolling_port: string;
  readonly db_port: string;
  readonly db_host: string;
  readonly db_user: string;
  readonly addons_path: string;
  readonly data_dir: string;
  readonly admin_passwd: string;
  readonly log_level: string;
  readonly workers: string;
  readonly list_db: string;
  readonly dbfilter: string;
  readonly proxy_mode: string;
  readonly server_wide_modules: string;
  readonly logfile: string;
  readonly custom_modules: number;
  readonly addon_dirs: readonly AddonDir[];
  readonly start_command: string;
  readonly domain: string;
  readonly is_running: boolean;
}

export interface StatusResult {
  readonly python311: boolean;
  readonly python311_path: string;
  readonly postgres: boolean;
  readonly postgres_path: string;
  readonly postgres_local: boolean;
  readonly docker: boolean;
  readonly docker_postgres: readonly DockerContainer[];
  readonly native_postgres: NativePostgresDetails | null;
  readonly odoo_cloned: boolean;
  readonly venv_created: boolean;
  readonly requirements_installed: boolean;
  readonly git: boolean;
  readonly git_version: string;
  readonly nginx: boolean;
  readonly vscode: boolean;
  readonly vscode_version: string;
  readonly base_dir: string;
  readonly projects_dir: string;
  readonly projects: readonly ProjectInfo[];
}

// ---------------------------------------------------------------------------
// Port check - detect if Odoo is running
// ---------------------------------------------------------------------------

function checkPort(port: number, host: string = 'localhost', timeout: number = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}

// ---------------------------------------------------------------------------
// Parse project config (odoo.conf)
// ---------------------------------------------------------------------------

export async function parseProjectConfig(projectPath: string, baseDir: string = DEFAULT_BASE_DIR): Promise<ProjectInfo> {
  const confFile = path.join(projectPath, 'odoo.conf');
  const info: {
    name: string;
    path: string;
    http_port: string;
    longpolling_port: string;
    db_port: string;
    db_host: string;
    db_user: string;
    addons_path: string;
    data_dir: string;
    admin_passwd: string;
    log_level: string;
    workers: string;
    list_db: string;
    dbfilter: string;
    proxy_mode: string;
    server_wide_modules: string;
    logfile: string;
    custom_modules: number;
    addon_dirs: AddonDir[];
    start_command: string;
    domain: string;
    is_running: boolean;
  } = {
    name: path.basename(projectPath),
    path: projectPath,
    http_port: '',
    longpolling_port: '',
    db_port: '',
    db_host: '',
    db_user: '',
    addons_path: '',
    data_dir: '',
    admin_passwd: '',
    log_level: '',
    workers: '',
    list_db: '',
    dbfilter: '',
    proxy_mode: '',
    server_wide_modules: '',
    logfile: '',
    custom_modules: 0,
    addon_dirs: [],
    start_command: '',
    domain: '',
    is_running: false,
  };

  if (!fs.existsSync(confFile)) return info;

  try {
    const ini = parseIniFile(confFile);
    const section = 'options';
    const get = (key: string, def: string = ''): string => iniGet(ini, section, key, def);

    info.http_port = get('http_port');
    info.longpolling_port = get('longpolling_port', get('gevent_port'));
    info.db_port = get('db_port');
    info.db_host = get('db_host', 'localhost');
    info.db_user = get('db_user');
    info.addons_path = get('addons_path');
    info.data_dir = get('data_dir');
    info.admin_passwd = get('admin_passwd');
    info.log_level = get('log_level');
    info.workers = get('workers');
    info.list_db = get('list_db');
    info.dbfilter = get('dbfilter');
    info.proxy_mode = get('proxy_mode');
    info.server_wide_modules = get('server_wide_modules');
    const rawLogfile = get('logfile');
    // Resolve logfile path (may be relative like ./odoo.log or absolute)
    if (rawLogfile) {
      info.logfile = path.isAbsolute(rawLogfile) ? rawLogfile : path.join(projectPath, rawLogfile);
    } else {
      info.logfile = path.join(projectPath, 'odoo.log');
    }
  } catch {
    // ignore parse errors
  }

  // Count custom modules in each addon directory
  let totalCustom = 0;
  const addonDirs: AddonDir[] = [];

  if (info.addons_path) {
    for (const rawPath of info.addons_path.split(',')) {
      const p = rawPath.trim();
      const absP = path.isAbsolute(p) ? p : path.join(projectPath, p);
      const isBase = p.replace(/\\/g, '/').includes('odoo/addons');
      let count = 0;

      if (!isBase && fs.existsSync(absP) && fs.statSync(absP).isDirectory()) {
        try {
          for (const entry of fs.readdirSync(absP)) {
            const manifest = path.join(absP, entry, '__manifest__.py');
            if (fs.existsSync(manifest)) {
              count++;
            }
          }
        } catch {
          // ignore read errors
        }
      }

      addonDirs.push({ path: p, count, is_base: isBase });
      if (!isBase) totalCustom += count;
    }
  }

  info.custom_modules = totalCustom;
  info.addon_dirs = addonDirs;

  // Build start command
  const venvPy = path.join(baseDir, 'venv', 'Scripts', 'python.exe');
  const odooBin = path.join(baseDir, 'odoo', 'odoo-bin');
  info.start_command = `"${venvPy}" "${odooBin}" -c "${confFile}"`;

  // Read domain from comment line in odoo.conf
  try {
    const rawConf = fs.readFileSync(confFile, 'utf8');
    const domainMatch = rawConf.match(/^;\s*project_domain\s*=\s*(.+)$/m);
    if (domainMatch) info.domain = domainMatch[1].trim();
  } catch { /* ignore */ }

  // Check if Odoo is running on this port
  const httpPort = parseInt(info.http_port, 10);
  info.is_running = !isNaN(httpPort) ? await checkPort(httpPort) : false;

  return info;
}

// ---------------------------------------------------------------------------
// Detect full system status — parallel + cached
// ---------------------------------------------------------------------------

let _statusCache: { result: StatusResult; timestamp: number } | null = null;
const CACHE_TTL = 5000; // 5 seconds

export async function detectStatus(baseDir: string, projectsDir: string): Promise<StatusResult> {
  // Return cache if fresh
  if (_statusCache && Date.now() - _statusCache.timestamp < CACHE_TTL) {
    return _statusCache.result;
  }

  // Fast: file-only checks (no external processes)
  const py311 = findPython311();
  const pgBin = findPostgresBin();
  const odooCloned = fs.existsSync(path.join(baseDir, 'odoo', 'odoo-bin'));
  const venvCreated = fs.existsSync(path.join(baseDir, 'venv', 'Scripts', 'python.exe'));
  const reqInstalled = fs.existsSync(path.join(baseDir, 'venv', 'Lib', 'site-packages', 'lxml'));
  const nginx = isNginxInstalled(baseDir);

  // Slow: run ALL external process checks in parallel
  const [vsResult, gitVersion, dockerAvailable, nativePg] = await Promise.all([
    findVSCodeAsync(),
    findGitAsync(),
    findDockerAsync(),
    detectNativePostgresDetailsAsync(),
  ]);

  // Docker postgres depends on docker being available
  const dockerPg = dockerAvailable ? await findDockerPostgresAsync() : [];
  const pgOk = pgBin !== null || dockerPg.length > 0;

  let pgDetail = '';
  if (dockerPg.length > 0) {
    pgDetail = 'Docker: ' + dockerPg.map(c => `${c.name}(${c.image} port:${c.port})`).join(', ');
  } else if (pgBin) {
    pgDetail = pgBin;
  }

  // Scan projects (parallel port checks)
  const projects: ProjectInfo[] = [];
  if (fs.existsSync(projectsDir) && fs.statSync(projectsDir).isDirectory()) {
    const entries = fs.readdirSync(projectsDir).sort();
    const projectPromises: Promise<ProjectInfo | null>[] = [];
    for (const entry of entries) {
      const dirPath = path.join(projectsDir, entry);
      try {
        if (fs.statSync(dirPath).isDirectory() && fs.existsSync(path.join(dirPath, 'odoo.conf'))) {
          projectPromises.push(parseProjectConfig(dirPath, baseDir).catch(() => null));
        }
      } catch { /* skip */ }
    }
    const results = await Promise.all(projectPromises);
    for (const p of results) {
      if (p) projects.push(p);
    }
  }

  const result: StatusResult = {
    python311: py311 !== null,
    python311_path: py311 || '',
    postgres: pgOk,
    postgres_path: pgDetail,
    postgres_local: pgBin !== null,
    docker: dockerAvailable,
    docker_postgres: dockerPg,
    native_postgres: nativePg,
    odoo_cloned: odooCloned,
    venv_created: venvCreated,
    requirements_installed: reqInstalled,
    git: gitVersion !== null,
    git_version: gitVersion || '',
    nginx,
    vscode: vsResult.path !== null,
    vscode_version: vsResult.version,
    base_dir: baseDir,
    projects_dir: projectsDir,
    projects,
  };

  _statusCache = { result, timestamp: Date.now() };
  return result;
}

/** Invalidate status cache (call after install steps complete) */
export function invalidateStatusCache(): void {
  _statusCache = null;
}

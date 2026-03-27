import * as fs from 'fs';
import * as path from 'path';
import { parseIni, stringifyIni, iniSet } from './ini-parser';
import { runCmd } from '../utils/shell';

// ---------------------------------------------------------------------------
// Project Management - CRUD operations
// Ports: read_project_config, save_project_config, delete_project,
//        duplicate_project
// ---------------------------------------------------------------------------

interface ProjectResult {
  readonly ok: boolean;
  readonly msg: string;
  readonly content?: string;
}

export function readProjectConfig(projectsDir: string, projectName: string): ProjectResult {
  const conf = path.join(projectsDir, projectName, 'odoo.conf');
  if (!fs.existsSync(conf)) {
    return { ok: false, msg: 'CONFIG_NOT_FOUND' };
  }
  const content = fs.readFileSync(conf, 'utf8');
  return { ok: true, msg: 'OK', content };
}

export function saveProjectConfig(projectsDir: string, projectName: string, content: string): ProjectResult {
  const conf = path.join(projectsDir, projectName, 'odoo.conf');
  if (!fs.existsSync(conf)) {
    return { ok: false, msg: 'CONFIG_NOT_FOUND' };
  }
  // Validate INI format
  try {
    parseIni(content);
  } catch (e) {
    return { ok: false, msg: `Invalid config: ${e}` };
  }
  fs.writeFileSync(conf, content, 'utf8');
  return { ok: true, msg: 'Saved' };
}

/** Validate project name — lowercase, start with letter/underscore, no path traversal */
function isValidName(name: string): boolean {
  return /^[a-z_][a-z0-9_\-]*$/.test(name);
}

/** Validate DB identifier — letters, numbers, underscores only */
function isSafeDbIdentifier(val: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(val);
}

export async function deleteProject(
  projectsDir: string,
  projectName: string,
  dropDatabases: boolean = false,
): Promise<ProjectResult> {
  if (!isValidName(projectName)) {
    return { ok: false, msg: 'INVALID_NAME' };
  }
  const proj = path.join(projectsDir, projectName);
  if (!path.resolve(proj).startsWith(path.resolve(projectsDir) + path.sep)) {
    return { ok: false, msg: 'INVALID_NAME' };
  }
  const conf = path.join(proj, 'odoo.conf');
  if (!fs.existsSync(proj) || !fs.statSync(proj).isDirectory() || !fs.existsSync(conf)) {
    return { ok: false, msg: 'PROJECT_NOT_FOUND' };
  }

  // Drop databases matching dbfilter if requested
  const droppedDbs: string[] = [];
  if (dropDatabases) {
    try {
      const iniContent = fs.readFileSync(conf, 'utf8');
      const ini = parseIni(iniContent);
      const dbPort = ini.options?.db_port || '5434';
      const dbUser = ini.options?.db_user || 'odoo';
      const dbPassword = ini.options?.db_password || 'odoo';
      const dbHost = ini.options?.db_host || 'localhost';
      const dbfilter = ini.options?.dbfilter || '';

      // Find psql binary
      const { findPostgresForPort, findPostgresBin } = require('./detection');
      const pgInstance = findPostgresForPort(dbPort);
      const pgBin = pgInstance?.binPath || findPostgresBin();

      if (pgBin) {
        const psqlExe = path.join(pgBin, 'psql.exe');
        const env = { ...process.env, PGPASSWORD: dbPassword };

        // List databases owned by the project's db_user
        const { output: dbList } = await runCmd(
          `"${psqlExe}" -h ${dbHost} -p ${dbPort} -U ${dbUser} -tAc "SELECT datname FROM pg_database WHERE datistemplate=false AND datname != 'postgres'"`,
          undefined, env,
        );

        const databases = dbList.trim().split('\n').map((d: string) => d.trim()).filter(Boolean);

        // Filter by dbfilter if set, otherwise drop all DBs matching project name pattern
        let filterRegex: RegExp | null = null;
        if (dbfilter) {
          try { filterRegex = new RegExp(dbfilter); } catch { /* invalid regex */ }
        }

        for (const db of databases) {
          const shouldDrop = filterRegex
            ? filterRegex.test(db)
            : db.startsWith(projectName.replace(/-/g, '_'));

          if (shouldDrop) {
            // Use postgres superuser to drop (db_user may not have permission)
            const envSuper = { ...process.env, PGPASSWORD: 'postgres' };
            // Terminate active connections first — PostgreSQL refuses DROP with open sessions
            await runCmd(
              `"${psqlExe}" -h ${dbHost} -p ${dbPort} -U postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='"'"'${db}'"'"' AND pid <> pg_backend_pid();"`,
              undefined, envSuper,
            );
            const { code } = await runCmd(
              `"${psqlExe}" -h ${dbHost} -p ${dbPort} -U postgres -c "DROP DATABASE IF EXISTS \\"${db}\\";"`,
              undefined, envSuper,
            );
            if (code === 0) droppedDbs.push(db);
          }
        }
      }
    } catch {
      // DB cleanup failed — continue with folder deletion
    }
  }

  // Stop Odoo if running on this project's port
  try {
    const iniContent = fs.readFileSync(conf, 'utf8');
    const ini = parseIni(iniContent);
    const httpPort = ini.options?.http_port || '8069';
    const { output } = await runCmd(`netstat -ano | findstr ":${httpPort}.*LISTENING"`);
    const lines = output.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && pid !== '0') {
        await runCmd(`taskkill /F /PID ${pid}`);
      }
    }
  } catch { /* ignore */ }

  // Close VS Code windows that have this project open
  try {
    const projNorm = proj.replace(/\\/g, '\\\\').replace(/\//g, '\\\\');
    // Kill code.exe processes whose command line contains this project path
    await runCmd(`powershell -Command "Get-Process code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match '${projectName}' } | Stop-Process -Force -ErrorAction SilentlyContinue"`);
    // Small delay for file locks to release
    await new Promise(r => setTimeout(r, 1000));
  } catch { /* ignore */ }

  // Remove junction links first (Windows locks these, fs.rmSync fails on them)
  try {
    for (const entry of fs.readdirSync(proj)) {
      const entryPath = path.join(proj, entry);
      try {
        const stat = fs.lstatSync(entryPath);
        if (stat.isSymbolicLink() || (stat.isDirectory() && fs.realpathSync(entryPath) !== entryPath)) {
          // Junction or symlink — remove with cmd /c rmdir (not fs.rmSync)
          await runCmd(`cmd /c rmdir "${entryPath}"`);
        }
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }

  // Kill any remaining processes locking files in this folder
  try {
    await runCmd(`powershell -Command "Get-Process | Where-Object { $_.Modules.FileName -like '${proj.replace(/\\/g, '\\\\')}*' } | Stop-Process -Force -ErrorAction SilentlyContinue"`);
    await new Promise(r => setTimeout(r, 1000));
  } catch { /* ignore */ }

  // Retry delete up to 3 times (file locks may take a moment to release)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.rmSync(proj, { recursive: true, force: true });
      const dbMsg = droppedDbs.length > 0
        ? `Deleted (dropped ${droppedDbs.length} DB: ${droppedDbs.join(', ')})`
        : 'Deleted';
      return { ok: true, msg: dbMsg };
    } catch (e) {
      if (attempt < 2) {
        // Force unlock with rd /s /q as fallback
        await runCmd(`cmd /c rd /s /q "${proj}"`);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        return { ok: false, msg: 'DELETE_LOCKED' };
      }
    }
  }
  return { ok: false, msg: 'DELETE_LOCKED' };
}

/** Progress callback for duplicate steps */
type DuplicateProgress = (step: string, done: boolean) => void;

export async function duplicateProject(
  baseDir: string,
  projectsDir: string,
  projectName: string,
  newName: string,
  newHttpPort: string,
  onProgress?: DuplicateProgress,
): Promise<ProjectResult> {
  if (!isValidName(newName)) {
    return { ok: false, msg: 'INVALID_NAME' };
  }

  const src = path.join(projectsDir, projectName);
  const dst = path.join(projectsDir, newName);

  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    return { ok: false, msg: 'PROJECT_NOT_FOUND' };
  }
  if (fs.existsSync(dst)) {
    return { ok: false, msg: 'PROJECT_EXISTS' };
  }

  const emit = (step: string, done: boolean) => { if (onProgress) onProgress(step, done); };

  try {
    // Step 1: Create project folder
    emit('create_folder', false);
    fs.mkdirSync(dst, { recursive: true });
    fs.mkdirSync(path.join(dst, '.vscode'), { recursive: true });
    emit('create_folder', true);

    // Step 2: Create junction link to shared Odoo source
    emit('junction_link', false);
    const odooSrc = path.join(src, 'odoo');
    if (fs.existsSync(odooSrc)) {
      // Resolve the real target of the source junction
      const realTarget = fs.realpathSync(odooSrc);
      await runCmd(`cmd /c mklink /J "${path.join(dst, 'odoo')}" "${realTarget}"`);
    }
    emit('junction_link', true);

    // Step 3: Copy addons (custom modules)
    emit('copy_addons', false);
    const addonsDir = path.join(src, 'addons');
    if (fs.existsSync(addonsDir)) {
      fs.cpSync(addonsDir, path.join(dst, 'addons'), { recursive: true });
    } else {
      fs.mkdirSync(path.join(dst, 'addons'), { recursive: true });
    }
    emit('copy_addons', true);

    // Step 4: Copy .vscode config
    emit('copy_vscode', false);
    const vscodeSrc = path.join(src, '.vscode');
    if (fs.existsSync(vscodeSrc)) {
      fs.cpSync(vscodeSrc, path.join(dst, '.vscode'), { recursive: true });
    }
    emit('copy_vscode', true);

    // Step 5: Copy odoo.conf + update ports, domain, dbfilter
    emit('update_config', false);
    const conf = path.join(src, 'odoo.conf');
    if (fs.existsSync(conf)) {
      const content = fs.readFileSync(conf, 'utf8');
      let ini = parseIni(content);
      if (ini.options) {
        ini = iniSet(ini, 'options', 'http_port', newHttpPort);
        const lpPort = parseInt(newHttpPort, 10);
        if (!isNaN(lpPort)) {
          ini = iniSet(ini, 'options', 'longpolling_port', String(lpPort + 3));
        }
        // Update domain and dbfilter for new project
        const { projectToDomain } = require('../utils/hosts');
        const newDomain = projectToDomain(newName);
        ini = iniSet(ini, 'options', 'project_domain', newDomain);
        ini = iniSet(ini, 'options', 'dbfilter', `^${newName}.*$`);
        fs.writeFileSync(path.join(dst, 'odoo.conf'), stringifyIni(ini), 'utf8');
      }
    }
    emit('update_config', true);

    // Step 6: Setup domain in hosts file
    emit('setup_domain', false);
    const { projectToDomain, addHostEntry } = require('../utils/hosts');
    const newDomain = projectToDomain(newName);
    addHostEntry(newDomain);
    emit('setup_domain', true);

    // Note: data/ folder is NOT copied — user creates fresh DB or restores backup

    return { ok: true, msg: dst };
  } catch (e) {
    return { ok: false, msg: String(e) };
  }
}

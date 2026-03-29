import * as fs from 'fs';
import * as path from 'path';
import { parseIni, stringifyIni, iniSet } from './ini-parser';
import { runCmd } from '../utils/shell';
import { getVersionConfig } from './odoo-versions';

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

type ProgressFn = (step: string, done: boolean) => void;

export async function deleteProject(
  projectsDir: string,
  projectName: string,
  dropDatabases: boolean = false,
  onProgress?: ProgressFn,
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

  const emit = async (step: string, done: boolean) => {
    if (onProgress) onProgress(step, done);
    if (done) await new Promise(r => setTimeout(r, 300));
  };

  // Drop databases matching dbfilter if requested
  const droppedDbs: string[] = [];
  const dropErrors: string[] = [];
  if (dropDatabases) {
    await emit('drop_databases', false);
    try {
      const iniContent = fs.readFileSync(conf, 'utf8');
      const ini = parseIni(iniContent);
      const dbPort = ini.options?.db_port || '5434';
      const dbHost = ini.options?.db_host || 'localhost';
      const dbfilter = ini.options?.dbfilter || '';
      // Read pg_super_password from config comment, fallback to 'postgres'
      const pgSuperMatch = iniContent.match(/^;\s*pg_super_password\s*=\s*(.+)$/m);
      const pgSuperPassword = pgSuperMatch ? pgSuperMatch[1].trim() : 'postgres';

      // Find psql binary
      const { findPostgresForPort, findPostgresBin } = require('./detection');
      const pgInstance = findPostgresForPort(dbPort);
      const pgBin = pgInstance?.binPath || findPostgresBin();

      if (pgBin) {
        const psqlExe = path.join(pgBin, 'psql.exe');
        // Use superuser to list all databases (project user may lack permission)
        const envSuper = { ...process.env, PGPASSWORD: pgSuperPassword };

        const { output: dbList, code: listCode } = await runCmd(
          `"${psqlExe}" -h ${dbHost} -p ${dbPort} -U postgres -tAc "SELECT datname FROM pg_database WHERE datistemplate=false AND datname != 'postgres'"`,
          undefined, envSuper,
        );

        if (listCode !== 0) {
          dropErrors.push(`Failed to list databases: ${dbList}`);
        } else {
          const databases = dbList.trim().split('\n').map((d: string) => d.trim()).filter(Boolean);

          // Filter by dbfilter if set, otherwise drop all DBs matching project name pattern
          let filterRegex: RegExp | null = null;
          if (dbfilter) {
            try { filterRegex = new RegExp(dbfilter); } catch { /* invalid regex */ }
          }

          for (const db of databases) {
            // Skip system databases
            if (['template0', 'template1', 'postgres'].includes(db)) continue;

            const shouldDrop = filterRegex
              ? filterRegex.test(db)
              : db.startsWith(projectName.replace(/-/g, '_'));

            if (shouldDrop) {
              // Terminate active connections first
              await runCmd(
                `"${psqlExe}" -h ${dbHost} -p ${dbPort} -U postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${db}' AND pid <> pg_backend_pid();"`,
                undefined, envSuper,
              );
              const { code, output } = await runCmd(
                `"${psqlExe}" -h ${dbHost} -p ${dbPort} -U postgres -c "DROP DATABASE IF EXISTS \\"${db}\\";"`,
                undefined, envSuper,
              );
              if (code === 0) {
                droppedDbs.push(db);
              } else {
                dropErrors.push(`DROP ${db}: ${output}`);
              }
            }
          }
        }
      } else {
        dropErrors.push('psql not found — cannot drop databases');
      }
    } catch (e) {
      dropErrors.push(String(e));
    }
    await emit('drop_databases', true);
  }

  // Stop Odoo if running on this project's port
  await emit('stop_odoo', false);
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

  await emit('stop_odoo', true);

  // Close VS Code windows that have this project open
  await emit('close_vscode', false);
  try {
    const projNorm = proj.replace(/\\/g, '\\\\').replace(/\//g, '\\\\');
    // Kill code.exe processes whose command line contains this project path
    await runCmd(`powershell -Command "Get-Process code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match '${projectName}' } | Stop-Process -Force -ErrorAction SilentlyContinue"`);
    // Small delay for file locks to release
    await new Promise(r => setTimeout(r, 1000));
  } catch { /* ignore */ }
  await emit('close_vscode', true);

  // Remove junction links first (Windows locks these, fs.rmSync fails on them)
  await emit('delete_files', false);
  const junctionCmds: string[] = [];
  try {
    for (const entry of fs.readdirSync(proj)) {
      const entryPath = path.join(proj, entry);
      try {
        const stat = fs.lstatSync(entryPath);
        if (stat.isSymbolicLink() || (stat.isDirectory() && fs.realpathSync(entryPath) !== entryPath)) {
          junctionCmds.push(`rmdir "${entryPath}"`);
        }
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  // Batch-remove all junctions in a single cmd call
  if (junctionCmds.length > 0) {
    await runCmd(`cmd /c ${junctionCmds.join(' & ')}`);
  }

  // Use rd /s /q as primary method — faster than fs.rmSync for large dirs on Windows
  // Retry up to 3 times with short delay (file locks from previous steps may linger briefly)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Try fast native delete first
      await runCmd(`cmd /c rd /s /q "${proj}"`);
      // Verify folder is gone
      if (!fs.existsSync(proj)) {
        await emit('delete_files', true);
        let dbMsg = 'Deleted';
        if (droppedDbs.length > 0) dbMsg += ` (dropped DB: ${droppedDbs.join(', ')})`;
        if (dropErrors.length > 0) dbMsg += ` [DB errors: ${dropErrors.join('; ')}]`;
        return { ok: true, msg: dbMsg };
      }
      // Folder still exists — fallback to Node recursive delete
      fs.rmSync(proj, { recursive: true, force: true });
      if (!fs.existsSync(proj)) {
        await emit('delete_files', true);
        let dbMsg = 'Deleted';
        if (droppedDbs.length > 0) dbMsg += ` (dropped DB: ${droppedDbs.join(', ')})`;
        if (dropErrors.length > 0) dbMsg += ` [DB errors: ${dropErrors.join('; ')}]`;
        return { ok: true, msg: dbMsg };
      }
    } catch { /* retry */ }
    if (attempt < 2) await new Promise(r => setTimeout(r, 500));
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
  odooVersion: string = '17',
): Promise<ProjectResult> {
  if (!isValidName(newName)) {
    return { ok: false, msg: 'INVALID_NAME' };
  }

  const src = path.join(projectsDir, projectName);
  const dst = path.join(projectsDir, newName);

  // Path confinement — prevent directory traversal
  if (!path.resolve(src).startsWith(path.resolve(projectsDir) + path.sep)) {
    return { ok: false, msg: 'INVALID_NAME' };
  }
  if (!path.resolve(dst).startsWith(path.resolve(projectsDir) + path.sep)) {
    return { ok: false, msg: 'INVALID_NAME' };
  }
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    return { ok: false, msg: 'PROJECT_NOT_FOUND' };
  }
  if (fs.existsSync(dst)) {
    return { ok: false, msg: 'PROJECT_EXISTS' };
  }

  const emit = async (step: string, done: boolean) => {
    if (onProgress) onProgress(step, done);
    if (done) await new Promise(r => setTimeout(r, 300));
  };

  try {
    // Step 1: Create project folder
    await emit('create_folder', false);
    fs.mkdirSync(dst, { recursive: true });
    fs.mkdirSync(path.join(dst, '.vscode'), { recursive: true });
    await emit('create_folder', true);

    // Step 2: Create junction link to shared Odoo source
    await emit('junction_link', false);
    const odooSrc = path.join(src, 'odoo');
    if (fs.existsSync(odooSrc)) {
      // Resolve the real target of the source junction
      const realTarget = fs.realpathSync(odooSrc);
      await runCmd(`cmd /c mklink /J "${path.join(dst, 'odoo')}" "${realTarget}"`);
    }
    await emit('junction_link', true);

    // Step 3: Copy addons (custom modules)
    await emit('copy_addons', false);
    const addonsDir = path.join(src, 'addons');
    if (fs.existsSync(addonsDir)) {
      fs.cpSync(addonsDir, path.join(dst, 'addons'), { recursive: true });
    } else {
      fs.mkdirSync(path.join(dst, 'addons'), { recursive: true });
    }
    await emit('copy_addons', true);

    // Step 4: Copy .vscode config
    await emit('copy_vscode', false);
    const vscodeSrc = path.join(src, '.vscode');
    if (fs.existsSync(vscodeSrc)) {
      fs.cpSync(vscodeSrc, path.join(dst, '.vscode'), { recursive: true });
    }
    await emit('copy_vscode', true);

    // Step 5: Copy odoo.conf + update ports, domain, dbfilter
    await emit('update_config', false);
    const conf = path.join(src, 'odoo.conf');
    if (fs.existsSync(conf)) {
      const content = fs.readFileSync(conf, 'utf8');
      let ini = parseIni(content);
      if (ini.options) {
        ini = iniSet(ini, 'options', 'http_port', newHttpPort);
        const lpPort = parseInt(newHttpPort, 10);
        if (!isNaN(lpPort)) {
          ini = iniSet(ini, 'options', 'gevent_port', String(lpPort + 3));
        }
        // Update dbfilter for new project
        ini = iniSet(ini, 'options', 'dbfilter', `^${newName}.*$`);
        let confStr = stringifyIni(ini);
        // Update domain as comment line (Odoo doesn't recognize project_domain as a key)
        const { projectToDomain } = require('../utils/hosts');
        const vCfg = getVersionConfig(odooVersion);
        const newDomain = projectToDomain(newName, vCfg.domainSuffix);
        if (/^;\s*project_domain\s*=/m.test(confStr)) {
          confStr = confStr.replace(/^;\s*project_domain\s*=.*$/m, `; project_domain = ${newDomain}`);
        } else {
          confStr = confStr.replace('[options]', `[options]\n; project_domain = ${newDomain}`);
        }
        fs.writeFileSync(path.join(dst, 'odoo.conf'), confStr, 'utf8');
      }
    }
    await emit('update_config', true);

    // Step 6: Setup domain in hosts file
    await emit('setup_domain', false);
    const { projectToDomain, addHostEntry } = require('../utils/hosts');
    const vCfg2 = getVersionConfig(odooVersion);
    const newDomain = projectToDomain(newName, vCfg2.domainSuffix);
    addHostEntry(newDomain);
    await emit('setup_domain', true);

    // Note: data/ folder is NOT copied — user creates fresh DB or restores backup

    return { ok: true, msg: dst };
  } catch (e) {
    return { ok: false, msg: String(e) };
  }
}

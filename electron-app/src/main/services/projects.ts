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
    return { ok: false, msg: 'Config not found' };
  }
  const content = fs.readFileSync(conf, 'utf8');
  return { ok: true, msg: 'OK', content };
}

export function saveProjectConfig(projectsDir: string, projectName: string, content: string): ProjectResult {
  const conf = path.join(projectsDir, projectName, 'odoo.conf');
  if (!fs.existsSync(conf)) {
    return { ok: false, msg: 'Config not found' };
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

export async function deleteProject(
  projectsDir: string,
  projectName: string,
  dropDatabases: boolean = false,
): Promise<ProjectResult> {
  const proj = path.join(projectsDir, projectName);
  const conf = path.join(proj, 'odoo.conf');
  if (!fs.existsSync(proj) || !fs.statSync(proj).isDirectory() || !fs.existsSync(conf)) {
    return { ok: false, msg: 'Project not found' };
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

  try {
    fs.rmSync(proj, { recursive: true, force: true });
    const dbMsg = droppedDbs.length > 0
      ? `Deleted (dropped ${droppedDbs.length} DB: ${droppedDbs.join(', ')})`
      : 'Deleted';
    return { ok: true, msg: dbMsg };
  } catch (e) {
    return { ok: false, msg: String(e) };
  }
}

export async function duplicateProject(
  baseDir: string,
  projectsDir: string,
  projectName: string,
  newName: string,
  newHttpPort: string,
): Promise<ProjectResult> {
  const src = path.join(projectsDir, projectName);
  const dst = path.join(projectsDir, newName);

  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    return { ok: false, msg: 'Source project not found' };
  }
  if (fs.existsSync(dst)) {
    return { ok: false, msg: `Project '${newName}' already exists` };
  }

  try {
    fs.mkdirSync(dst, { recursive: true });

    // Copy all files except the junction link
    for (const item of fs.readdirSync(src)) {
      const srcItem = path.join(src, item);
      const dstItem = path.join(dst, item);
      const stat = fs.lstatSync(srcItem);

      if (item === 'odoo' && stat.isDirectory()) {
        // Recreate junction link
        await runCmd(`cmd /c mklink /J "${dstItem}" "${path.join(baseDir, 'odoo')}"`);
      } else if (stat.isDirectory()) {
        fs.cpSync(srcItem, dstItem, { recursive: true });
      } else {
        fs.copyFileSync(srcItem, dstItem);
      }
    }

    // Update ports in config
    const conf = path.join(dst, 'odoo.conf');
    if (fs.existsSync(conf)) {
      const content = fs.readFileSync(conf, 'utf8');
      let ini = parseIni(content);
      if (ini.options) {
        ini = iniSet(ini, 'options', 'http_port', newHttpPort);
        const lpPort = parseInt(newHttpPort, 10);
        if (!isNaN(lpPort)) {
          ini = iniSet(ini, 'options', 'longpolling_port', String(lpPort + 3));
        }
        fs.writeFileSync(conf, stringifyIni(ini), 'utf8');
      }
    }

    return { ok: true, msg: dst };
  } catch (e) {
    return { ok: false, msg: String(e) };
  }
}

import { ipcMain, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { runCmd, runCmdStreaming } from '../utils/shell';
import { IpcContext } from './context';
import { DEFAULT_ODOO_VERSION, getVersionConfig } from '../services/odoo-versions';
import { getDefaultBaseDir, getDefaultProjectsDir } from '../services/config';
import { parseIniFile, iniGet } from '../services/ini-parser';
import { findPostgresBin } from '../services/detection';

export function registerDbHandlers(ctx: IpcContext): void {

  // =========================================================================
  // Project Monitor: Database Tab
  // =========================================================================

  /** Cache for findPostgresBin() — PG bin path doesn't change during a session */
  let cachedPgBin: string | null | undefined;

  /** Read DB connection config + admin_passwd + data_dir from project's odoo.conf */
  function readDbConfig(projectName: string, projectsDir: string) {
    if (!projectName || !/^[a-z_][a-z0-9_\-]*$/.test(projectName)) return null;
    const confFile = path.join(projectsDir, projectName, 'odoo.conf');
    if (!fs.existsSync(confFile)) return null;
    const ini = parseIniFile(confFile);
    return {
      host: iniGet(ini, 'options', 'db_host', 'localhost'),
      port: iniGet(ini, 'options', 'db_port', '5432'),
      user: iniGet(ini, 'options', 'db_user', 'odoo'),
      password: iniGet(ini, 'options', 'db_password', 'odoo'),
      adminPasswd: iniGet(ini, 'options', 'admin_passwd', 'odoo'),
      dataDir: iniGet(ini, 'options', 'data_dir', ''),
      dbfilter: iniGet(ini, 'options', 'dbfilter', ''),
      confFile,
    };
  }

  /** Find psql bin dir, return { pgBin, env } or null. Caches pgBin path. */
  function getPgTools(dbPassword: string) {
    if (cachedPgBin === undefined) {
      cachedPgBin = findPostgresBin();
    }
    if (!cachedPgBin) return null;
    return { pgBin: cachedPgBin, env: { ...process.env, PGPASSWORD: dbPassword } as NodeJS.ProcessEnv };
  }

  /** Check prerequisites: PG running, venv exists, odoo-bin exists */
  function checkPrerequisites(baseDir: string, odooSourceDir: string, dbPort: string): { ok: boolean; msg?: string } {
    const venvPy = path.join(baseDir, 'venv', 'Scripts', 'python.exe');
    if (!fs.existsSync(venvPy)) return { ok: false, msg: 'VENV_NOT_FOUND' };
    const odooBin = path.join(baseDir, odooSourceDir, 'odoo-bin');
    if (!fs.existsSync(odooBin)) return { ok: false, msg: 'ODOO_NOT_FOUND' };
    // PG readiness is checked at runtime by the handlers
    return { ok: true };
  }

  /** Fetch database sizes in background and push results via IPC */
  function fetchDbSizesAsync(
    psql: string,
    conn: { host: string; port: string; user: string },
    env: NodeJS.ProcessEnv,
    dbNames: string[],
    projectName: string,
  ) {
    if (dbNames.length === 0) return;
    const sizeQuery = `SELECT d.datname, pg_size_pretty(pg_database_size(d.datname)) as size FROM pg_database d WHERE d.datistemplate = false ORDER BY d.datname`;
    runCmd(
      `"${psql}" -h ${conn.host} -p ${conn.port} -U ${conn.user} -d postgres -tAF "|" -c "${sizeQuery.replace(/"/g, '\\"')}"`,
      undefined, env
    ).then(({ output }) => {
      const sizes: Record<string, string> = {};
      for (const line of output.trim().split('\n')) {
        if (!line) continue;
        const parts = line.split('|');
        const name = (parts[0] || '').trim();
        const size = (parts[1] || '').trim();
        if (name) sizes[name] = size;
      }
      const win = ctx.logWindows.get(projectName);
      if (win && !win.isDestroyed()) {
        win.webContents.send('db-sizes-update', { sizes });
      }
    }).catch(() => { /* sizes are non-critical, silently ignore */ });
  }

  /** Send progress event to all log windows for a project */
  function emitDbProgress(projectName: string, channel: string, data: Record<string, unknown>) {
    const win = ctx.logWindows.get(projectName);
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
    // Auto-persist on status transitions (not every streaming detail line)
    if (data.status === 'done' || data.status === 'error' || data.status === 'interrupted') {
      persistJobs();
    }
  }

  // --- DB Job tracking (persists across Monitor close/reopen AND app restart) ---
  interface DbJob {
    type: 'create' | 'restore' | 'drop';
    dbName: string;
    projectName: string;
    status: 'running' | 'done' | 'error' | 'interrupted';
    step: string;
    startTime: number;
    output: string[];
    error?: string;
  }
  const dbJobs = new Map<string, DbJob>();
  const DB_JOBS_FILE = path.join(app.getPath('userData'), 'db-jobs.json');

  function getJobKey(projectName: string, type: string, dbName?: string) {
    // Use dbName in key to allow multiple concurrent drops
    return type === 'drop' ? `${projectName}:drop:${dbName}` : `${projectName}:${type}`;
  }

  // Persist jobs to disk (only status transitions, not every output line)
  let _persistTimer: ReturnType<typeof setTimeout> | null = null;
  function persistJobs() {
    if (_persistTimer) return; // debounce 500ms
    _persistTimer = setTimeout(() => {
      _persistTimer = null;
      try {
        const data: Record<string, Omit<DbJob, 'output'>> = {};
        for (const [key, job] of dbJobs) {
          // Don't persist output array (too large), only metadata
          const { output, ...rest } = job;
          data[key] = rest;
        }
        fs.writeFileSync(DB_JOBS_FILE, JSON.stringify(data, null, 2), 'utf8');
      } catch { /* ignore write errors */ }
    }, 500);
  }

  // Load persisted jobs on startup — mark running jobs as interrupted
  try {
    if (fs.existsSync(DB_JOBS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DB_JOBS_FILE, 'utf8'));
      for (const [key, job] of Object.entries(raw) as [string, DbJob][]) {
        if (job.status === 'running') {
          job.status = 'interrupted';
          job.error = 'APP_RESTARTED';
          job.step = 'interrupted';
        }
        job.output = [];
        dbJobs.set(key, job);
      }
      persistJobs();
    }
  } catch { /* ignore read errors */ }

  // Cleanup completed/error jobs after 5 minutes
  function scheduleJobCleanup(key: string) {
    setTimeout(() => {
      dbJobs.delete(key);
      persistJobs();
    }, 5 * 60 * 1000);
  }

  ipcMain.handle('monitor-list-databases', async (_event, data: { projectName: string; projectsDir?: string; odooVersion?: string }) => {
    try {
      const odooVersion = data.odooVersion || DEFAULT_ODOO_VERSION;
      const projectsDir = data.projectsDir || getDefaultProjectsDir(odooVersion);
      const dbConf = readDbConfig(data.projectName, projectsDir);
      if (!dbConf) return { ok: false, msg: 'CONFIG_NOT_FOUND' };

      const connInfo = { host: dbConf.host, port: dbConf.port, user: dbConf.user, adminPasswd: dbConf.adminPasswd };
      const pg = getPgTools(dbConf.password);
      if (!pg) return { ok: false, msg: 'PG_NOT_FOUND', connInfo };

      const psql = path.join(pg.pgBin, 'psql.exe');

      // Fast query: no pg_database_size() — returns instantly
      const fastQuery = `SELECT d.datname, r.rolname as owner, pg_encoding_to_char(d.encoding) as enc_name FROM pg_database d JOIN pg_roles r ON d.datdba = r.oid WHERE d.datistemplate = false ORDER BY d.datname`;
      const { output } = await runCmd(
        `"${psql}" -h ${dbConf.host} -p ${dbConf.port} -U ${dbConf.user} -d postgres -tAF "|" -c "${fastQuery.replace(/"/g, '\\"')}"`,
        undefined, pg.env
      );

      const allDatabases = output.trim().split('\n').filter(Boolean).map(line => {
        const parts = line.split('|');
        return {
          name: (parts[0] || '').trim(),
          size: '',
          owner: (parts[1] || '').trim(),
          encoding: (parts[2] || '').trim(),
        };
      }).filter(db => db.name);

      // Filter databases by project's dbfilter (if set)
      // Normalize: replace literal hyphens with [-_] so filter matches both variants
      // (handles old projects with literal-hyphen dbfilter)
      let databases = allDatabases;
      let dbfilter = dbConf.dbfilter;
      if (dbfilter) {
        try {
          // Auto-upgrade: ^name-with-hyphens → ^name[-_]with[-_]hyphens
          const normalizedFilter = dbfilter.replace(/(?<!\[)-(?!_\])/g, '[-_]');
          const re = new RegExp(normalizedFilter);
          databases = allDatabases.filter(db => re.test(db.name) || db.name === 'postgres');
          dbfilter = normalizedFilter;
        } catch { /* invalid regex — show all */ }
      }

      // Fetch sizes in background and push via IPC event
      const dbNames = databases.map(db => db.name);
      const sizeConf = { host: dbConf.host, port: dbConf.port, user: dbConf.user };
      fetchDbSizesAsync(psql, sizeConf, pg.env, dbNames, data.projectName);

      return { ok: true, databases, connInfo, dbfilter: dbfilter || '' };
    } catch (e) {
      return { ok: false, msg: String(e) };
    }
  });

  ipcMain.handle('monitor-create-database', async (_event, data: {
    projectName: string; dbName: string; demoData?: boolean;
    adminEmail?: string; adminPassword?: string; adminPhone?: string;
    lang?: string; country?: string;
    projectsDir?: string; baseDir?: string; odooVersion?: string; odooSourceDir?: string;
  }) => {
    const dbName = data.dbName;
    if (!dbName || !/^[a-zA-Z_][a-zA-Z0-9_\-]*$/.test(dbName)) return { ok: false, msg: 'INVALID_DB_NAME' };

    const odooVersion = data.odooVersion || DEFAULT_ODOO_VERSION;
    const projectsDir = data.projectsDir || getDefaultProjectsDir(odooVersion);
    const baseDir = data.baseDir || getDefaultBaseDir(odooVersion);
    const odooSourceDir = data.odooSourceDir || 'odoo';
    const dbConf = readDbConfig(data.projectName, projectsDir);
    if (!dbConf) return { ok: false, msg: 'CONFIG_NOT_FOUND' };

    // Check prerequisites
    const prereq = checkPrerequisites(baseDir, odooSourceDir, dbConf.port);
    if (!prereq.ok) return { ok: false, msg: prereq.msg };

    const pg = getPgTools(dbConf.password);
    if (!pg) return { ok: false, msg: 'PG_NOT_FOUND' };

    // Start async job — return immediately
    const jobKey = getJobKey(data.projectName, 'create');
    const job: DbJob = {
      type: 'create', dbName, projectName: data.projectName,
      status: 'running', step: 'creating_db', startTime: Date.now(), output: [],
    };
    dbJobs.set(jobKey, job); persistJobs();

    const emit = (step: string, progress: number, detail?: string) => {
      job.step = step;
      emitDbProgress(data.projectName, 'db-job-progress', {
        type: 'create', dbName, step, detail, status: 'running',
        elapsed: Date.now() - job.startTime, progress,
      });
    };

    // Run in background
    (async () => {
      try {
        // Step 1: Create empty DB
        emit('creating_db', 10);
        const createdb = path.join(pg.pgBin, 'createdb.exe');
        const { code: createCode, output: createOut } = await runCmd(
          `"${createdb}" -h ${dbConf.host} -p ${dbConf.port} -U ${dbConf.user} -E UTF8 "${dbName}"`,
          undefined, pg.env
        );
        if (createCode !== 0 && createOut.includes('already exists')) {
          job.status = 'error'; job.error = 'DB_EXISTS';
          emitDbProgress(data.projectName, 'db-job-progress', { type: 'create', dbName, step: 'error', status: 'error', error: 'DB_EXISTS' });
          scheduleJobCleanup(jobKey);
          return;
        }

        // Step 1b: Enable pgvector extension if this Odoo version needs it
        const vCfg = getVersionConfig(odooVersion);
        if (vCfg.pgvector) {
          emit('init_schema', 20, 'Enabling pgvector extension...');
          const psqlPgvec = path.join(pg.pgBin, 'psql.exe');
          const superEnv = { ...process.env, PGPASSWORD: dbConf.password };
          // Try with project user first, then fallback to postgres superuser
          const { code: vecCode } = await runCmd(
            `"${psqlPgvec}" -h ${dbConf.host} -p ${dbConf.port} -U ${dbConf.user} -d "${dbName}" -c "CREATE EXTENSION IF NOT EXISTS vector;"`,
            undefined, superEnv
          );
          if (vecCode !== 0) {
            // Retry with postgres superuser
            const superPgEnv = { ...process.env, PGPASSWORD: 'postgres' };
            await runCmd(
              `"${psqlPgvec}" -h ${dbConf.host} -p ${dbConf.port} -U postgres -d "${dbName}" -c "CREATE EXTENSION IF NOT EXISTS vector;"`,
              undefined, superPgEnv
            );
          }
        }

        // Step 2: Init Odoo schema with odoo-bin
        emit('init_schema', 30);
        const venvPy = path.join(baseDir, 'venv', 'Scripts', 'python.exe');
        const odooBin = path.join(baseDir, odooSourceDir, 'odoo-bin');
        const projectPath = path.join(projectsDir, data.projectName);

        // Inject PG bin into PATH
        const odooEnv: NodeJS.ProcessEnv = { ...pg.env };
        if (!odooEnv.PATH?.includes(pg.pgBin)) {
          odooEnv.PATH = `${pg.pgBin};${odooEnv.PATH || ''}`;
        }

        const lang = data.lang || 'en_US';
        let initCmd = `"${venvPy}" "${odooBin}" -d "${dbName}" -c "${dbConf.confFile}" -i base --stop-after-init --load-language=${lang}`;
        if (!data.demoData) initCmd += ' --without-demo=all';

        const exitCode = await runCmdStreaming(initCmd, ctx.logger, {
          cwd: projectPath,
          env: odooEnv,
          onData: (line) => {
            job.output.push(line);
            if (job.output.length > 200) job.output.shift();
            emit('init_schema', 30, line);
          },
        });

        if (exitCode !== 0) {
          // Check for common errors in output
          const fullOut = job.output.join('\n');
          let errorMsg = 'INIT_FAILED';
          if (fullOut.includes('Module') && fullOut.includes('not found')) errorMsg = 'MISSING_ADDON';
          job.status = 'error'; job.error = errorMsg;
          emitDbProgress(data.projectName, 'db-job-progress', {
            type: 'create', dbName, step: 'error', status: 'error', error: errorMsg,
            detail: job.output.slice(-5).join('\n'),
          });
          scheduleJobCleanup(jobKey);
          return;
        }

        // Step 3: Configure admin user (email/password/phone/country) via SQL
        emit('configuring_admin', 90);
        const adminEmail = data.adminEmail || 'admin';
        const adminPassword = data.adminPassword || 'admin';
        const psqlExe = path.join(pg.pgBin, 'psql.exe');
        // Update admin login (res_users id=2 is the first real user created by Odoo)
        const safeEmail = adminEmail.replace(/'/g, "''");
        const safePassword = adminPassword.replace(/'/g, "''");
        await runCmd(
          `"${psqlExe}" -h ${dbConf.host} -p ${dbConf.port} -U ${dbConf.user} -d "${dbName}" -c "UPDATE res_users SET login='${safeEmail}' WHERE id=2"`,
          undefined, pg.env
        ).catch(() => {});

        // Set password via odoo-bin (hashed properly)
        await runCmdStreaming(
          `"${venvPy}" "${odooBin}" shell -d "${dbName}" -c "${dbConf.confFile}" --no-http -c "${dbConf.confFile}" <<< "env['res.users'].browse(2).write({'password': '${safePassword}'}); env.cr.commit()"`,
          ctx.logger, { cwd: projectPath, env: odooEnv }
        ).catch(() => {
          // Fallback: just log, password might need manual set
          ctx.logger.log('  > Note: Could not set admin password via shell. Default password may apply.');
        });

        // Set phone if provided
        if (data.adminPhone) {
          const safePhone = data.adminPhone.replace(/'/g, "''");
          await runCmd(
            `"${psqlExe}" -h ${dbConf.host} -p ${dbConf.port} -U ${dbConf.user} -d "${dbName}" -c "UPDATE res_partner SET phone='${safePhone}' WHERE id=(SELECT partner_id FROM res_users WHERE id=2)"`,
            undefined, pg.env
          ).catch(() => {});
        }

        // Set country if provided (country code like 'vn', 'us', etc.)
        if (data.country && /^[a-z]{2}$/i.test(data.country)) {
          const cc = data.country.toLowerCase();
          await runCmd(
            `"${psqlExe}" -h ${dbConf.host} -p ${dbConf.port} -U ${dbConf.user} -d "${dbName}" -c "UPDATE res_company SET country_id=(SELECT id FROM res_country WHERE code ILIKE '${cc}' LIMIT 1) WHERE id=1"`,
            undefined, pg.env
          ).catch(() => {});
        }

        // Done
        job.status = 'done'; job.step = 'done';
        ctx.logger.log(`[monitor] Database created + initialized: ${dbName} (admin: ${adminEmail})`);
        emitDbProgress(data.projectName, 'db-job-progress', {
          type: 'create', dbName, step: 'done', status: 'done',
          elapsed: Date.now() - job.startTime, progress: 100,
        });
        scheduleJobCleanup(jobKey);
      } catch (e) {
        job.status = 'error'; job.error = String(e);
        emitDbProgress(data.projectName, 'db-job-progress', {
          type: 'create', dbName, step: 'error', status: 'error', error: String(e), progress: 0,
        });
        scheduleJobCleanup(jobKey);
      }
    })();

    return { ok: true, msg: 'STARTED' };
  });

  ipcMain.handle('monitor-drop-database', async (_event, data: { projectName: string; dbName: string; projectsDir?: string; odooVersion?: string }) => {
    const dbName = data.dbName;
    if (!dbName || !/^[a-zA-Z_][a-zA-Z0-9_\-]*$/.test(dbName)) return { ok: false, msg: 'INVALID_DB_NAME' };

    // Protect system databases
    const protectedDbs = ['postgres', 'template0', 'template1'];
    if (protectedDbs.includes(dbName.toLowerCase())) return { ok: false, msg: 'PROTECTED_DB' };

    const odooVersion = data.odooVersion || DEFAULT_ODOO_VERSION;
    const projectsDir = data.projectsDir || getDefaultProjectsDir(odooVersion);
    const dbConf = readDbConfig(data.projectName, projectsDir);
    if (!dbConf) return { ok: false, msg: 'CONFIG_NOT_FOUND' };

    let pgSuperPassword = 'postgres';
    const sFile = path.join(app.getPath('userData'), 'user-settings.json');
    try {
      if (fs.existsSync(sFile)) {
        const raw = JSON.parse(fs.readFileSync(sFile, 'utf8'));
        if (raw.pgSuperPassword) pgSuperPassword = raw.pgSuperPassword;
      }
    } catch {}

    const pg = getPgTools(pgSuperPassword);
    if (!pg) return { ok: false, msg: 'PG_NOT_FOUND' };

    // Start async job — return immediately
    const jobKey = getJobKey(data.projectName, 'drop', dbName);
    const job: DbJob = {
      type: 'drop', dbName, projectName: data.projectName,
      status: 'running', step: 'terminating_connections', startTime: Date.now(), output: [],
    };
    dbJobs.set(jobKey, job); persistJobs();

    (async () => {
      try {
        // Step 1: Terminate connections
        emitDbProgress(data.projectName, 'db-job-progress', {
          type: 'drop', dbName, step: 'terminating_connections', status: 'running',
          elapsed: 0, progress: 30,
        });
        const psql = path.join(pg.pgBin, 'psql.exe');
        await runCmd(
          `"${psql}" -h ${dbConf.host} -p ${dbConf.port} -U postgres -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${dbName}' AND pid <> pg_backend_pid()"`,
          undefined, pg.env
        ).catch(() => {});

        // Step 2: Drop database
        job.step = 'dropping_db';
        emitDbProgress(data.projectName, 'db-job-progress', {
          type: 'drop', dbName, step: 'dropping_db', status: 'running',
          elapsed: Date.now() - job.startTime, progress: 70,
        });
        const dropdb = path.join(pg.pgBin, 'dropdb.exe');
        const { code, output } = await runCmd(
          `"${dropdb}" -h ${dbConf.host} -p ${dbConf.port} -U postgres "${dbName}"`,
          undefined, pg.env
        );

        if (code !== 0) {
          job.status = 'error'; job.error = 'DROP_FAILED'; job.step = 'error';
          emitDbProgress(data.projectName, 'db-job-progress', {
            type: 'drop', dbName, step: 'error', status: 'error', error: 'DROP_FAILED',
            detail: output,
          });
          scheduleJobCleanup(jobKey);
          return;
        }

        // Done
        job.status = 'done'; job.step = 'done';
        ctx.logger.log(`[monitor] Database dropped: ${dbName}`);
        emitDbProgress(data.projectName, 'db-job-progress', {
          type: 'drop', dbName, step: 'done', status: 'done',
          elapsed: Date.now() - job.startTime, progress: 100,
        });
        scheduleJobCleanup(jobKey);
      } catch (e) {
        job.status = 'error'; job.error = String(e); job.step = 'error';
        emitDbProgress(data.projectName, 'db-job-progress', {
          type: 'drop', dbName, step: 'error', status: 'error', error: String(e),
        });
        scheduleJobCleanup(jobKey);
      }
    })();

    return { ok: true, msg: 'STARTED' };
  });

  ipcMain.handle('monitor-restore-database', async (_event, data: {
    projectName: string; dbName: string; filePath: string;
    projectsDir?: string; baseDir?: string; odooVersion?: string; odooSourceDir?: string;
  }) => {
    const dbName = data.dbName;
    const filePath = data.filePath;
    if (!dbName || !/^[a-zA-Z_][a-zA-Z0-9_\-]*$/.test(dbName)) return { ok: false, msg: 'INVALID_DB_NAME' };
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, msg: 'FILE_NOT_FOUND' };

    const resolvedFile = path.resolve(filePath);
    if (!fs.statSync(resolvedFile).isFile()) return { ok: false, msg: 'FILE_NOT_FOUND' };

    const odooVersion = data.odooVersion || DEFAULT_ODOO_VERSION;
    const projectsDir = data.projectsDir || getDefaultProjectsDir(odooVersion);
    const baseDir = data.baseDir || getDefaultBaseDir(odooVersion);
    const dbConf = readDbConfig(data.projectName, projectsDir);
    if (!dbConf) return { ok: false, msg: 'CONFIG_NOT_FOUND' };

    const pg = getPgTools(dbConf.password);
    if (!pg) return { ok: false, msg: 'PG_NOT_FOUND' };

    const ext = path.extname(filePath).toLowerCase();

    // Start async job
    const jobKey = getJobKey(data.projectName, 'restore');
    const job: DbJob = {
      type: 'restore', dbName, projectName: data.projectName,
      status: 'running', step: 'preparing', startTime: Date.now(), output: [],
    };
    dbJobs.set(jobKey, job);

    const emit = (step: string, progress: number, detail?: string) => {
      job.step = step;
      emitDbProgress(data.projectName, 'db-job-progress', {
        type: 'restore', dbName, step, detail, status: 'running',
        elapsed: Date.now() - job.startTime, progress,
        objectCount: job.output.length,
      });
    };

    (async () => {
      try {
        let dumpFile = resolvedFile;
        let tempDir = '';
        let hasFilestore = false;

        // Step 1: Extract .zip if needed
        if (ext === '.zip') {
          emit('extracting', 10);
          tempDir = path.join(app.getPath('temp'), `odoo-restore-${Date.now()}`);
          fs.mkdirSync(tempDir, { recursive: true });
          await runCmd(`powershell -NoProfile -Command "Expand-Archive -Path '${resolvedFile}' -DestinationPath '${tempDir}' -Force"`);

          // Find dump file inside zip
          const dumpSql = path.join(tempDir, 'dump.sql');
          const dumpBin = path.join(tempDir, 'dump.dump');
          if (fs.existsSync(dumpBin)) dumpFile = dumpBin;
          else if (fs.existsSync(dumpSql)) dumpFile = dumpSql;
          else {
            // Search recursively for dump file
            const files = fs.readdirSync(tempDir);
            const found = files.find(f => f.endsWith('.dump') || f.endsWith('.sql'));
            if (found) dumpFile = path.join(tempDir, found);
            else {
              job.status = 'error'; job.error = 'NO_DUMP_IN_ZIP';
              emitDbProgress(data.projectName, 'db-job-progress', { type: 'restore', dbName, step: 'error', status: 'error', error: 'NO_DUMP_IN_ZIP' });
              scheduleJobCleanup(jobKey);
              try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
              return;
            }
          }
          hasFilestore = fs.existsSync(path.join(tempDir, 'filestore'));
        }

        // Step 2: Create empty DB
        emit('creating_db', 20);
        const createdb = path.join(pg.pgBin, 'createdb.exe');
        const { code: cCode, output: cOut } = await runCmd(
          `"${createdb}" -h ${dbConf.host} -p ${dbConf.port} -U ${dbConf.user} -E UTF8 "${dbName}"`,
          undefined, pg.env
        );
        if (cCode !== 0 && cOut.includes('already exists')) {
          job.status = 'error'; job.error = 'DB_EXISTS';
          emitDbProgress(data.projectName, 'db-job-progress', { type: 'restore', dbName, step: 'error', status: 'error', error: 'DB_EXISTS' });
          scheduleJobCleanup(jobKey);
          if (tempDir) try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
          return;
        }

        // Step 2b: Enable pgvector extension if this Odoo version needs it
        const restoreVCfg = getVersionConfig(odooVersion);
        if (restoreVCfg.pgvector) {
          emit('restoring_data', 25, 'Enabling pgvector extension...');
          const psqlPgvec = path.join(pg.pgBin, 'psql.exe');
          const { code: vecCode } = await runCmd(
            `"${psqlPgvec}" -h ${dbConf.host} -p ${dbConf.port} -U ${dbConf.user} -d "${dbName}" -c "CREATE EXTENSION IF NOT EXISTS vector;"`,
            undefined, pg.env
          );
          if (vecCode !== 0) {
            const superPgEnv = { ...process.env, PGPASSWORD: 'postgres' };
            await runCmd(
              `"${psqlPgvec}" -h ${dbConf.host} -p ${dbConf.port} -U postgres -d "${dbName}" -c "CREATE EXTENSION IF NOT EXISTS vector;"`,
              undefined, superPgEnv
            );
          }
        }

        // Step 3: Restore dump with streaming
        emit('restoring_data', 30);
        const dumpExt = path.extname(dumpFile).toLowerCase();
        const pgEnv: NodeJS.ProcessEnv = { ...pg.env };
        if (!pgEnv.PATH?.includes(pg.pgBin)) pgEnv.PATH = `${pg.pgBin};${pgEnv.PATH || ''}`;

        let restoreCmd: string;
        if (dumpExt === '.dump') {
          const pgRestore = path.join(pg.pgBin, 'pg_restore.exe');
          restoreCmd = `"${pgRestore}" -h ${dbConf.host} -p ${dbConf.port} -U ${dbConf.user} -d "${dbName}" --no-owner --no-privileges --verbose "${dumpFile}"`;
        } else {
          const psql = path.join(pg.pgBin, 'psql.exe');
          restoreCmd = `"${psql}" -h ${dbConf.host} -p ${dbConf.port} -U ${dbConf.user} -d "${dbName}" -f "${dumpFile}"`;
        }

        const exitCode = await runCmdStreaming(restoreCmd, ctx.logger, {
          env: pgEnv,
          onData: (line) => {
            job.output.push(line);
            if (job.output.length > 200) job.output.shift();
            // Emit progress every 10 objects to avoid flooding
            if (job.output.length % 10 === 0) emit('restoring_data', 30, line);
          },
        });

        if (exitCode !== 0 && dumpExt !== '.dump') {
          // psql may return non-zero but data is still restored; pg_restore --verbose also returns warnings
          const lastLines = job.output.slice(-10).join('\n');
          if (lastLines.includes('FATAL') || lastLines.includes('does not exist')) {
            job.status = 'error'; job.error = 'RESTORE_FAILED';
            emitDbProgress(data.projectName, 'db-job-progress', {
              type: 'restore', dbName, step: 'error', status: 'error', error: 'RESTORE_FAILED',
              detail: job.output.slice(-5).join('\n'),
            });
            scheduleJobCleanup(jobKey);
            if (tempDir) try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
            return;
          }
        }

        // Step 4: Copy filestore if .zip had one
        if (hasFilestore && tempDir) {
          emit('copying_filestore', 85);
          const dataDir = dbConf.dataDir || path.join(projectsDir, data.projectName, 'data');
          const destFilestore = path.join(dataDir, 'filestore', dbName);
          const srcFilestore = path.join(tempDir, 'filestore');

          if (!fs.existsSync(path.dirname(destFilestore))) {
            fs.mkdirSync(path.dirname(destFilestore), { recursive: true });
          }
          // Use robocopy for large filestore (faster than Node.js copy)
          await runCmd(`robocopy "${srcFilestore}" "${destFilestore}" /E /NFL /NDL /NJH /NJS /NC /NS`).catch(() => {});
        }

        // Cleanup temp dir
        if (tempDir) {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
        }

        // Done
        job.status = 'done'; job.step = 'done';
        ctx.logger.log(`[monitor] Database restored: ${dbName} from ${path.basename(filePath)} (${job.output.length} objects)`);
        emitDbProgress(data.projectName, 'db-job-progress', {
          type: 'restore', dbName, step: 'done', status: 'done',
          elapsed: Date.now() - job.startTime, objectCount: job.output.length, progress: 100,
        });
        scheduleJobCleanup(jobKey);
      } catch (e) {
        job.status = 'error'; job.error = String(e);
        emitDbProgress(data.projectName, 'db-job-progress', {
          type: 'restore', dbName, step: 'error', status: 'error', error: String(e), progress: 0,
        });
        scheduleJobCleanup(jobKey);
      }
    })();

    return { ok: true, msg: 'STARTED' };
  });

  // --- DB Job status (for reconnecting after Monitor close/reopen) ---
  ipcMain.handle('monitor-db-job-status', async (_event, data: { projectName: string }) => {
    const jobs: DbJob[] = [];
    for (const [, job] of dbJobs) {
      if (job.projectName === data.projectName) jobs.push(job);
    }
    return { ok: true, jobs };
  });

  // --- Dismiss a completed/error/interrupted DB job ---
  ipcMain.handle('monitor-dismiss-db-job', async (_event, data: { projectName: string; type: string; dbName?: string }) => {
    const key = getJobKey(data.projectName, data.type, data.dbName);
    dbJobs.delete(key);
    persistJobs();
    return { ok: true };
  });
}

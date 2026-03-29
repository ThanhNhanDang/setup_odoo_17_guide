import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, execSync, execFile, exec } from 'child_process';
import { PG_SCAN_VERSIONS } from './odoo-versions';

// ---------------------------------------------------------------------------
// Async exec helper — wraps callback exec into Promise with timeout
// ---------------------------------------------------------------------------

function execAsync(cmd: string, opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, {
      timeout: opts.timeout ?? 2000,
      windowsHide: true,
      encoding: 'utf8',
      env: opts.env ?? process.env,
      shell: 'cmd.exe',
    } as any, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(String(stdout || ''));
    });
  });
}

// ---------------------------------------------------------------------------
// .lnk shortcut parser — reads target path from Windows Shell Link binary
// Reference: [MS-SHLLINK] https://docs.microsoft.com/en-us/openspecs/windows_protocols/ms-shllink
// ---------------------------------------------------------------------------

function readLnkTarget(lnkPath: string): string | null {
  try {
    const buf = fs.readFileSync(lnkPath);
    // Validate header magic: 4C 00 00 00
    if (buf.length < 76 || buf.readUInt32LE(0) !== 0x0000004C) return null;

    const flags = buf.readUInt32LE(0x14);
    let offset = 76; // HeaderSize

    // If HasLinkTargetIDList flag (bit 0), skip the IDList
    if (flags & 0x01) {
      if (offset + 2 > buf.length) return null;
      const idListSize = buf.readUInt16LE(offset);
      offset += 2 + idListSize;
    }

    // If HasLinkInfo flag (bit 1), parse LinkInfo for LocalBasePath
    if (flags & 0x02) {
      if (offset + 4 > buf.length) return null;
      const linkInfoStart = offset;
      const linkInfoSize = buf.readUInt32LE(offset);
      if (linkInfoSize < 28) return null;

      const linkInfoFlags = buf.readUInt32LE(offset + 8);
      // VolumeIDAndLocalBasePath flag (bit 0)
      if (linkInfoFlags & 0x01) {
        const localBasePathOffset = buf.readUInt32LE(offset + 16);
        const pathStart = linkInfoStart + localBasePathOffset;
        // Read null-terminated string
        let end = pathStart;
        while (end < buf.length && buf[end] !== 0) end++;
        const targetPath = buf.slice(pathStart, end).toString('utf8');
        if (targetPath && targetPath.includes('\\')) return targetPath;
      }

      offset += linkInfoSize;
    }

    // Fallback: scan buffer for path pattern (e.g., "X:\...\Code.exe")
    const content = buf.toString('utf8', 76, Math.min(buf.length, 2048));
    const match = content.match(/[A-Z]:\\[^\0]+?Code\.exe/i);
    if (match) return match[0];

    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Detection Functions
// Ports: find_python311, find_postgres_bin, find_docker,
//        find_docker_postgres, detect_native_postgres_details
// ---------------------------------------------------------------------------

export interface DockerContainer {
  readonly name: string;
  readonly image: string;
  readonly port: string;
  readonly status: string;
}

export interface NativePostgresDetails {
  readonly data_dir: string;
  readonly port: string;
  readonly is_ready: boolean;
  readonly databases: readonly string[];
  readonly bin_path: string;
}

/**
 * Find Python installation for a specific Odoo version.
 * Uses version-specific candidate paths from the version registry.
 */
export function findPython(candidates: readonly string[]): string | null {
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Find Python via py launcher for a specific version prefix (e.g. '3.11').
 * Returns the python.exe path if found, null otherwise.
 */
export function findPythonViaLauncher(versionPrefix: string): string | null {
  try {
    const result = require('child_process').execSync(
      `py -${versionPrefix} -c "import sys; print(sys.executable)"`,
      { encoding: 'utf8', timeout: 5000, windowsHide: true }
    ).trim();
    if (result && fs.existsSync(result)) return result;
  } catch { /* py launcher not available */ }
  return null;
}

/**
 * Find Python 3.11 installation path (backward compat wrapper).
 * Checks: LOCALAPPDATA, C:\Python311, C:\Program Files\Python311
 */
export function findPython311(): string | null {
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(localAppData, 'Programs', 'Python', 'Python311', 'python.exe'),
    'C:\\Python311\\python.exe',
    'C:\\Program Files\\Python311\\python.exe',
  ];
  return findPython(candidates) || findPythonViaLauncher('3.11');
}

/**
 * Find PostgreSQL bin directory (checks versions 17 down to 14).
 */
export function findPostgresBin(): string | null {
  for (const ver of PG_SCAN_VERSIONS) {
    const binDir = `C:\\Program Files\\PostgreSQL\\${ver}\\bin`;
    if (fs.existsSync(path.join(binDir, 'psql.exe'))) {
      return binDir;
    }
  }
  return null;
}

/**
 * Find the PostgreSQL instance that is listening on a specific port.
 * Returns bin path and data_dir, or null if not found.
 */
export function findPostgresForPort(targetPort: string): { binPath: string; dataDir: string; version: string; serviceName: string } | null {
  for (const ver of PG_SCAN_VERSIONS) {
    const binDir = `C:\\Program Files\\PostgreSQL\\${ver}\\bin`;
    const dataDir = `C:\\Program Files\\PostgreSQL\\${ver}\\data`;
    if (!fs.existsSync(path.join(binDir, 'psql.exe'))) continue;

    // Read port from postgresql.conf
    const confFile = path.join(dataDir, 'postgresql.conf');
    let port = '5432';
    if (fs.existsSync(confFile)) {
      try {
        const content = fs.readFileSync(confFile, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('port') && trimmed.includes('=')) {
            port = trimmed.split('=')[1].trim().split('#')[0].trim();
            break;
          }
        }
      } catch { /* ignore */ }
    }

    if (port === targetPort) {
      return {
        binPath: binDir,
        dataDir,
        version: ver,
        serviceName: `postgresql-x64-${ver}`,
      };
    }
  }
  return null;
}

/**
 * Find VS Code installation. Returns path to code.exe or null.
 * Checks: PATH (code --version), standard install locations.
 */
export function findVSCode(): string | null {
  // Check if 'code' is in PATH
  try {
    const output = execFileSync('cmd.exe', ['/c', 'code --version'], {
      timeout: 5000,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const ver = output.trim().split('\n')[0]?.trim();
    if (ver && /^\d+\.\d+/.test(ver)) return 'code'; // Available in PATH
  } catch {
    // not in PATH
  }

  // Check standard install locations
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const candidates = [
    path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(programFiles, 'Microsoft VS Code', 'Code.exe'),
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    'C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe',
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }

  // Check Start Menu shortcuts for VS Code (.lnk files)
  // Parse .lnk binary directly (no PowerShell dependency)
  const startMenuDirs = [
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs',
  ];
  for (const menuDir of startMenuDirs) {
    try {
      if (!fs.existsSync(menuDir)) continue;
      const findLnk = (dir: string): string | null => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const found = findLnk(fullPath);
            if (found) return found;
          } else if (
            entry.name.toLowerCase().includes('code') &&
            entry.name.endsWith('.lnk')
          ) {
            const target = readLnkTarget(fullPath);
            if (target && target.toLowerCase().endsWith('code.exe') && fs.existsSync(target)) {
              return target;
            }
          }
        }
        return null;
      };
      const found = findLnk(menuDir);
      if (found) return found;
    } catch { /* menu dir not accessible */ }
  }

  return null;
}

/**
 * Get VS Code version string (if installed).
 */
export function getVSCodeVersion(): string {
  // Try 'code --version' from PATH first
  try {
    const output = execFileSync('cmd.exe', ['/c', 'code --version'], {
      timeout: 5000,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // First line is version number (e.g., "1.96.0")
    const ver = output.trim().split('\n')[0].trim();
    if (ver) return ver;
  } catch { /* not in PATH */ }

  // Try extracting version from portable path (e.g., VSCode-win32-x64-1.109.5)
  try {
    const vscodePath = findVSCode();
    if (vscodePath && vscodePath !== 'code') {
      const dirName = path.basename(path.dirname(vscodePath));
      const match = dirName.match(/(\d+\.\d+\.\d+)/);
      if (match) return match[1];
    }
  } catch {
    // portable path not accessible
  }

  return '';
}

/**
 * Check if Git is installed. Returns version string or null.
 */
export function findGit(): string | null {
  try {
    const output = execFileSync('cmd.exe', ['/c', 'git --version'], {
      timeout: 5000,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // "git version 2.47.1.windows.2"
    const match = output.trim().match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : output.trim();
  } catch {
    return null;
  }
}

/**
 * Check if Docker is available.
 */
export function findDocker(): boolean {
  try {
    execFileSync('cmd.exe', ['/c', 'docker --version'], {
      timeout: 5000,
      windowsHide: true,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find running Docker PostgreSQL containers.
 */
export function findDockerPostgres(): readonly DockerContainer[] {
  try {
    const output = execFileSync('cmd.exe', [
      '/c',
      'docker ps --format "{{.Names}}\\t{{.Image}}\\t{{.Ports}}\\t{{.Status}}"',
    ], {
      timeout: 10000,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const containers: DockerContainer[] = [];
    if (!output.trim()) return containers;

    for (const line of output.trim().split('\n')) {
      const parts = line.split('\t');
      if (parts.length >= 3 && parts[1].toLowerCase().includes('postgres')) {
        let port = '';
        for (const mapping of parts[2].split(',')) {
          const trimmed = mapping.trim();
          if (trimmed.includes('->5432') && trimmed.includes(':')) {
            port = trimmed.split(':')[1].split('->')[0];
            break;
          }
        }
        containers.push({
          name: parts[0],
          image: parts[1],
          port,
          status: parts.length > 3 ? parts[3] : '',
        });
      }
    }
    return containers;
  } catch {
    return [];
  }
}

/**
 * Detect native PostgreSQL installation details.
 */
export function detectNativePostgresDetails(): NativePostgresDetails | null {
  const pgBin = findPostgresBin();
  if (!pgBin) return null;

  const result: {
    data_dir: string;
    port: string;
    is_ready: boolean;
    databases: string[];
    bin_path: string;
  } = {
    data_dir: '',
    port: '',
    is_ready: false,
    databases: [],
    bin_path: pgBin,
  };

  // Find data dir and port from postgresql.conf
  for (const ver of PG_SCAN_VERSIONS) {
    const dataDir = `C:\\Program Files\\PostgreSQL\\${ver}\\data`;
    if (fs.existsSync(dataDir) && fs.statSync(dataDir).isDirectory()) {
      result.data_dir = dataDir;
      const confFile = path.join(dataDir, 'postgresql.conf');
      if (fs.existsSync(confFile)) {
        try {
          const content = fs.readFileSync(confFile, 'utf8');
          for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('port') && trimmed.includes('=')) {
              result.port = trimmed.split('=')[1].trim().split('#')[0].trim();
              break;
            }
          }
        } catch {
          // ignore read errors
        }
      }
      break;
    }
  }

  // Check pg_isready
  const port = result.port || '5432';
  const pgIsready = path.join(pgBin, 'pg_isready.exe');
  if (fs.existsSync(pgIsready)) {
    try {
      execSync(`"${pgIsready}" -p ${port}`, {
        timeout: 5000,
        windowsHide: true,
        stdio: 'pipe',
      });
      result.is_ready = true;
    } catch {
      result.is_ready = false;
    }
  }

  // List databases
  if (result.is_ready) {
    const psql = path.join(pgBin, 'psql.exe');
    try {
      const env = { ...process.env, PGPASSWORD: 'postgres' };
      const output = execSync(
        `"${psql}" -U postgres -p ${port} --no-password -tAc "SELECT datname FROM pg_database WHERE datistemplate=false"`,
        {
          timeout: 10000,
          windowsHide: true,
          encoding: 'utf8',
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      ) as string;
      if (output.trim()) {
        result.databases = output.trim().split('\n')
          .map(db => db.trim())
          .filter(Boolean);
      }
    } catch {
      // ignore errors
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Async Detection Functions — for parallel execution in detectStatus
// ---------------------------------------------------------------------------

/** Async findVSCode: check file paths first (fast), then PATH (slow) */
export async function findVSCodeAsync(): Promise<{ path: string | null; version: string }> {
  // 1. Fast: check standard install locations
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const candidates = [
    path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(programFiles, 'Microsoft VS Code', 'Code.exe'),
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    'C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe',
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return { path: p, version: '' };
  }

  // 2. Fast: check Start Menu shortcuts
  const startMenuDirs = [
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs',
  ];
  for (const menuDir of startMenuDirs) {
    try {
      if (!fs.existsSync(menuDir)) continue;
      const findLnk = (dir: string): string | null => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const found = findLnk(fullPath);
            if (found) return found;
          } else if (entry.name.toLowerCase().includes('code') && entry.name.endsWith('.lnk')) {
            const target = readLnkTarget(fullPath);
            if (target && target.toLowerCase().endsWith('code.exe') && fs.existsSync(target)) return target;
          }
        }
        return null;
      };
      const found = findLnk(menuDir);
      if (found) {
        const dirName = path.basename(path.dirname(found));
        const match = dirName.match(/(\d+\.\d+\.\d+)/);
        return { path: found, version: match ? match[1] : '' };
      }
    } catch { /* ignore */ }
  }

  // 3. Slow: check PATH (async, 2s timeout)
  try {
    const output = await execAsync('code --version', { timeout: 2000 });
    const ver = output.trim().split('\n')[0]?.trim();
    if (ver && /^\d+\.\d+/.test(ver)) return { path: 'code', version: ver };
  } catch { /* not in PATH */ }

  return { path: null, version: '' };
}

/**
 * Find wkhtmltopdf installation. Returns path to wkhtmltopdf.exe or null.
 * Checks: Program Files paths, then PATH.
 */
export function findWkhtmltopdf(): string | null {
  const candidates = [
    'C:\\Program Files\\wkhtmltopdf\\bin\\wkhtmltopdf.exe',
    'C:\\Program Files (x86)\\wkhtmltopdf\\bin\\wkhtmltopdf.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Check PATH
  try {
    const output = execFileSync('cmd.exe', ['/c', 'wkhtmltopdf --version'], {
      timeout: 5000,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (output.includes('wkhtmltopdf')) return 'wkhtmltopdf';
  } catch { /* not in PATH */ }
  return null;
}

/** Async findWkhtmltopdf */
export async function findWkhtmltopdfAsync(): Promise<string | null> {
  // Fast: check file paths
  const candidates = [
    'C:\\Program Files\\wkhtmltopdf\\bin\\wkhtmltopdf.exe',
    'C:\\Program Files (x86)\\wkhtmltopdf\\bin\\wkhtmltopdf.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Slow: check PATH
  try {
    const output = await execAsync('wkhtmltopdf --version', { timeout: 2000 });
    if (output.includes('wkhtmltopdf')) return 'wkhtmltopdf';
  } catch { /* not in PATH */ }
  return null;
}

/** Async findGit */
export async function findGitAsync(): Promise<string | null> {
  // Fast: check common path
  if (fs.existsSync('C:\\Program Files\\Git\\cmd\\git.exe')) return 'C:\\Program Files\\Git\\cmd\\git.exe';
  // Slow: check PATH
  try {
    const output = await execAsync('git --version', { timeout: 2000 });
    const match = output.trim().match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : output.trim();
  } catch { return null; }
}

/** Async findDocker */
export async function findDockerAsync(): Promise<boolean> {
  try {
    await execAsync('docker --version', { timeout: 2000 });
    return true;
  } catch { return false; }
}

/** Async findDockerPostgres */
export async function findDockerPostgresAsync(): Promise<readonly DockerContainer[]> {
  try {
    const output = await execAsync(
      'docker ps --format "{{.Names}}\\t{{.Image}}\\t{{.Ports}}\\t{{.Status}}"',
      { timeout: 2000 }
    );
    const containers: DockerContainer[] = [];
    if (!output.trim()) return containers;
    for (const line of output.trim().split('\n')) {
      const parts = line.split('\t');
      if (parts.length >= 3 && parts[1].toLowerCase().includes('postgres')) {
        let port = '';
        for (const mapping of parts[2].split(',')) {
          const trimmed = mapping.trim();
          if (trimmed.includes('->5432') && trimmed.includes(':')) {
            port = trimmed.split(':')[1].split('->')[0];
            break;
          }
        }
        containers.push({ name: parts[0], image: parts[1], port, status: parts.length > 3 ? parts[3] : '' });
      }
    }
    return containers;
  } catch { return []; }
}

/** Async detectNativePostgresDetails */
export async function detectNativePostgresDetailsAsync(): Promise<NativePostgresDetails | null> {
  const pgBin = findPostgresBin();
  if (!pgBin) return null;

  const result: { data_dir: string; port: string; is_ready: boolean; databases: string[]; bin_path: string } = {
    data_dir: '', port: '', is_ready: false, databases: [], bin_path: pgBin,
  };

  // Find data dir + port (fast, file reads only)
  for (const ver of PG_SCAN_VERSIONS) {
    const dataDir = `C:\\Program Files\\PostgreSQL\\${ver}\\data`;
    if (fs.existsSync(dataDir) && fs.statSync(dataDir).isDirectory()) {
      result.data_dir = dataDir;
      const confFile = path.join(dataDir, 'postgresql.conf');
      if (fs.existsSync(confFile)) {
        try {
          const content = fs.readFileSync(confFile, 'utf8');
          for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('port') && trimmed.includes('=')) {
              result.port = trimmed.split('=')[1].trim().split('#')[0].trim();
              break;
            }
          }
        } catch { /* ignore */ }
      }
      break;
    }
  }

  // pg_isready (async)
  const port = result.port || '5432';
  const pgIsready = path.join(pgBin, 'pg_isready.exe');
  if (fs.existsSync(pgIsready)) {
    try {
      await execAsync(`"${pgIsready}" -p ${port}`, { timeout: 3000 });
      result.is_ready = true;
    } catch { result.is_ready = false; }
  }

  // List databases (async)
  if (result.is_ready) {
    const psql = path.join(pgBin, 'psql.exe');
    try {
      const env = { ...process.env, PGPASSWORD: 'postgres' };
      const output = await execAsync(
        `"${psql}" -U postgres -p ${port} --no-password -tAc "SELECT datname FROM pg_database WHERE datistemplate=false"`,
        { timeout: 5000, env }
      );
      if (output.trim()) {
        result.databases = output.trim().split('\n').map(db => db.trim()).filter(Boolean);
      }
    } catch { /* ignore */ }
  }

  return result;
}

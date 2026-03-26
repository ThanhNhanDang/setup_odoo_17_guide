import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

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
 * Find Python 3.11 installation path.
 * Checks: LOCALAPPDATA, C:\Python311, C:\Program Files\Python311
 */
export function findPython311(): string | null {
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(localAppData, 'Programs', 'Python', 'Python311', 'python.exe'),
    'C:\\Python311\\python.exe',
    'C:\\Program Files\\Python311\\python.exe',
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Find PostgreSQL bin directory (checks versions 17 down to 14).
 */
export function findPostgresBin(): string | null {
  for (const ver of ['17', '16', '15', '14']) {
    const binDir = `C:\\Program Files\\PostgreSQL\\${ver}\\bin`;
    if (fs.existsSync(path.join(binDir, 'psql.exe'))) {
      return binDir;
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
    if (output.trim()) return 'code'; // Available in PATH
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
  return null;
}

/**
 * Get VS Code version string (if installed).
 */
export function getVSCodeVersion(): string {
  try {
    const output = execFileSync('cmd.exe', ['/c', 'code --version'], {
      timeout: 5000,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // First line is version number (e.g., "1.96.0")
    return output.trim().split('\n')[0].trim();
  } catch {
    return '';
  }
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
  for (const ver of ['17', '16', '15', '14']) {
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
      execFileSync('cmd.exe', ['/c', `"${pgIsready}" -p ${port}`], {
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
      const output = execFileSync('cmd.exe', [
        '/c',
        `"${psql}" -U postgres -p ${port} --no-password -tAc "SELECT datname FROM pg_database WHERE datistemplate=false"`,
      ], {
        timeout: 10000,
        windowsHide: true,
        encoding: 'utf8',
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
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

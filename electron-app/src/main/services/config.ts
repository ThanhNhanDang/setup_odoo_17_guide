import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { getVersionConfig, DEFAULT_ODOO_VERSION, type OdooVersionKey } from './odoo-versions';

// ---------------------------------------------------------------------------
// Config Constants
// ---------------------------------------------------------------------------

function resolveDefaultDir(preferred: string, fallback: string): string {
  // Use preferred path if drive exists, otherwise fallback to C:\
  const drive = preferred.substring(0, 3); // e.g. "D:\"
  try {
    if (fs.existsSync(drive)) return preferred;
  } catch {
    // drive doesn't exist
  }
  return fallback;
}

/**
 * Get default base directory for a specific Odoo version.
 */
export function getDefaultBaseDir(version: string = DEFAULT_ODOO_VERSION): string {
  const config = getVersionConfig(version);
  return resolveDefaultDir(
    `D:\\workspaces\\${config.baseDirSuffix}`,
    `C:\\odoo\\${config.baseDirSuffix}`
  );
}

/**
 * Get default projects directory for a specific Odoo version.
 */
export function getDefaultProjectsDir(version: string = DEFAULT_ODOO_VERSION): string {
  const config = getVersionConfig(version);
  return resolveDefaultDir(
    `D:\\workspaces\\projects\\${config.defaultProjectsSubdir}`,
    `C:\\odoo\\projects\\${config.defaultProjectsSubdir}`
  );
}

// Backward compat — existing code that imports these constants still works
export const DEFAULT_BASE_DIR = getDefaultBaseDir('17');
export const DEFAULT_PROJECTS_DIR = getDefaultProjectsDir('17');

// Version-independent URLs
export const ODOO_GIT_URL = 'https://github.com/odoo/odoo.git';
export const VSCODE_URL = 'https://update.code.visualstudio.com/latest/win32-x64-user/stable';
export const GIT_URL = 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.2/Git-2.47.1.2-64-bit.exe';

// Version-specific URLs — use getVersionConfig(version).pythonUrl / .postgresUrl instead
// Kept for backward compat with any direct imports
export const PYTHON_311_URL = getVersionConfig('17').pythonUrl;
export const POSTGRES_URL = getVersionConfig('17').postgresUrl;
export const ODOO_BRANCH = getVersionConfig('17').branch;

export const PROJECT_DEFAULTS: Readonly<Record<string, string>> = {
  addons_path: './addons,./odoo/addons',
  admin_passwd: 'odoo',
  http_port: '8069',
  gevent_port: '',
  db_host: 'localhost',
  db_port: '5434',
  db_user: 'odoo',
  db_password: 'odoo',
  log_level: 'error',
  log_handler: ':ERROR',
  // Windows-safe default: workers=0 (threaded).
  // Prefork (workers>0) chỉ chạy native trên Linux. Windows bị lỗi
  // `orm_signaling_registry does not exist` nếu bật prefork.
  workers: '0',
  // 2.5GB hard / 2GB soft — đủ cho dev, không ăn hết RAM như 10GB trước đây.
  limit_memory_hard: '2684354560',
  limit_memory_soft: '2147483648',
  list_db: 'True',
  dbfilter: '',
  // proxy_mode: True is required for Nginx reverse proxy to pass websocket connections correctly.
  proxy_mode: 'True',
  server_wide_modules: 'base,web',
  data_dir: '',
};

/**
 * Get the templates directory path.
 * In development: relative to project root.
 * In production (packaged): inside extraResources.
 */
export function getTemplatesDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'templates');
  }
  return path.join(__dirname, '..', '..', '..', 'templates');
}

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

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

export const DEFAULT_BASE_DIR = resolveDefaultDir(
  'D:\\workspaces\\odoo_17_base',
  'C:\\odoo17\\odoo_17_base'
);
export const DEFAULT_PROJECTS_DIR = resolveDefaultDir(
  'D:\\workspaces\\projects\\odoo17',
  'C:\\odoo17\\projects'
);

export const PYTHON_311_URL = 'https://www.python.org/ftp/python/3.11.4/python-3.11.4-amd64.exe';
export const POSTGRES_URL = 'https://get.enterprisedb.com/postgresql/postgresql-16.6-1-windows-x64.exe';
export const ODOO_GIT_URL = 'https://github.com/odoo/odoo.git';
export const ODOO_BRANCH = '17.0';
export const VSCODE_URL = 'https://update.code.visualstudio.com/latest/win32-x64/stable';

export const PROJECT_DEFAULTS: Readonly<Record<string, string>> = {
  addons_path: './addons,./odoo/addons',
  admin_passwd: 'odoo',
  http_port: '8069',
  longpolling_port: '',
  db_host: 'localhost',
  db_port: '5434',
  db_user: 'odoo',
  db_password: 'odoo',
  log_level: 'error',
  workers: '0',
  limit_memory_hard: '10737418240',
  limit_memory_soft: '10737418240',
  list_db: 'True',
  dbfilter: '',
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

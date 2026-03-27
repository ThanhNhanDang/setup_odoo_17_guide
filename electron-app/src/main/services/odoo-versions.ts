// ---------------------------------------------------------------------------
// Odoo Version Registry — single source of truth for version-specific config
// ---------------------------------------------------------------------------

export type OdooVersionKey = '15' | '17' | '19';

export interface OdooVersionConfig {
  readonly key: OdooVersionKey;
  readonly label: string;
  readonly branch: string;
  readonly pythonVersion: string;
  readonly pythonUrl: string;
  readonly pythonVersionPrefix: string;
  readonly pythonDirName: string;            // e.g. 'Python310', 'Python311', 'Python312'
  readonly postgresVersion: string;
  readonly postgresUrl: string;
  readonly postgresDockerImage: string;
  readonly pgvector: boolean;                // Odoo 19 needs pgvector for AI modules
  readonly baseDirSuffix: string;            // e.g. 'odoo_15_base'
  readonly defaultProjectsSubdir: string;    // e.g. 'odoo15'
  readonly color: string;                    // badge color
  readonly extraPipPackages: readonly string[];  // extra pip packages beyond requirements.txt
}

// Common extra packages shared across all versions
// NOTE: cryptography + pyOpenSSL must be upgraded together to avoid
// "X509_V_FLAG_NOTIFY_POLICY" AttributeError from version mismatch.
const COMMON_EXTRA_PACKAGES: readonly string[] = [
  'cryptography>=42.0',
  'pyOpenSSL>=24.0',
  'debugpy',
  'openpyxl',
  'numpy',
  'pandas',
  'python-docx',
  'python-pptx',
  'python-barcode',
  'reportlab_qrcode',
  'pdf2image',
  'genshi',
  'py3o.template',
  'pyodbc',
  'sqlparse',
  'python-socketio',
  'python-engineio',
  'bidict',
  'typing_extensions',
  'google-api-python-client',
  'httpagentparser',
  'paho-mqtt',
  'unoconv',
];

export const ODOO_VERSIONS: Readonly<Record<OdooVersionKey, OdooVersionConfig>> = {
  '15': {
    key: '15',
    label: 'Odoo 15',
    branch: '15.0',
    pythonVersion: 'Python 3.10',
    pythonUrl: 'https://www.python.org/ftp/python/3.10.11/python-3.10.11-amd64.exe',
    pythonVersionPrefix: '3.10',
    pythonDirName: 'Python310',
    postgresVersion: '14',
    postgresUrl: 'https://get.enterprisedb.com/postgresql/postgresql-14.15-1-windows-x64.exe',
    postgresDockerImage: 'postgres:14',
    pgvector: false,
    baseDirSuffix: 'odoo_15_base',
    defaultProjectsSubdir: 'odoo15',
    color: '#3b82f6',   // blue
    extraPipPackages: [...COMMON_EXTRA_PACKAGES, 'PyPDF2>=3.0'],
  },
  '17': {
    key: '17',
    label: 'Odoo 17',
    branch: '17.0',
    pythonVersion: 'Python 3.11',
    pythonUrl: 'https://www.python.org/ftp/python/3.11.4/python-3.11.4-amd64.exe',
    pythonVersionPrefix: '3.11',
    pythonDirName: 'Python311',
    postgresVersion: '16',
    postgresUrl: 'https://get.enterprisedb.com/postgresql/postgresql-16.6-1-windows-x64.exe',
    postgresDockerImage: 'postgres:16',
    pgvector: false,
    baseDirSuffix: 'odoo_17_base',
    defaultProjectsSubdir: 'odoo17',
    color: '#f0883e',   // orange (current accent)
    extraPipPackages: [...COMMON_EXTRA_PACKAGES, 'PyPDF2>=3.0'],
  },
  '19': {
    key: '19',
    label: 'Odoo 19',
    branch: 'master',   // Update to '19.0' when branch is created
    pythonVersion: 'Python 3.12',
    pythonUrl: 'https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe',
    pythonVersionPrefix: '3.12',
    pythonDirName: 'Python312',
    postgresVersion: '16',
    postgresUrl: 'https://get.enterprisedb.com/postgresql/postgresql-16.6-1-windows-x64.exe',
    postgresDockerImage: 'pgvector/pgvector:pg16',  // pgvector image for AI modules
    pgvector: true,
    baseDirSuffix: 'odoo_19_base',
    defaultProjectsSubdir: 'odoo19',
    color: '#22c55e',   // green
    extraPipPackages: [...COMMON_EXTRA_PACKAGES],
  },
};

export const DEFAULT_ODOO_VERSION: OdooVersionKey = '17';

export const ALL_VERSIONS: readonly OdooVersionKey[] = ['15', '17', '19'];

export function getVersionConfig(version: string): OdooVersionConfig {
  const config = ODOO_VERSIONS[version as OdooVersionKey];
  if (!config) {
    throw new Error(`Unknown Odoo version: ${version}. Supported: ${ALL_VERSIONS.join(', ')}`);
  }
  return config;
}

export function isValidVersion(version: string): version is OdooVersionKey {
  return version in ODOO_VERSIONS;
}

/**
 * Get Python detection candidate paths for a specific version.
 */
export function getPythonCandidates(version: string): readonly string[] {
  const config = getVersionConfig(version);
  const localAppData = process.env.LOCALAPPDATA || '';
  return [
    `${localAppData}\\Programs\\Python\\${config.pythonDirName}\\python.exe`,
    `C:\\${config.pythonDirName}\\python.exe`,
    `C:\\Program Files\\${config.pythonDirName}\\python.exe`,
  ];
}

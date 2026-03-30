// ---------------------------------------------------------------------------
// Odoo Version Registry — single source of truth for version-specific config
// ---------------------------------------------------------------------------

export type OdooVersionKey = '15' | '17' | '18' | '19';

export interface OdooVersionConfig {
  readonly key: OdooVersionKey;
  readonly label: string;
  readonly settingsLabel: string;          // e.g. 'Odoo 17 (Python 3.11, PG 16)'
  readonly branch: string;
  readonly pythonVersion: string;
  readonly pythonUrl: string;
  readonly pythonVersionPrefix: string;
  readonly pythonDirName: string;            // e.g. 'Python310', 'Python311', 'Python312'
  readonly postgresVersion: string;
  readonly postgresUrl: string;
  readonly postgresDockerImage: string;
  readonly pgvector: boolean;                // Odoo 19 needs pgvector for AI modules
  readonly pgvectorUrl: string;              // pgvector Windows release zip (empty if pgvector=false)
  readonly baseDirSuffix: string;            // e.g. 'odoo_15_base'
  readonly defaultProjectsSubdir: string;    // e.g. 'odoo15'
  readonly domainSuffix: string;              // e.g. 'odoo17.local' for *.odoo17.local domains
  readonly defaultDbPort: string;             // unique PG port per version to avoid conflicts
  readonly color: string;                    // badge color
  readonly extraPipPackages: readonly string[];  // extra pip packages beyond requirements.txt
}

// Extra packages beyond requirements.txt — disabled for now pending
// cryptography/pyOpenSSL version compatibility testing.
// TODO: re-enable after validating against each Odoo version's venv.
const COMMON_EXTRA_PACKAGES: readonly string[] = [];

export const ODOO_VERSIONS: Readonly<Record<OdooVersionKey, OdooVersionConfig>> = {
  '15': {
    key: '15',
    label: 'Odoo 15',
    settingsLabel: 'Odoo 15 (Python 3.10, PG 14)',
    branch: '15.0',
    pythonVersion: 'Python 3.10',
    pythonUrl: 'https://www.python.org/ftp/python/3.10.11/python-3.10.11-amd64.exe',
    pythonVersionPrefix: '3.10',
    pythonDirName: 'Python310',
    postgresVersion: '14',
    postgresUrl: 'https://get.enterprisedb.com/postgresql/postgresql-14.15-1-windows-x64.exe',
    postgresDockerImage: 'postgres:14',
    pgvector: false,
    pgvectorUrl: '',
    baseDirSuffix: 'odoo_15_base',
    defaultProjectsSubdir: 'odoo15',
    domainSuffix: 'odoo15.local',
    defaultDbPort: '5415',
    color: '#3b82f6',   // blue
    extraPipPackages: [...COMMON_EXTRA_PACKAGES, 'PyPDF2>=3.0'],
  },
  '17': {
    key: '17',
    label: 'Odoo 17',
    settingsLabel: 'Odoo 17 (Python 3.11, PG 16)',
    branch: '17.0',
    pythonVersion: 'Python 3.11',
    pythonUrl: 'https://www.python.org/ftp/python/3.11.4/python-3.11.4-amd64.exe',
    pythonVersionPrefix: '3.11',
    pythonDirName: 'Python311',
    postgresVersion: '16',
    postgresUrl: 'https://get.enterprisedb.com/postgresql/postgresql-16.6-1-windows-x64.exe',
    postgresDockerImage: 'postgres:16',
    pgvector: false,
    pgvectorUrl: '',
    baseDirSuffix: 'odoo_17_base',
    defaultProjectsSubdir: 'odoo17',
    domainSuffix: 'odoo17.local',
    defaultDbPort: '5434',
    color: '#f0883e',   // orange (current accent)
    extraPipPackages: [...COMMON_EXTRA_PACKAGES, 'PyPDF2>=3.0'],
  },
  '18': {
    key: '18',
    label: 'Odoo 18',
    settingsLabel: 'Odoo 18 (Python 3.12, PG 16)',
    branch: '18.0',
    pythonVersion: 'Python 3.12',
    pythonUrl: 'https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe',
    pythonVersionPrefix: '3.12',
    pythonDirName: 'Python312',
    postgresVersion: '16',
    postgresUrl: 'https://get.enterprisedb.com/postgresql/postgresql-16.6-1-windows-x64.exe',
    postgresDockerImage: 'postgres:16',
    pgvector: false,
    pgvectorUrl: '',
    baseDirSuffix: 'odoo_18_base',
    defaultProjectsSubdir: 'odoo18',
    domainSuffix: 'odoo18.local',
    defaultDbPort: '5418',
    color: '#a855f7',   // purple
    extraPipPackages: [...COMMON_EXTRA_PACKAGES],
  },
  '19': {
    key: '19',
    label: 'Odoo 19',
    settingsLabel: 'Odoo 19 (Python 3.12, PG 16 + pgvector)',
    branch: 'master',   // Update to '19.0' when branch is created
    pythonVersion: 'Python 3.12',
    pythonUrl: 'https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe',
    pythonVersionPrefix: '3.12',
    pythonDirName: 'Python312',
    postgresVersion: '16',
    postgresUrl: 'https://get.enterprisedb.com/postgresql/postgresql-16.6-1-windows-x64.exe',
    postgresDockerImage: 'pgvector/pgvector:pg16',  // pgvector image for AI modules
    pgvector: true,
    pgvectorUrl: 'https://github.com/portalcorp/pgvector_compiled/releases/download/v0.16.105/pgvector-x86_64-pc-windows-msvc-pg16.zip',
    baseDirSuffix: 'odoo_19_base',
    defaultProjectsSubdir: 'odoo19',
    domainSuffix: 'odoo19.local',
    defaultDbPort: '5419',
    color: '#22c55e',   // green
    extraPipPackages: [...COMMON_EXTRA_PACKAGES],
  },
};

export const DEFAULT_ODOO_VERSION: OdooVersionKey = '17';

export const ALL_VERSIONS: readonly OdooVersionKey[] = ['15', '17', '18', '19'];

/**
 * PostgreSQL versions to scan when detecting native installs.
 * Derived from registry — unique PG versions (sorted desc), plus common older ones.
 */
export const PG_SCAN_VERSIONS: readonly string[] = (() => {
  const fromRegistry = new Set(ALL_VERSIONS.map(v => ODOO_VERSIONS[v].postgresVersion));
  // Also scan older PG versions that users might have installed manually
  for (const older of ['15', '14', '13']) fromRegistry.add(older);
  return [...fromRegistry].sort((a, b) => Number(b) - Number(a));
})();

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
 * Merge registry defaults with user URL overrides.
 * Only pythonUrl and postgresUrl are overridable.
 */
export function getEffectiveVersionConfig(
  version: string,
  urlOverrides?: Record<string, { pythonUrl?: string; postgresUrl?: string }>
): OdooVersionConfig {
  const config = getVersionConfig(version);
  const overrides = urlOverrides?.[version];
  if (!overrides) return config;
  return {
    ...config,
    ...(overrides.pythonUrl ? { pythonUrl: overrides.pythonUrl } : {}),
    ...(overrides.postgresUrl ? { postgresUrl: overrides.postgresUrl } : {}),
  };
}

/**
 * Get Python detection candidate paths for a specific version.
 */
export function getPythonCandidates(version: string): readonly string[] {
  const config = getVersionConfig(version);
  const localAppData = process.env.LOCALAPPDATA || '';
  return [
    // Per-user install (InstallAllUsers=0)
    `${localAppData}\\Programs\\Python\\${config.pythonDirName}\\python.exe`,
    // System-wide install (InstallAllUsers=1)
    `C:\\Program Files\\Python${config.pythonVersionPrefix.replace('.', '')}\\python.exe`,
    `C:\\Program Files\\${config.pythonDirName}\\python.exe`,
    `C:\\${config.pythonDirName}\\python.exe`,
    // Common alternative paths
    `C:\\Python${config.pythonVersionPrefix.replace('.', '')}\\python.exe`,
  ];
}

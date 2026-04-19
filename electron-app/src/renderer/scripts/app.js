// ---------------------------------------------------------------------------
// Odoo Installer - Renderer Script (Multi-version — dynamic from registry)
// Communicates with main process via IPC (window.electronAPI)
// ---------------------------------------------------------------------------

const $ = id => document.getElementById(id);
let _status = null;
let _odooVersions = null; // { versions: [...], default: '17' } — loaded from IPC

// Translate backend error codes to localized messages
const _backendMsgMap = {
  'DELETE_LOCKED': 'toast.deleteLocked',
  'INVALID_NAME': 'toast.invalidName',
  'NAME_REQUIRED': 'toast.enterName',
  'PROJECT_EXISTS': 'toast.projectExists',
  'SYMLINK_FAILED': 'toast.symlinkFailed',
  'PROJECT_NOT_FOUND': 'toast.projectNotFound',
  'CONFIG_NOT_FOUND': 'toast.configNotFound',
  'PGVECTOR_COPY_FAILED': 'toast.pgvectorCopyFailed',
};
function tMsg(msg) {
  const key = _backendMsgMap[msg];
  return key ? t(key) : msg;
}

// Language dropdown
const _langLabels = { en: 'EN', vi: 'VI', ko: 'KO' };
function updateLangLabel() {
  const label = $('langLabel');
  if (label) label.textContent = _langLabels[getCurrentLanguage()] || 'EN';
}
function toggleLangDropdown() {
  const menu = $('langMenu');
  menu.classList.toggle('visible');
  // Highlight current language
  const lang = getCurrentLanguage();
  menu.querySelectorAll('.lang-option').forEach(el => {
    el.classList.toggle('active', el.getAttribute('onclick')?.includes("'" + lang + "'"));
  });
}
function closeLangDropdown() {
  $('langMenu')?.classList.remove('visible');
}
// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('#langDropdown')) closeLangDropdown();
});

// When user picks a candidate from the detected Odoo source dropdown, fill the input
document.addEventListener('change', (e) => {
  if (e.target.id === 'odooSourceCandidates') {
    const input = $('odooSourceDir');
    if (input) {
      input.value = e.target.value;
      saveSettingsToDisk();
      refreshStatus();
    }
  }
});

// Initialize i18n — use localStorage immediately (no IPC wait), sync settings async
(async () => {
  // Phase 1: instant — render with localStorage language (no async wait)
  await initI18n(getCurrentLanguage());
  applyTranslations();
  updateLangLabel();
  const sel = $('langSelect');
  if (sel) sel.value = getCurrentLanguage();

  // Phase 2: async — sync with settings file (non-blocking, won't cause jank)
  try {
    if (window.electronAPI) {
      const res = await window.electronAPI.invoke('load-settings', {});
      const savedLang = res?.settings?.language;
      const localLang = getCurrentLanguage();
      if (savedLang && savedLang !== localLang) {
        // Settings file has a different language — re-apply
        try { localStorage.setItem('lang', savedLang); } catch {}
        await initI18n(savedLang);
        applyTranslations();
        updateLangLabel();
        if (sel) sel.value = savedLang;
      } else if (!savedLang && localLang) {
        // Settings file missing language — persist current
        const settings = res?.settings || {};
        settings.language = localLang;
        window.electronAPI.invoke('save-settings', settings); // fire-and-forget
      }
    }
  } catch {}
})();

// Version-specific labels — built dynamically from registry via _odooVersions
function getVersionLabels(version) {
  if (!_odooVersions) return { python: 'Python', postgres: 'PostgreSQL', clone: 'Clone Odoo' };
  const v = _odooVersions.versions.find(x => x.key === version);
  if (!v) return { python: 'Python', postgres: 'PostgreSQL', clone: 'Clone Odoo' };
  const pgLabel = v.pgvector ? `PostgreSQL ${v.postgresVersion} + pgvector` : `PostgreSQL ${v.postgresVersion}`;
  return { python: v.pythonVersion, postgres: pgLabel, clone: `Clone ${v.label}` };
}

/** Build PostgreSQL detail string for status grid, including pgvector warning */
function _pgStatusDetail(s) {
  const ver = $('globalVersion')?.value || (_odooVersions ? _odooVersions.default : '17');
  const vInfo = _odooVersions && _odooVersions.versions.find(x => x.key === ver);
  let detail = s.postgres_path || '';
  if (vInfo && vInfo.pgvector && s.postgres && !s.pgvector_available) {
    detail += detail ? ' | ' : '';
    detail += t('install.pgvectorMissing');
  }
  return detail;
}

let _allUsedPorts = new Set();
let _allProjectNames = new Set();

/** Fetch all used ports across ALL Odoo versions */
async function refreshAllUsedPorts() {
  try {
    const ports = await api('all-used-ports');
    _allUsedPorts = new Set(Array.isArray(ports) ? ports : []);
  } catch { /* ignore */ }
}

/** Fetch all project names across ALL Odoo versions */
async function refreshAllProjectNames() {
  try {
    const names = await api('all-project-names');
    _allProjectNames = new Set(Array.isArray(names) ? names : []);
  } catch { /* ignore */ }
}

/**
 * Get the projects_dir for a specific project by looking up its path in _status.
 * Falls back to Settings projects_dir if not found.
 */
function _getProjectsDir(projectName) {
  if (_status && _status.projects) {
    const p = _status.projects.find(x => x.name === projectName);
    if (p && p.path) {
      // p.path is the project folder, parent is the projects_dir
      const sep = p.path.includes('/') ? '/' : '\\';
      return p.path.substring(0, p.path.lastIndexOf(sep));
    }
  }
  return $('projectsDir')?.value || '';
}

function getNextAvailablePort() {
  // Merge ports from current status + global cross-version cache
  const usedSet = new Set(_allUsedPorts);
  if (_status && _status.projects) {
    _status.projects.forEach(p => {
      const hp = parseInt(p.http_port) || 0;
      const lp = parseInt(p.longpolling_port) || 0;
      if (hp > 0) usedSet.add(hp);
      if (lp > 0) usedSet.add(lp);
    });
  }
  if (usedSet.size === 0) return 8069;
  let port = Math.min(...usedSet);
  while (usedSet.has(port) || usedSet.has(port + 3)) { port++; }
  return port;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function showPanel(name, el) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(m => m.classList.remove('active'));
  $('panel-' + name).classList.add('active');
  if (el) el.classList.add('active');
  if (name === 'dashboard' || name === 'settings' || name === 'projects') refreshStatus();
  if (name === 'settings' && typeof syncSettingsPanel === 'function') syncSettingsPanel();
  if (name === 'help') {
    renderHelpPanel();
    api('track-action', { action: 'HELP_VIEWED' }).catch(() => {});
  }
  if (name === 'log') pollLog();
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape string for use inside onclick="func('...')" - escape backslashes and quotes */
function escAttr(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function toggleAdvanced(id) {
  const el = $(id);
  el.classList.toggle('show');
  const arrow = $('arrow' + id.charAt(0).toUpperCase() + id.slice(1));
  if (arrow) arrow.classList.toggle('open');
}

function showModal(id) { $(id).classList.add('visible'); }
function hideModal(id) {
  $(id).classList.remove('visible');
  // Stop log watcher when detail modal closes
  if (id === 'modalDetail') stopLogWatch();
}

// ---------------------------------------------------------------------------
// API layer - uses IPC instead of HTTP fetch
// ---------------------------------------------------------------------------
async function api(endpoint, data = {}) {
  if (window.electronAPI) {
    return window.electronAPI.invoke(endpoint, data);
  }
  // Fallback to HTTP for development/testing without Electron
  const res = await fetch('/api/' + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// Form data collection
// ---------------------------------------------------------------------------
function getFormData() {
  return {
    odoo_version: $('globalVersion')?.value || $('odooVersion')?.value || '17',
    base_dir: $('baseDir').value,
    projects_dir: $('projectsDir').value,
    odoo_source_dir: $('odooSourceDir')?.value || 'odoo',
    project_name: $('projectName').value,
    http_port: $('httpPort').value,
    db_host: $('dbHost').value,
    db_port: $('dbPort').value,
    db_user: $('dbUser').value,
    db_password: $('dbPassword').value,
    pg_super_password: $('pgSuperPassword').value,
    pg_mode: $('pgMode').value,
    addons_path: $('addonsPath').value,
    admin_passwd: $('adminPasswd').value,
    longpolling_port: $('longpollingPort').value,
    log_level: $('logLevel').value,
    workers: $('workers').value,
    list_db: $('listDb').value,
    dbfilter: $('dbfilter').value,
    proxy_mode: $('proxyMode').value,
    server_wide_modules: $('serverWideModules').value,
    data_dir: $('dataDir').value,
    limit_memory_hard: $('memHard').value,
    limit_memory_soft: $('memSoft').value,
  };
}

// ---------------------------------------------------------------------------
// Settings Persistence — save form fields to disk so they survive app restart
// ---------------------------------------------------------------------------
const SETTINGS_FIELD_IDS = [
  'odooVersion', 'baseDir', 'projectsDir', 'odooSourceDir', 'projectName',
  'httpPort', 'dbHost', 'dbPort', 'dbUser', 'dbPassword', 'pgSuperPassword', 'pgMode',
  'addonsPath', 'adminPasswd', 'longpollingPort', 'logLevel', 'workers',
  'listDb', 'dbfilter', 'proxyMode', 'serverWideModules', 'dataDir', 'memHard', 'memSoft',
  'preferredIDE',
];

/** Preferred IDE: 'vscode' (default) or 'antigravity'. Read from the form select. */
function getPreferredIDE() {
  const el = typeof document !== 'undefined' && document.getElementById('preferredIDE');
  const v = el && el.value;
  return v === 'antigravity' ? 'antigravity' : 'vscode';
}

function saveSettingsToDisk() {
  if (!window.electronAPI) return;
  // Read existing settings first to preserve versionUrlOverrides
  loadSettingsRaw().then(existing => {
    const settings = { ...existing };
    for (const id of SETTINGS_FIELD_IDS) {
      const el = $(id);
      if (el) settings[id] = el.value;
    }
    return api('save-settings', settings);
  }).then(() => {
    showSettingsSaveStatus();
  }).catch(() => {});
}

function showSettingsSaveStatus() {
  showToastMessage(t('settings.updated'), 'success');
}

async function loadSettingsFromDisk() {
  if (!window.electronAPI) return;
  try {
    const res = await api('load-settings');
    if (!res?.settings) return;
    const s = res.settings;
    for (const id of SETTINGS_FIELD_IDS) {
      if (s[id] !== undefined && s[id] !== '' && $(id)) {
        $(id).value = s[id];
      }
    }
    // Sync global version selector with saved settings
    if (s.odooVersion && $('globalVersion')) {
      $('globalVersion').value = s.odooVersion;
      _syncInstallVersionLabel(s.odooVersion);
      // Also update step name labels to match the restored version
      const labels = getVersionLabels(s.odooVersion);
      if ($('stepName-install_python')) $('stepName-install_python').textContent = labels.python;
      if ($('stepName-install_postgres')) $('stepName-install_postgres').textContent = labels.postgres;
      if ($('stepName-clone_odoo')) $('stepName-clone_odoo').textContent = labels.clone;
    }
  } catch { /* first launch — no saved settings */ }
}

// Auto-save when any settings field changes
(function() {
  let debounce = null;
  function onSettingChange() {
    clearTimeout(debounce);
    debounce = setTimeout(saveSettingsToDisk, 500);
  }
  // Attach after DOM is ready (script is at end of body, so DOM is ready)
  for (const id of SETTINGS_FIELD_IDS) {
    const el = $(id);
    if (!el) continue;
    // input: fires on typing (text/number inputs)
    // change: fires on select dropdown change or blur
    // Only listen to one per element type to avoid double-save
    if (el.tagName === 'SELECT') {
      el.addEventListener('change', onSettingChange);
    } else {
      el.addEventListener('input', onSettingChange);
    }
  }
  // Preferred IDE change → re-render dashboard so card buttons pick up new icon
  const ideEl = $('preferredIDE');
  if (ideEl) {
    ideEl.addEventListener('change', () => {
      if (_status && typeof renderDashboard === 'function') renderDashboard(_status);
    });
  }
})();

// ---------------------------------------------------------------------------
// Version change handlers
// ---------------------------------------------------------------------------
/** Get the best DB port for a version: use native PG's actual port if available, else default */
function _detectDbPort(version) {
  const vCfg = _odooVersions?.versions?.find(v => v.key === version);
  const defaultPort = vCfg?.defaultDbPort || '5432';
  // If native PG is running, use its actual port (all versions share the same PG install)
  if (_status?.native_postgres?.is_ready && _status.native_postgres.port) {
    return _status.native_postgres.port;
  }
  return defaultPort;
}

async function onVersionChange(version) {
  // Update directories + db port to match selected version
  try {
    const paths = await api('default-paths', { odoo_version: version });
    if ($('baseDir')) $('baseDir').value = paths.base_dir || '';
    if ($('projectsDir')) $('projectsDir').value = paths.projects_dir || '';
    // Sync DB port: prefer native PG's actual port, fallback to version default
    if ($('dbPort')) $('dbPort').value = _detectDbPort(version);
    saveSettingsToDisk();
  } catch { /* ignore */ }
  // Sync global + install selectors + labels
  if ($('globalVersion') && $('globalVersion').value !== version) $('globalVersion').value = version;
  if ($('installVersion') && $('installVersion').value !== version) $('installVersion').value = version;
  const labels = getVersionLabels(version);
  if ($('stepName-install_python')) $('stepName-install_python').textContent = labels.python;
  if ($('stepName-install_postgres')) $('stepName-install_postgres').textContent = labels.postgres;
  if ($('stepName-clone_odoo')) $('stepName-clone_odoo').textContent = labels.clone;
  _syncInstallVersionLabel(version);
  renderVersionUrlFields();
}

function getVersionColor(version) {
  if (!_odooVersions) return '#888';
  const v = _odooVersions.versions.find(x => x.key === version);
  return v ? v.color : '#888';
}

/** Global version changed from topnav — sync everything */
function onGlobalVersionChange(version) {
  if (version) {
    // Specific version: sync all selectors + update paths
    if ($('odooVersion')) $('odooVersion').value = version;
    if ($('installVersion')) $('installVersion').value = version;
    const labels = getVersionLabels(version);
    if ($('stepName-install_python')) $('stepName-install_python').textContent = labels.python;
    if ($('stepName-install_postgres')) $('stepName-install_postgres').textContent = labels.postgres;
    if ($('stepName-clone_odoo')) $('stepName-clone_odoo').textContent = labels.clone;
    _syncInstallVersionLabel(version);
    onVersionChange(version).then(() => refreshStatus());
  } else {
    // "All versions" selected — just refresh with all-version status
    refreshStatus();
  }
  filterDashboard();
}

function _syncInstallVersionLabel(version) {
  const el = $('installVersionLabel');
  if (!el || !_odooVersions) return;
  const v = _odooVersions.versions.find(x => x.key === version);
  el.textContent = v ? v.label : `Odoo ${version}`;
}

function onInstallVersionChange(version) {
  // Hidden select changed (backward compat) — sync global
  if ($('globalVersion') && $('globalVersion').value !== version) {
    $('globalVersion').value = version;
    onGlobalVersionChange(version);
  }
}

// ---------------------------------------------------------------------------
// Dynamic Odoo Versions — populate selects + URL fields from registry
// ---------------------------------------------------------------------------

/**
 * Load version registry from main process and populate all version selects.
 * Called once during init, before loadSettingsFromDisk restores saved values.
 */
async function loadOdooVersions() {
  if (!window.electronAPI) return;
  try {
    _odooVersions = await api('odoo-versions');
  } catch { return; }
  if (!_odooVersions || !_odooVersions.versions) return;
  const defaultVer = _odooVersions.default || '17';

  // Populate all version selects (global, settings, install hidden, new project)
  const selects = [
    { id: 'globalVersion', useSettingsLabel: false },
    { id: 'odooVersion', useSettingsLabel: true },
    { id: 'installVersion', useSettingsLabel: false },
    { id: 'newProjVersion', useSettingsLabel: false },
  ];
  for (const { id, useSettingsLabel } of selects) {
    const el = $(id);
    if (!el) continue;
    const savedVal = el.value; // preserve if already restored from settings
    el.innerHTML = '';
    // Add "All" option to globalVersion only
    if (id === 'globalVersion') {
      const allOpt = document.createElement('option');
      allOpt.value = '';
      allOpt.textContent = t('version.all');
      el.appendChild(allOpt);
    }
    for (const v of _odooVersions.versions) {
      const opt = document.createElement('option');
      opt.value = v.key;
      opt.textContent = useSettingsLabel ? v.settingsLabel : v.label;
      if (v.key === defaultVer && id !== 'globalVersion') opt.selected = true;
      el.appendChild(opt);
    }
    // Restore saved selection if valid (including "" for "All")
    if (savedVal !== undefined && (savedVal === '' || _odooVersions.versions.some(v => v.key === savedVal))) {
      el.value = savedVal;
    }
  }

  // Render URL fields in settings
  renderVersionUrlFields();

  // Sync install label + step labels for current version
  const curVer = $('globalVersion')?.value || defaultVer;
  _syncInstallVersionLabel(curVer);
  const labels = getVersionLabels(curVer);
  if ($('stepName-install_python')) $('stepName-install_python').textContent = labels.python;
  if ($('stepName-install_postgres')) $('stepName-install_postgres').textContent = labels.postgres;
  if ($('stepName-clone_odoo')) $('stepName-clone_odoo').textContent = labels.clone;
}

/**
 * Render editable Python/PostgreSQL download URL fields under version selector.
 * Locked (readonly) when a project already uses that version.
 */
function renderVersionUrlFields() {
  const container = $('versionUrlFields');
  if (!container || !_odooVersions) return;

  // Determine which versions have existing projects
  const usedVersions = new Set();
  if (_status && _status.projects) {
    for (const p of _status.projects) {
      usedVersions.add(p.odoo_version || '17');
    }
  }

  container.innerHTML = _odooVersions.versions.map(v => {
    const locked = usedVersions.has(v.key);
    const lockIcon = locked ? ' 🔒' : '';
    const lockTitle = locked ? ` title="${t('settings.urlLocked')}"` : '';
    const readonlyAttr = locked ? ' readonly' : '';
    const lockedClass = locked ? ' version-url-locked' : '';
    return `
      <div class="form-group" style="grid-column:1/-1">
        <label${lockTitle}>${v.label} — Python URL${lockIcon}</label>
        <input class="version-url-input${lockedClass}" id="urlPython_${v.key}" value="${escAttr(v.pythonUrl)}"${readonlyAttr}
          data-version="${v.key}" data-field="pythonUrl" data-default="${escAttr(v.defaultPythonUrl)}"
          onchange="onVersionUrlChange(this)" placeholder="${v.defaultPythonUrl}">
      </div>
      <div class="form-group" style="grid-column:1/-1">
        <label${lockTitle}>${v.label} — PostgreSQL URL${lockIcon}</label>
        <input class="version-url-input${lockedClass}" id="urlPostgres_${v.key}" value="${escAttr(v.postgresUrl)}"${readonlyAttr}
          data-version="${v.key}" data-field="postgresUrl" data-default="${escAttr(v.defaultPostgresUrl)}"
          onchange="onVersionUrlChange(this)" placeholder="${v.defaultPostgresUrl}">
      </div>`;
  }).join('');
}

/**
 * Called when user changes a version URL field. Saves override to settings.
 */
function onVersionUrlChange(input) {
  const version = input.dataset.version;
  const field = input.dataset.field;
  const defaultUrl = input.dataset.default;
  const value = input.value.trim();

  // Read current settings
  loadSettingsRaw().then(settings => {
    const overrides = settings.versionUrlOverrides || {};
    if (!overrides[version]) overrides[version] = {};

    if (value && value !== defaultUrl) {
      overrides[version][field] = value;
    } else {
      delete overrides[version][field];
      // Clean up empty version entries
      if (Object.keys(overrides[version]).length === 0) delete overrides[version];
    }

    settings.versionUrlOverrides = overrides;
    api('save-settings', settings).then(() => showSettingsSaveStatus()).catch(() => {});
  });
}

/**
 * Read raw settings from disk (without applying to form fields).
 */
async function loadSettingsRaw() {
  try {
    const res = await api('load-settings');
    return res?.settings || {};
  } catch { return {}; }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
let _refreshInFlight = false;
let _lastVersionUrlRender = '';

/**
 * refreshStatus(opts)
 * @param {object} [opts]
 * @param {boolean} [opts.lightweight] - If true, only fetch status & update _status
 *   without full DOM rebuild. Used during start/stop polling to avoid jank.
 */
async function refreshStatus(opts) {
  if (_refreshInFlight) return;
  _refreshInFlight = true;
  try {
  const globalVer = $('globalVersion')?.value || '';
  const statusCall = globalVer ? api('status', getFormData()) : api('status-all');
  const [s] = await Promise.all([statusCall, refreshAllUsedPorts(), refreshAllProjectNames()]);
  _status = s;

  // Lightweight mode: skip full DOM rebuild — only update _status for caller to check
  if (opts && opts.lightweight) return;

  // Build all HTML strings FIRST (no DOM access — pure computation)
  const items = [
    ['Git', s.git, s.git_version || ''],
    [s.python_version || 'Python', s.python311, s.python311_path],
    ['PostgreSQL', s.postgres, _pgStatusDetail(s)],
    ['VS Code', s.vscode, s.vscode_version || ''],
    ['Nginx', s.nginx, s.nginx ? 'HTTPS proxy' : ''],
    ['Odoo Source', s.odoo_cloned, s.odoo_cloned ? s.odoo_source_dir : ''],
    ['Virtual Env', s.venv_created, ''],
    ['Requirements', s.requirements_installed, ''],
  ];
  if (s.docker) items.push(['Docker', true, 'Available']);

  let statusHtml = items.map(([label, ok, detail]) => `
    <div class="status-card">
      <div class="status-icon ${ok ? 'ok' : 'missing'}">${ok ? '\u2713' : '\u2717'}</div>
      <div class="status-info"><div class="label">${label}</div>
      ${detail ? `<div class="detail">${escHtml(detail)}</div>` : ''}</div>
    </div>`).join('');

  if (s.docker_postgres && s.docker_postgres.length > 0) {
    statusHtml += s.docker_postgres.map(c => `
      <div class="status-card" style="border-color:#1a3a1a">
        <div class="status-icon ok">PG</div>
        <div class="status-info"><div class="label">${escHtml(c.name)}</div>
        <div class="detail">${escHtml(c.image)} | port:${escHtml(c.port)} | ${escHtml(c.status)}</div></div>
      </div>`).join('');
  }

  const np = s.native_postgres;
  const npHtml = np ? `<div class="pg-detail">
      <h4>Native PostgreSQL</h4>
      <div class="project-detail-grid">
        <div class="detail-item"><div class="detail-label">Status</div><div class="detail-value">${np.is_ready ? '<span style="color:#22c55e">Running</span>' : '<span style="color:#ef4444">Stopped</span>'}</div></div>
        <div class="detail-item"><div class="detail-label">Port</div><div class="detail-value">${escHtml(np.port || 'N/A')}</div></div>
        <div class="detail-item"><div class="detail-label">Data Dir</div><div class="detail-value">${escHtml(np.data_dir || 'N/A')}</div></div>
        <div class="detail-item"><div class="detail-label">Bin Path</div><div class="detail-value">${escHtml(np.bin_path || 'N/A')}</div></div>
      </div>
      ${np.databases && np.databases.length ? `<div><span class="detail-label">Databases:</span><div class="pg-databases">${np.databases.map(d => `<span class="db-tag">${escHtml(d)}</span>`).join('')}</div></div>` : ''}
    </div>` : '';

  // Apply all DOM updates in a single rAF — one reflow instead of many
  requestAnimationFrame(() => {
    $('statusGrid').innerHTML = statusHtml;
    $('nativePgDetail').innerHTML = npHtml;

    const pgModeGroup = $('pgModeGroup');
    if (pgModeGroup) {
      pgModeGroup.style.display = (s.docker_postgres && s.docker_postgres.length > 0) ? '' : 'none';
    }

    // Update Odoo source candidates dropdown
    const candidatesSel = $('odooSourceCandidates');
    const sourceInput = $('odooSourceDir');
    if (candidatesSel && s.odoo_source_candidates && s.odoo_source_candidates.length > 0) {
      candidatesSel.style.display = '';
      candidatesSel.innerHTML = s.odoo_source_candidates.map(c =>
        `<option value="${escAttr(c)}"${c === s.odoo_source_dir ? ' selected' : ''}>${escHtml(c)}</option>`
      ).join('');
      // Auto-fill if user hasn't manually set a custom value or if current value doesn't exist
      if (sourceInput && (!sourceInput.value || sourceInput.value === 'odoo') && s.odoo_source_dir !== 'odoo') {
        sourceInput.value = s.odoo_source_dir;
        saveSettingsToDisk();
      }
    } else if (candidatesSel) {
      candidatesSel.style.display = 'none';
    }

    renderProjects(s);
    renderDashboard(s);
    refreshInstallStatus();

    // Only re-render version URL fields when project list changes (avoids losing unsaved input)
    const versionUrlKey = (s.projects || []).map(p => p.odoo_version).sort().join(',');
    if (versionUrlKey !== _lastVersionUrlRender) {
      _lastVersionUrlRender = versionUrlKey;
      renderVersionUrlFields();
    }

    const nextPort = getNextAvailablePort();
    if ($('newProjPort')) $('newProjPort').value = nextPort;
  });
  } finally { _refreshInFlight = false; }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
function renderProjects(s) {
  const list = $('projectsList');
  if (!s.projects || s.projects.length === 0) {
    list.innerHTML = `<div class="empty"><p>${t('dashboard.noProjects')}</p></div>`;
    return;
  }
  list.innerHTML = s.projects.map(p => {
    const details = [
      ['HTTP Port', p.http_port], ['Longpolling', p.longpolling_port],
      ['DB', `${p.db_host || 'localhost'}:${p.db_port}`],
      ['DB User', p.db_user], ['Workers', p.workers], ['Log Level', p.log_level],
      ['Custom Modules', p.custom_modules], ['List DB', p.list_db],
    ].filter(([, v]) => v !== '' && v !== undefined && v !== null);
    return `<div class="project-card">
      <div class="project-header">
        <div><span class="name">${escHtml(p.name)}</span>
          <span class="tag tag-port" onclick="openProjectUrl('${escAttr(p.domain)}','${escAttr(p.http_port)}')" style="cursor:pointer" title="Open in browser">:${escHtml(p.http_port)}</span>
          ${_pendingProjects.has(p.name)
            ? `<span class="tag tag-pending"><span class="spinner-sm"></span></span>`
            : p.is_running
              ? `<span class="tag tag-running">${t('project.runningTag')}</span>`
              : `<span class="tag tag-stopped">${t('project.stoppedTag')}</span>`}
          <span class="project-url" onclick="openProjectUrl('${escAttr(p.domain)}','${escAttr(p.http_port)}')" title="Click to open">${escHtml(getProjectUrl(p.domain, p.http_port))}</span></div>
        <div style="font-size:0.75rem;color:var(--text-tertiary)">${escHtml(p.path)}</div>
      </div>
      <div class="project-detail-grid">
        ${details.map(([l, v]) => `<div class="detail-item"><div class="detail-label">${l}</div><div class="detail-value">${escHtml(v)}</div></div>`).join('')}
        ${p.addon_dirs && p.addon_dirs.length ? p.addon_dirs.map(a => `<div class="detail-item"><div class="detail-label">${a.is_base ? 'Base Addons' : 'Custom Addons'}</div><div class="detail-value">${escHtml(a.path)} (${a.count} modules)</div></div>`).join('') : ''}
        ${p.data_dir ? `<div class="detail-item"><div class="detail-label">Data Dir</div><div class="detail-value">${escHtml(p.data_dir)}</div></div>` : ''}
      </div>
      <div class="cmd-box" onclick="copyCmd(this)" title="Click to copy">
        <span>${escHtml(p.start_command)}</span>
        <span class="copy-hint">${t('project.clickCopy')}</span>
      </div>
      <div class="project-actions">
        ${renderActionBtn(p)}
        <button class="btn btn-vscode btn-xs" onclick="openVSCode('${escAttr(p.path)}',event)">${getPreferredIDE() === 'antigravity' ? t('project.antigravity') : t('project.vsCode')}</button>
        <button class="btn btn-outline btn-xs" onclick="openExplorer('${escAttr(p.path)}',event)">${t('project.explorer')}</button>
        <button class="btn btn-outline btn-xs" onclick="editConfig('${escAttr(p.name)}')">${t('project.editConfig')}</button>
        <button class="btn btn-outline btn-xs" onclick="duplicateProject('${escAttr(p.name)}','${escAttr(p.http_port)}')">${t('project.duplicate')}</button>
        <button class="btn btn-danger btn-xs" onclick="deleteProject('${escAttr(p.name)}')">${t('project.delete')}</button>
      </div>
    </div>`;
  }).join('');
}

function copyCmd(el) {
  const text = el.querySelector('span').textContent;
  navigator.clipboard.writeText(text).then(() => {
    const hint = el.querySelector('.copy-hint');
    hint.textContent = t('project.copied');
    setTimeout(() => hint.textContent = t('project.clickCopy'), 1500);
  });
}

// ---------------------------------------------------------------------------
// Log & Progress
// ---------------------------------------------------------------------------
let logPoll = null;

async function pollLog() {
  const res = await api('log');
  const el = $('log');
  el.innerHTML = res.lines.map(l => `<div class="line">${escHtml(l)}</div>`).join('');
  el.scrollTop = el.scrollHeight;
  if (res.task.status === 'running') {
    $('progressFill').style.width = res.task.progress + '%';
    $('progressStep').textContent = res.task.step;
    $('progressPct').textContent = res.task.progress + '%';
  }
}

function startLogPoll() {
  $('progressWrap').classList.add('visible');
  if (!logPoll) logPoll = setInterval(pollLog, 1000);
}

function stopLogPoll() {
  if (logPoll) { clearInterval(logPoll); logPoll = null; }
  pollLog();
}

// Listen for real-time log push from main process (replaces polling)
if (window.electronAPI) {
  window.electronAPI.onLogMessage((line) => {
    // Log tab — cap at 500 DOM nodes to prevent memory bloat
    const el = $('log');
    if (el) {
      el.insertAdjacentHTML('beforeend', `<div class="line">${escHtml(line)}</div>`);
      while (el.childElementCount > 500) el.removeChild(el.firstChild);
      el.scrollTop = el.scrollHeight;
    }
    // Install inline log
    appendInstallLog(line);
  });

  window.electronAPI.onTaskProgress((task) => {
    // Map step labels to step IDs — use pattern matching for version-dynamic labels
    function matchStepId(label) {
      if (!label) return null;
      if (label.includes('Nginx')) return 'install_nginx';
      if (label.includes('Git') && !label.includes('venv')) return 'install_git';
      if (label.includes('VS Code')) return 'install_vscode';
      if (label.includes('Python')) return 'install_python';
      if (label.includes('PostgreSQL') || label.includes('DB user')) return 'install_postgres';
      if (label.includes('Cloning')) return 'clone_odoo';
      if (label.includes('virtual environment') || label.includes('venv')) return 'create_venv';
      if (label.includes('requirements') || label.includes('pip')) return 'install_requirements';
      if (label.includes('wkhtmltopdf')) return 'install_wkhtmltopdf';
      return null;
    }

    if (task.status === 'running') {
      const currentStep = matchStepId(task.step);
      if (currentStep) {
        const st = _stepStates.get(currentStep);
        // Don't overwrite user-initiated or already-done steps
        if (!st || (st.source !== 'user' && st.state !== 'done')) {
          _stepStates.set(currentStep, { state: 'running', source: 'full' });
          updateStepCard(currentStep, 'running', task.step);
        }
      }
    } else if (task.status === 'done') {
      if (task.results) {
        for (const r of task.results) {
          const stepId = matchStepId(r.step);
          if (!stepId) continue;
          const st = _stepStates.get(stepId);
          if (st && st.source === 'user') continue; // Don't overwrite user step
          _stepStates.set(stepId, { state: r.ok ? 'done' : 'error', source: 'full' });
          updateStepCard(stepId, r.ok ? 'done' : 'error', r.msg);
        }
      }
      const btn = $('btnFullInstall');
      if (btn) { btn.disabled = false; btn.textContent = t('install.installAll'); }
      _fullInstallRunning = false;
      // Downgrade full sources so refreshStatus can update
      for (const [sid, st] of _stepStates) {
        if (st.source === 'full') _stepStates.set(sid, { ...st, source: 'status' });
      }
      showToastMessage(t('install.complete'), 'success');
      refreshStatus();
    }
  });

  // Download progress → only update if step is actually running
  window.electronAPI.onDownloadProgress((data) => {
    const st = _stepStates.get(data.step);
    if (!st || st.state !== 'running') return;
    const card = $('step-' + data.step);
    if (!card) return;
    const prog = $('stepProgress-' + data.step);
    if (prog) {
      prog.textContent = `${data.percent}% · ${data.downloadedMB}/${data.totalMB} MB`;
    }
    card.style.setProperty('--dl-progress', data.percent + '%');
  });
}

// ---------------------------------------------------------------------------
// Installation step cards UI moved to install.js

// Project Name Validation
// ---------------------------------------------------------------------------
/** Validate project name: lowercase, start with letter/underscore, no uppercase, no leading digit */
function isValidProjectName(name) {
  return /^[a-z_][a-z0-9_\-]*$/.test(name);
}

/** Show inline validation hint on project name inputs */
function validateProjectNameInput(input) {
  const val = input.value;
  const hint = input.nextElementSibling;
  if (!hint || !hint.classList.contains('input-hint')) return;
  if (!val) { hint.textContent = ''; hint.style.display = 'none'; return; }
  if (!isValidProjectName(val)) {
    hint.textContent = t('toast.invalidName');
    hint.style.display = 'block';
  } else if (_allProjectNames.has(val)) {
    hint.textContent = t('toast.projectNameTaken');
    hint.style.display = 'block';
  } else {
    hint.textContent = '';
    hint.style.display = 'none';
  }
}

// ---------------------------------------------------------------------------
// Progress step definitions for create/delete
// ---------------------------------------------------------------------------
const CREATE_STEPS = [
  { id: 'create_folder', key: 'modal.dupStepFolder' },
  { id: 'junction_link', key: 'modal.dupStepJunction' },
  { id: 'write_config', key: 'modal.dupStepConfig' },
  { id: 'setup_domain', key: 'modal.dupStepDomain' },
];
const DELETE_STEPS = [
  { id: 'drop_databases', key: 'modal.delStepDropDb' },
  { id: 'stop_odoo', key: 'modal.delStepStopOdoo' },
  { id: 'close_vscode', key: 'modal.delStepCloseVscode' },
  { id: 'delete_files', key: 'modal.delStepDeleteFiles' },
];

function _renderProgressSteps(containerId, steps, modalId) {
  const el = $(containerId);
  if (!el) return;
  el.innerHTML = steps.map(s =>
    `<div class="dup-step" id="prog-${s.id}">
      <span class="dup-step-icon">&#9711;</span>
      <span class="dup-step-label">${t(s.key)}</span>
    </div>`
  ).join('') + `<div class="progress-close" id="prog-close-${containerId}" style="display:none;margin-top:12px;text-align:right">
    <button class="btn btn-outline btn-sm" onclick="hideModal('${modalId}')">${t('help.close')}</button>
  </div>`;
  el.style.display = '';
}

function _showProgressCloseBtn(containerId) {
  const btn = $('prog-close-' + containerId);
  if (btn) btn.style.display = '';
}

function _updateProgressStep(stepId, done) {
  const el = $('prog-' + stepId);
  if (!el) return;
  const icon = el.querySelector('.dup-step-icon');
  if (done) {
    icon.innerHTML = '&#10003;';
    el.classList.add('done');
    el.classList.remove('active');
  } else {
    icon.innerHTML = '<span class="spinner-sm"></span>';
    el.classList.add('active');
  }
}

// ---------------------------------------------------------------------------
// Create Project
// ---------------------------------------------------------------------------
function openNewProjectModal() {
  // Sync version from global selector
  const ver = $('globalVersion')?.value || '17';
  if ($('newProjVersion')) $('newProjVersion').value = ver;
  // Reset logo preview
  if ($('newProjLogoPreview')) $('newProjLogoPreview').src = 'images/placeholder.png';
  if ($('newProjLogoPath')) $('newProjLogoPath').value = '';
  // Auto-fill port + db port from version
  const nextPort = getNextAvailablePort();
  if ($('newProjPort')) $('newProjPort').value = nextPort;
  if ($('newProjDbPort')) $('newProjDbPort').value = _detectDbPort(ver);
  showModal('modalNewProject');
}

async function createProject(e) {
  try {
    const name = ($('newProjName')?.value || '').trim();
    if (!name) { alert(t('toast.enterName')); return; }
    if (!isValidProjectName(name)) { showToastMessage(t('toast.invalidName'), 'error'); return; }
    if (_allProjectNames.has(name)) { showToastMessage(t('toast.projectNameTaken'), 'error'); return; }

    // Ensure default paths are loaded
    if (!$('baseDir')?.value || !$('projectsDir')?.value) {
      try {
        const paths = await api('default-paths');
        if ($('baseDir') && !$('baseDir').value) $('baseDir').value = paths.base_dir || '';
        if ($('projectsDir') && !$('projectsDir').value) $('projectsDir').value = paths.projects_dir || '';
      } catch (e) {
        console.error('Failed to load default paths:', e);
      }
    }

    const data = getFormData();
    data.odoo_version = $('newProjVersion')?.value || '17';
    data.project_name = name;
    data.http_port = $('newProjPort')?.value || '8070';
    data.db_host = $('newProjDbHost')?.value || data.db_host || 'localhost';
    data.db_port = $('newProjDbPort')?.value || data.db_port || '5434';
    data.db_user = $('newProjDbUser')?.value || data.db_user || 'odoo';
    data.db_password = $('newProjDbPass')?.value || data.db_password || 'odoo';
    data.log_level = $('newLogLevel')?.value || 'error';
    data.workers = $('newWorkers')?.value || '2';
    data.dbfilter = $('newDbfilter')?.value || '';
    data.proxy_mode = $('newProxyMode')?.value || 'True';
    data.project_domain = $('newProjDomain')?.value || '';

    // Show progress in modal (save form BEFORE btn pending to avoid saving spinner state)
    const btn = (e || event)?.target?.closest?.('button');
    const modal = $('modalNewProject');
    const bodyEl = modal.querySelector('.modal-body');
    const footerEl = modal.querySelector('.modal-footer');
    if (!modal._origBody) modal._origBody = bodyEl.innerHTML;
    if (!modal._origFooter) modal._origFooter = footerEl?.innerHTML;
    if (btn) _setBtnPending(btn);
    bodyEl.innerHTML = '<div id="createProgressSteps"></div>';
    if (footerEl) footerEl.style.display = 'none';
    _renderProgressSteps('createProgressSteps', CREATE_STEPS, 'modalNewProject');

    const handler = (d) => _updateProgressStep(d.step, d.done);
    window.electronAPI.onEvent('create-progress', handler);

    let res;
    try {
      res = await api('create_project', data);
    } catch (e) {
      res = { ok: false, msg: String(e) };
    } finally {
      window.electronAPI.removeAllListeners('create-progress');
    }

    // Restore form for next use
    if (modal._origBody) { bodyEl.innerHTML = modal._origBody; modal._origBody = null; }
    if (modal._origFooter && footerEl) { footerEl.innerHTML = modal._origFooter; footerEl.style.display = ''; modal._origFooter = null; }

    if (res.ok) {
      // Copy logo if selected
      const logoPath = $('newProjLogoPath')?.value;
      if (logoPath) {
        try { await api('save-logo', { projects_dir: data.projects_dir, project_name: name, dataUrl: $('newProjLogoPreview')?.src || '' }); } catch {}
      }
      await new Promise(r => setTimeout(r, 400));
      hideModal('modalNewProject');
      await refreshStatus();
      showToastMessage(t('toast.projectCreated'), 'success');
      showPanel('dashboard', document.querySelectorAll('.nav-tab')[0]);
    } else {
      // Keep modal open so user can fix the issue
      showToastMessage(t('toast.failed', { msg: tMsg(res.msg || '') }), 'error');
    }
  } catch (e) {
    console.error('createProject error:', e);
    showToastMessage(t('toast.error', { msg: e.message }), 'error');
  }
}

// ---------------------------------------------------------------------------
// Project Actions
// ---------------------------------------------------------------------------
const _pendingProjects = new Map(); // name -> 'starting' | 'stopping'

function setProjectPending(name, action) {
  _pendingProjects.set(name, action);
  _applyPendingButtons(name);
}

function _applyPendingButtons(name) {
  const action = _pendingProjects.get(name);
  if (!action) return;
  document.querySelectorAll(`[data-project-action="${name}"]`).forEach(btn => {
    // Lock current width before changing content
    btn.style.minWidth = btn.offsetWidth + 'px';
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-sm"></span>`;
    btn.className = btn.className.replace(/btn-danger|btn-success/g, 'btn-outline');
  });
}

function clearProjectPending(name) {
  _pendingProjects.delete(name);
}

/** Render the Start/Stop button respecting pending state */
function renderActionBtn(p, size, extraOnclick) {
  const cls = size || 'btn-xs';
  const name = escAttr(p.name);
  const extra = extraOnclick ? ';' + extraOnclick : '';
  const pending = _pendingProjects.get(p.name);
  const iconSize = cls === 'btn-sm' ? 22 : 26;
  if (pending) {
    return `<button class="kanban-icon-btn kanban-action-btn" data-project-action="${name}" disabled><span class="spinner-sm"></span></button>`;
  }
  if (p.is_running) {
    return `<button class="kanban-icon-btn kanban-action-btn btn-stop-icon" data-project-action="${name}" onclick="stopOdoo('${name}')${extra}" title="${t('project.stop')}"><svg viewBox="0 0 24 24" fill="currentColor" width="${iconSize}" height="${iconSize}"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></button>`;
  }
  return `<button class="kanban-icon-btn kanban-action-btn btn-start-icon" data-project-action="${name}" onclick="startOdoo('${name}')${extra}" title="${t('project.start')}"><svg viewBox="0 0 24 24" fill="currentColor" width="${iconSize}" height="${iconSize}"><polygon points="6,4 20,12 6,20"/></svg></button>`;
}

async function startOdoo(name) {
  if (_pendingProjects.has(name)) return;
  setProjectPending(name, 'starting');
  try {
    const proj = _status?.projects?.find(p => p.name === name);
    const data = getFormData();
    data.project_name = name;
    data.projects_dir = _getProjectsDir(name);
    // Use project's own version + matching base_dir, not the settings values
    if (proj?.odoo_version) {
      data.odoo_version = proj.odoo_version;
      // Clear base_dir so backend derives it from odoo_version via getDefaultBaseDir()
      delete data.base_dir;
    }
    if (proj?.http_port) data.http_port = proj.http_port;
    if (proj?.longpolling_port) data.longpolling_port = proj.longpolling_port;
    showToastMessage(t('toast.odooStarting'), 'info');
    const res = await api('start_odoo', data);
    if (res.ok) {
      showToastMessage(t('toast.odooWaiting'), 'info');
      // Poll until running or timeout (30s) — lightweight mode avoids full DOM rebuild
      let running = false;
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000));
        await refreshStatus({ lightweight: true });
        const proj = _status?.projects?.find(p => p.name === name);
        if (proj?.is_running) { running = true; break; }
      }
      if (running) {
        showToastMessage(t('toast.odooRunning'), 'success');
      } else {
        showToastMessage(t('toast.odooNotResponding'), 'error');
      }
    } else {
      showToastMessage(t('toast.failed', { msg: res.msg }), 'error');
    }
  } finally {
    clearProjectPending(name);
    await refreshStatus(); // single full rebuild at end
  }
}

async function stopOdoo(name) {
  if (_pendingProjects.has(name)) return;
  setProjectPending(name, 'stopping');
  try {
    const proj = _status?.projects?.find(p => p.name === name);
    const port = proj?.http_port || '8069';
    showToastMessage(t('toast.odooStopping'), 'info');
    const res = await api('stop_odoo', { http_port: port, longpolling_port: proj?.longpolling_port || '', project_name: name, odoo_version: proj?.odoo_version || '' });
    if (res.ok) {
      showToastMessage(t('toast.odooStopped'), 'success');
      // Optimistic: immutable state update
      if (_status) {
        _status = { ..._status, projects: _status.projects.map(p =>
          p.name === name ? { ...p, is_running: false } : p
        )};
      }
    } else {
      showToastMessage(t('toast.failed', { msg: res.msg }), 'error');
    }
  } finally {
    clearProjectPending(name);
    // Poll until port is released or timeout (10s) — lightweight mode avoids full DOM rebuild
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 2000));
      await refreshStatus({ lightweight: true });
      const proj = _status?.projects?.find(p => p.name === name);
      if (!proj?.is_running) break;
    }
    await refreshStatus(); // single full rebuild at end
  }
}

function toggleOdoo(name, isRunning) {
  if (_pendingProjects.has(name)) return; // Map.has works like Set.has
  if (isRunning) stopOdoo(name);
  else startOdoo(name);
}

async function openVSCode(projPath, e) {
  const ide = getPreferredIDE();
  const label = ide === 'antigravity' ? t('project.antigravity') : t('project.vsCode');
  await withBtnPending(e, ide, label, () => api('open_vscode', { path: projPath, ide }));
}
async function openExplorer(projPath, e) {
  await withBtnPending(e, 'explorer', t('project.explorer'), () => api('open_explorer', { path: projPath }));
}

/** Set any button to pending: save original content, lock width, show spinner */
function _setBtnPending(btn) {
  if (!btn._origHtml) btn._origHtml = btn.innerHTML;
  btn.style.minWidth = btn.offsetWidth + 'px';
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-sm"></span>';
}
/** Reset button after pending — restore original innerHTML */
function _resetBtn(btn) {
  btn.disabled = false;
  btn.style.minWidth = '';
  if (btn._origHtml) {
    btn.innerHTML = btn._origHtml;
    btn._origHtml = null;
  }
}

/**
 * Reusable hook: run an async action with button pending state + double-click guard.
 */
const _actionGuards = {};
async function withBtnPending(e, guardKey, label, asyncFn, cooldown) {
  if (_actionGuards[guardKey]) return;
  _actionGuards[guardKey] = true;
  const btn = (e || event)?.target?.closest?.('button');
  if (btn) _setBtnPending(btn);
  try {
    await asyncFn();
  } finally {
    if (btn) setTimeout(() => _resetBtn(btn), 800);
    setTimeout(() => { _actionGuards[guardKey] = false; }, cooldown || 2000);
  }
}
async function openLogWindow(projectName, logPath, e, httpPort, domain) {
  const proj = _status?.projects?.find(p => p.name === projectName);
  const projVersion = proj?.odoo_version || $('odooVersion')?.value || '17';
  // Don't pass baseDir — let backend derive from odooVersion to avoid cross-version mismatch
  await withBtnPending(e, 'log-' + projectName, t('project.monitor'), () => api('open-log-window', {
    projectName, logPath,
    odooVersion: projVersion,
    projectsDir: _getProjectsDir(projectName),
    httpPort: httpPort || '',
    domain: domain || '',
    odooSourceDir: $('odooSourceDir')?.value || 'odoo',
    themePreset: localStorage.getItem('preset') || 'default',
    themeMode: localStorage.getItem('mode') || 'dark',
    themeCustom: localStorage.getItem('customColors') || '',
  }));
}
async function openBrowser(port) { await api('open_browser', { url: `http://localhost:${port}` }); }
async function openProjectUrl(domain, port) {
  if (domain && _status?.nginx) {
    // Nginx HTTPS proxy - no port needed
    await api('open_browser', { url: `https://${domain}` });
  } else if (domain) {
    await api('open_browser', { url: `http://${domain}:${port}` });
  } else {
    await api('open_browser', { url: `http://localhost:${port}` });
  }
}
function getProjectUrl(domain, port) {
  if (domain && _status?.nginx) return `https://${domain}`;
  if (domain) return `http://${domain}:${port}`;
  return `http://localhost:${port}`;
}

// Simple toast notification (bottom-right)
function showToastMessage(msg, type = 'info') {
  // Remove existing toast
  const existing = document.querySelector('.msg-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'msg-toast msg-toast-' + type;
  toast.innerHTML = `<span>${escHtml(msg)}</span><button onclick="this.parentElement.remove()">&#10005;</button>`;
  document.body.appendChild(toast);

  // Auto-remove after 6 seconds
  setTimeout(() => { if (toast.parentElement) toast.remove(); }, 6000);
}

let _editingProject = '';
async function editConfig(name) {
  _editingProject = name;
  const projDir = _getProjectsDir(name);
  const res = await api('read_config', { projects_dir: projDir, project_name: name });
  if (!res.ok) { alert('\u274C ' + tMsg(res.msg)); return; }
  $('modalConfigName').textContent = name;
  $('modalConfigContent').value = res.content;
  showModal('modalConfig');
}

async function saveConfig() {
  const projDir = _getProjectsDir(_editingProject);
  const res = await api('save_config', {
    projects_dir: projDir,
    project_name: _editingProject,
    content: $('modalConfigContent').value
  });
  hideModal('modalConfig');
  refreshStatus();
  alert(res.ok ? '\u2705 ' + t('toast.saved') : '\u274C ' + res.msg);
}

let _deletingProject = '';
function deleteProject(name) {
  _deletingProject = name;
  $('deleteConfirmText').innerHTML = t('modal.deleteConfirmPrefix') + ' <strong style="user-select:all">' + escHtml(name) + '</strong> ' + t('modal.deleteConfirmSuffix');
  $('deleteConfirmInput').value = '';
  $('deleteDropDb').checked = true;
  showModal('modalDelete');
}

async function confirmDelete(e) {
  if ($('deleteConfirmInput').value.trim() !== _deletingProject) { alert(t('toast.nameNoMatch')); return; }
  const btn = (e || event)?.target?.closest?.('button');
  const data = getFormData();
  const dropDb = $('deleteDropDb')?.checked ? 'true' : 'false';

  // Show progress in modal (save form BEFORE btn pending to avoid saving spinner state)
  const modal = $('modalDelete');
  const bodyEl = modal.querySelector('.modal-body');
  const footerEl = modal.querySelector('.modal-footer');
  if (!modal._origBody) modal._origBody = bodyEl.innerHTML;
  if (!modal._origFooter) modal._origFooter = footerEl?.innerHTML;
  if (btn) _setBtnPending(btn);
  bodyEl.innerHTML = '<div id="deleteProgressSteps"></div>';
  if (footerEl) footerEl.style.display = 'none';
  const steps = dropDb === 'true' ? DELETE_STEPS : DELETE_STEPS.filter(s => s.id !== 'drop_databases');
  _renderProgressSteps('deleteProgressSteps', steps, 'modalDelete');

  const handler = (d) => _updateProgressStep(d.step, d.done);
  window.electronAPI.onEvent('delete-progress', handler);

  let res;
  try {
    const delProj = _status?.projects?.find(p => p.name === _deletingProject);
    res = await api('delete_project', {
      projects_dir: _getProjectsDir(_deletingProject),
      project_name: _deletingProject,
      drop_databases: dropDb,
      odoo_version: delProj?.odoo_version || '',
    });
  } catch (e) {
    res = { ok: false, msg: String(e) };
  } finally {
    window.electronAPI.removeAllListeners('delete-progress');
  }

  await new Promise(r => setTimeout(r, 400));
  // Restore form for next use (must restore before resetBtn since btn may be inside footer)
  if (modal._origBody) { bodyEl.innerHTML = modal._origBody; modal._origBody = null; }
  if (modal._origFooter && footerEl) { footerEl.innerHTML = modal._origFooter; footerEl.style.display = ''; modal._origFooter = null; }
  // Reset all buttons in footer (original btn reference is stale after innerHTML restore)
  if (footerEl) footerEl.querySelectorAll('button').forEach(b => { b.disabled = false; });
  hideModal('modalDelete');
  await refreshStatus();
  if (res.ok) {
    showToastMessage(t('toast.deleted'), 'success');
  } else {
    showToastMessage(t('toast.failed', { msg: tMsg(res.msg) }), 'error');
  }
}

async function resetTemplates(name, version) {
  if (!confirm(t('modal.confirmResetOne', { name }))) return;
  const data = getFormData();
  const res = await api('reset_templates', {
    base_dir: data.base_dir,
    projects_dir: data.projects_dir,
    project_name: name,
    odoo_version: version,
  });
  if (res.ok) {
    showToastMessage(t('toast.templateReset'), 'success');
  } else {
    showToastMessage(t('toast.failed', { msg: res.msg }), 'error');
  }
}

async function resetAllTemplates() {
  if (!_status || !_status.projects || _status.projects.length === 0) {
    showToastMessage(t('toast.noProjects'), 'error');
    return;
  }
  const names = _status.projects.map(p => p.name).join(', ');
  if (!confirm(t('modal.confirmResetAll', { count: _status.projects.length, names }))) return;

  const data = getFormData();
  let ok = 0, fail = 0;
  for (const p of _status.projects) {
    const res = await api('reset_templates', {
      base_dir: data.base_dir,
      projects_dir: data.projects_dir,
      project_name: p.name,
      odoo_version: p.odoo_version || '17',
    });
    if (res.ok) ok++; else fail++;
  }
  showToastMessage(t('toast.templateResetAll', { ok, fail }), fail > 0 ? 'error' : 'success');
}

let _dupSource = '';

// Duplicate step definitions for progress display
const DUP_STEPS = [
  { id: 'create_folder', key: 'modal.dupStepFolder' },
  { id: 'junction_link', key: 'modal.dupStepJunction' },
  { id: 'copy_addons',   key: 'modal.dupStepAddons' },
  { id: 'copy_vscode',   key: 'modal.dupStepVscode' },
  { id: 'update_config', key: 'modal.dupStepConfig' },
  { id: 'setup_domain',  key: 'modal.dupStepDomain' },
];

function duplicateProject(name, port) {
  _dupSource = name;
  $('dupSourceName').textContent = name;
  $('dupNewName').value = name + '_copy';
  $('dupNewPort').value = getNextAvailablePort();
  // Reset form/progress visibility
  $('dupForm').style.display = '';
  $('dupProgress').style.display = 'none';
  $('btnDuplicate').disabled = false;
  showModal('modalDuplicate');
}

function autoDupDomain() {
  // Just trigger name validation — domain is auto-generated on backend
}

function validateDupPort() {
  const port = parseInt($('dupNewPort')?.value);
  const hint = $('dupPortHint');
  if (!hint) return;
  if (!port || port < 1024 || port > 65535) {
    hint.textContent = t('modal.dupPortInvalid');
    hint.style.display = 'block';
    return;
  }
  // Check if port is already used by any project across all versions
  const usedByCurrentVersion = _status?.projects?.some(p => parseInt(p.http_port) === port || parseInt(p.longpolling_port) === port);
  const usedByOtherVersion = _allUsedPorts.has(port);
  if (usedByCurrentVersion || usedByOtherVersion) {
    hint.textContent = t('modal.dupPortUsed');
    hint.style.display = 'block';
  } else {
    hint.textContent = '';
    hint.style.display = 'none';
  }
}

function _renderDupProgress() {
  _renderProgressSteps('dupSteps', DUP_STEPS, 'modalDuplicate');
}

function _updateDupStep(stepId, done) {
  _updateProgressStep(stepId, done);
}

async function confirmDuplicate(e) {
  const newName = ($('dupNewName')?.value || '').trim();
  if (!newName) { showToastMessage(t('toast.enterName'), 'error'); return; }
  if (!isValidProjectName(newName)) { showToastMessage(t('toast.invalidName'), 'error'); return; }

  // Check name uniqueness (across all Odoo versions)
  if (_allProjectNames.has(newName)) { showToastMessage(t('toast.projectNameTaken'), 'error'); return; }

  // Check port uniqueness
  const port = parseInt($('dupNewPort')?.value);
  const portUsed = _status?.projects?.some(p => parseInt(p.http_port) === port || parseInt(p.longpolling_port) === port);
  if (portUsed) { showToastMessage(t('modal.dupPortUsed'), 'error'); return; }

  // Button pending then switch to progress
  const btn = (e || event)?.target?.closest?.('button');
  if (btn) _setBtnPending(btn);

  // Switch to progress view
  $('dupForm').style.display = 'none';
  $('dupProgress').style.display = '';
  _renderDupProgress();

  // Listen for progress events
  const progressHandler = (data) => _updateDupStep(data.step, data.done);
  window.electronAPI.onEvent('duplicate-progress', progressHandler);

  let res;
  try {
    const srcProj = _status?.projects?.find(p => p.name === _dupSource);
    res = await api('duplicate_project', {
      odoo_version: srcProj?.odoo_version || $('odooVersion')?.value || '17',
      projects_dir: _getProjectsDir(_dupSource),
      project_name: _dupSource,
      new_name: newName,
      new_http_port: $('dupNewPort').value
    });
  } catch (e) {
    res = { ok: false, msg: String(e) };
  } finally {
    window.electronAPI.removeAllListeners('duplicate-progress');
  }

  if (res.ok) {
    // Brief pause so user sees all checkmarks
    await new Promise(r => setTimeout(r, 600));
    hideModal('modalDuplicate');
    await refreshStatus();
    showToastMessage(t('toast.duplicated'), 'success');
    showPanel('dashboard', document.querySelectorAll('.nav-tab')[0]);
  } else {
    // Show error, go back to form
    $('dupForm').style.display = '';
    $('dupProgress').style.display = 'none';
    showToastMessage(t('toast.failed', { msg: tMsg(res.msg) }), 'error');
  }
}

// ---------------------------------------------------------------------------
// Dashboard, Kanban, Project Detail, Duplicate moved to dashboard.js

// Auto-update, theme, and help logic moved to update.js, theme.js, help.js


// ---------------------------------------------------------------------------
// Init — show skeleton immediately, then load real data
// ---------------------------------------------------------------------------

// Render loading skeleton for dashboard stats
(function showSkeleton() {
  const stats = $('dashStats');
  if (stats) {
    stats.innerHTML = Array(5).fill(0).map(() =>
      '<div class="dash-stat"><div class="dash-stat-value" style="background:var(--border-default);width:40px;height:1.4em;border-radius:4px;animation:pulse 1.2s ease-in-out infinite"></div><div class="dash-stat-label" style="background:var(--border-default);width:80px;height:0.75em;border-radius:3px;margin-top:6px;animation:pulse 1.2s ease-in-out infinite"></div></div>'
    ).join('');
  }
  const kanban = $('dashKanban');
  if (kanban) {
    kanban.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-tertiary)">Loading...</div>';
  }
})();

// NOTE: refreshStatus() is called in the startup chain after settings are loaded
// (see loadOdooVersions → loadSettingsFromDisk → ... → refreshStatus)

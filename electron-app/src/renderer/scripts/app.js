// ---------------------------------------------------------------------------
// Odoo Installer - Renderer Script (Multi-version: 15, 17, 19)
// Communicates with main process via IPC (window.electronAPI)
// ---------------------------------------------------------------------------

const $ = id => document.getElementById(id);
let _status = null;

// Language dropdown
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

// Initialize i18n before rendering anything
initI18n(getCurrentLanguage()).then(() => {
  applyTranslations();
  // Sync language selector
  const sel = $('langSelect');
  if (sel) sel.value = getCurrentLanguage();
});

// Version-specific labels for install step cards
const VERSION_LABELS = {
  '15': { python: 'Python 3.10', postgres: 'PostgreSQL 14', clone: 'Clone Odoo 15' },
  '17': { python: 'Python 3.11', postgres: 'PostgreSQL 16', clone: 'Clone Odoo 17' },
  '19': { python: 'Python 3.12', postgres: 'PostgreSQL 16 + pgvector', clone: 'Clone Odoo 19' },
};

function getNextAvailablePort() {
  if (!_status || !_status.projects || _status.projects.length === 0) return 8069;
  const usedSet = new Set();
  _status.projects.forEach(p => {
    const hp = parseInt(p.http_port) || 0;
    const lp = parseInt(p.longpolling_port) || 0;
    if (hp > 0) usedSet.add(hp);
    if (lp > 0) usedSet.add(lp);
  });
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
  if (name === 'help') renderHelpPanel();
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
    odoo_version: $('odooVersion')?.value || '17',
    base_dir: $('baseDir').value,
    projects_dir: $('projectsDir').value,
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
  'odooVersion', 'baseDir', 'projectsDir', 'projectName',
  'httpPort', 'dbHost', 'dbPort', 'dbUser', 'dbPassword', 'pgSuperPassword', 'pgMode',
  'addonsPath', 'adminPasswd', 'longpollingPort', 'logLevel', 'workers',
  'listDb', 'dbfilter', 'proxyMode', 'serverWideModules', 'dataDir', 'memHard', 'memSoft',
];

function saveSettingsToDisk() {
  if (!window.electronAPI) return;
  const settings = {};
  for (const id of SETTINGS_FIELD_IDS) {
    const el = $(id);
    if (el) settings[id] = el.value;
  }
  api('save-settings', settings).catch(() => {});
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
    if (el) {
      el.addEventListener('input', onSettingChange);
      el.addEventListener('change', onSettingChange);
    }
  }
})();

// ---------------------------------------------------------------------------
// Version change handlers
// ---------------------------------------------------------------------------
async function onVersionChange(version) {
  // Update directories to match selected version
  try {
    const paths = await api('default-paths', { odoo_version: version });
    if ($('baseDir')) $('baseDir').value = paths.base_dir || '';
    if ($('projectsDir')) $('projectsDir').value = paths.projects_dir || '';
    saveSettingsToDisk();
  } catch { /* ignore */ }
  // Sync install panel version selector
  if ($('installVersion')) $('installVersion').value = version;
}

function getVersionColor(version) {
  const colors = { '15': '#3b82f6', '17': '#f0883e', '19': '#22c55e' };
  return colors[version] || '#888';
}

function onInstallVersionChange(version) {
  const labels = VERSION_LABELS[version] || VERSION_LABELS['17'];
  if ($('stepName-install_python')) $('stepName-install_python').textContent = labels.python;
  if ($('stepName-install_postgres')) $('stepName-install_postgres').textContent = labels.postgres;
  if ($('stepName-clone_odoo')) $('stepName-clone_odoo').textContent = labels.clone;
  // Sync settings version selector
  if ($('odooVersion')) $('odooVersion').value = version;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
async function refreshStatus() {
  const data = getFormData();
  const s = await api('status', data);
  _status = s;

  // Status grid
  const items = [
    ['Git', s.git, s.git_version || ''],
    ['Python 3.11', s.python311, s.python311_path],
    ['PostgreSQL', s.postgres, s.postgres_path],
    ['VS Code', s.vscode, s.vscode_version || ''],
    ['Nginx', s.nginx, s.nginx ? 'HTTPS proxy' : ''],
    ['Odoo Source', s.odoo_cloned, ''],
    ['Virtual Env', s.venv_created, ''],
    ['Requirements', s.requirements_installed, ''],
  ];
  // Only show Docker if installed
  if (s.docker) items.push(['Docker', true, 'Available']);
  $('statusGrid').innerHTML = items.map(([label, ok, detail]) => `
    <div class="status-card">
      <div class="status-icon ${ok ? 'ok' : 'missing'}">${ok ? '\u2713' : '\u2717'}</div>
      <div class="status-info"><div class="label">${label}</div>
      ${detail ? `<div class="detail">${escHtml(detail)}</div>` : ''}</div>
    </div>`).join('');

  if (s.docker_postgres && s.docker_postgres.length > 0) {
    $('statusGrid').innerHTML += s.docker_postgres.map(c => `
      <div class="status-card" style="border-color:#1a3a1a">
        <div class="status-icon ok">PG</div>
        <div class="status-info"><div class="label">${escHtml(c.name)}</div>
        <div class="detail">${escHtml(c.image)} | port:${escHtml(c.port)} | ${escHtml(c.status)}</div></div>
      </div>`).join('');
  }

  // Native PG detail
  const np = s.native_postgres;
  if (np) {
    $('nativePgDetail').innerHTML = `<div class="pg-detail">
      <h4>Native PostgreSQL</h4>
      <div class="project-detail-grid">
        <div class="detail-item"><div class="detail-label">Status</div><div class="detail-value">${np.is_ready ? '<span style="color:#22c55e">Running</span>' : '<span style="color:#ef4444">Stopped</span>'}</div></div>
        <div class="detail-item"><div class="detail-label">Port</div><div class="detail-value">${escHtml(np.port || 'N/A')}</div></div>
        <div class="detail-item"><div class="detail-label">Data Dir</div><div class="detail-value">${escHtml(np.data_dir || 'N/A')}</div></div>
        <div class="detail-item"><div class="detail-label">Bin Path</div><div class="detail-value">${escHtml(np.bin_path || 'N/A')}</div></div>
      </div>
      ${np.databases && np.databases.length ? `<div><span class="detail-label">Databases:</span><div class="pg-databases">${np.databases.map(d => `<span class="db-tag">${escHtml(d)}</span>`).join('')}</div></div>` : ''}
    </div>`;
  } else {
    $('nativePgDetail').innerHTML = '';
  }

  // Show PostgreSQL Mode dropdown only when Docker has running PostgreSQL containers
  const pgModeGroup = $('pgModeGroup');
  if (pgModeGroup) {
    const hasDockerPg = s.docker_postgres && s.docker_postgres.length > 0;
    pgModeGroup.style.display = hasDockerPg ? '' : 'none';
  }

  // Projects list + Dashboard + Install steps
  renderProjects(s);
  renderDashboard(s);
  refreshInstallStatus();

  // Auto-update port field for new project
  const nextPort = getNextAvailablePort();
  if ($('newProjPort')) $('newProjPort').value = nextPort;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
function renderProjects(s) {
  const list = $('projectsList');
  if (!s.projects || s.projects.length === 0) {
    list.innerHTML = '<div class="empty"><p>No projects yet. Create one to get started.</p></div>';
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
          ${p.is_running
            ? '<span class="tag tag-running">${t('project.runningTag')}</span>'
            : '<span class="tag tag-stopped">${t('project.stoppedTag')}</span>'}
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
        ${p.is_running
          ? `<button class="btn btn-danger btn-xs" data-project-action="${escAttr(p.name)}" onclick="stopOdoo('${escAttr(p.name)}')">${t('project.stop')}</button>`
          : `<button class="btn btn-success btn-xs" data-project-action="${escAttr(p.name)}" onclick="startOdoo('${escAttr(p.name)}')">${t('project.start')}</button>`}
        <button class="btn btn-vscode btn-xs" onclick="openVSCode('${escAttr(p.path)}')">${t('project.vsCode')}</button>
        <button class="btn btn-outline btn-xs" onclick="openExplorer('${escAttr(p.path)}')">${t('project.explorer')}</button>
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
    // Log tab
    const el = $('log');
    if (el) {
      el.innerHTML += `<div class="line">${escHtml(line)}</div>`;
      el.scrollTop = el.scrollHeight;
    }
    // Install inline log
    appendInstallLog(line);
  });

  window.electronAPI.onTaskProgress((task) => {
    // Map step labels to step IDs for card updates
    const stepLabelMap = {
      'Installing Nginx (HTTPS)...': 'install_nginx',
      'Installing Git...': 'install_git',
      'Installing VS Code...': 'install_vscode',
      'Installing Python 3.11...': 'install_python',
      'Installing PostgreSQL...': 'install_postgres',
      'Creating DB user...': 'install_postgres', // group with PG
      'Cloning Odoo 17...': 'clone_odoo',
      'Creating virtual environment...': 'create_venv',
      'Installing requirements...': 'install_requirements',
    };

    if (task.status === 'running') {
      const currentStep = stepLabelMap[task.step];
      if (currentStep) {
        const st = _stepStates.get(currentStep);
        // Don't overwrite user-initiated step
        if (!st || st.source !== 'user') {
          _stepStates.set(currentStep, { state: 'running', source: 'full' });
          updateStepCard(currentStep, 'running', task.step);
        }
      }
    } else if (task.status === 'done') {
      if (task.results) {
        for (const r of task.results) {
          const stepId = stepLabelMap[r.step];
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
// Installation - Step Cards UI
// ---------------------------------------------------------------------------

const STEP_MAP = {
  install_nginx: { label: 'Installing Nginx (HTTPS)...', check: s => s.nginx },
  install_git: { label: 'Installing Git...', check: s => s.git },
  install_vscode: { label: 'Installing VS Code...', check: s => s.vscode },
  install_python: { label: 'Installing Python 3.11...', check: s => s.python311 },
  install_postgres: { label: 'Installing PostgreSQL...', check: s => s.postgres },
  clone_odoo: { label: 'Cloning Odoo 17...', check: s => s.odoo_cloned },
  create_venv: { label: 'Creating virtual environment...', check: s => s.venv_created },
  install_requirements: { label: 'Installing requirements...', check: s => s.requirements_installed },
};

function updateStepCard(stepId, state, statusText) {
  const card = $('step-' + stepId);
  const icon = $('stepIcon-' + stepId);
  const status = $('stepStatus-' + stepId);
  if (!card) return;

  // Reset download progress when step completes or errors
  if (state === 'done' || state === 'error') {
    card.style.setProperty('--dl-progress', state === 'done' ? '100%' : '0%');
    const prog = $('stepProgress-' + stepId);
    if (prog) prog.textContent = '';
  }

  card.className = 'step-card' + (state ? ' ' + state : '');
  if (state === 'done') {
    icon.innerHTML = '\u2713';
    status.textContent = statusText || 'Done';
  } else if (state === 'running') {
    icon.innerHTML = '<span style="animation:spin 1s linear infinite;display:inline-block">&#9696;</span>';
    status.textContent = statusText || 'Installing...';
  } else if (state === 'error') {
    icon.innerHTML = '\u2717';
    status.textContent = statusText || 'Failed';
  } else if (state === 'skip') {
    icon.innerHTML = '\u2212';
    status.textContent = statusText || 'Skipped';
  } else {
    status.textContent = statusText || '';
  }
}

function refreshInstallStatus() {
  if (!_status) return;
  for (const [stepId, info] of Object.entries(STEP_MAP)) {
    const st = _stepStates.get(stepId);
    // Don't overwrite running steps or recently completed user steps
    if (st && (st.state === 'running' || st.source === 'user')) continue;

    if (info.check && info.check(_status)) {
      _stepStates.set(stepId, { state: 'done', source: 'status' });
      updateStepCard(stepId, 'done', 'Installed');
    } else {
      _stepStates.set(stepId, { state: 'idle', source: 'status' });
      updateStepCard(stepId, '', '');
      const icon = $('stepIcon-' + stepId);
      if (icon) {
        const idx = Object.keys(STEP_MAP).indexOf(stepId);
        icon.innerHTML = String(idx + 1);
      }
    }
  }
}

async function checkInstallStatus() {
  const btn = $('btnCheckStatus');
  if (btn) { btn.disabled = true; btn.textContent = t('install.checking'); }

  const allSteps = Object.keys(STEP_MAP);

  // Set non-running steps to "checking" animation
  for (const stepId of allSteps) {
    const st = _stepStates.get(stepId);
    if (st && st.state === 'running') continue; // Skip running steps
    updateStepCard(stepId, 'running', 'Checking...');
  }

  // Fetch fresh status
  await refreshStatus();

  // Animate each step one by one with delay — skip running steps
  for (let i = 0; i < allSteps.length; i++) {
    const stepId = allSteps[i];
    const st = _stepStates.get(stepId);
    if (st && st.state === 'running') continue; // Skip running steps
    const info = STEP_MAP[stepId];
    await new Promise(r => setTimeout(r, 300));
    if (info.check && info.check(_status)) {
      updateStepCard(stepId, 'done', 'Installed');
    } else {
      updateStepCard(stepId, 'error', 'Not found');
    }
  }

  // Summary toast
  const installed = allSteps.filter(id => STEP_MAP[id].check && STEP_MAP[id].check(_status)).length;
  const total = allSteps.length;
  if (installed === total) {
    showToastMessage(`All ${total} components installed!`, 'success');
  } else {
    showToastMessage(`${installed}/${total} components installed`, installed > 0 ? 'info' : 'error');
  }

  if (btn) { btn.disabled = false; btn.textContent = t('install.checkStatus'); }
}

function appendInstallLog(line) {
  const logEl = $('installLogBox');
  const wrap = $('installLog');
  if (!logEl || !wrap) return;
  wrap.style.display = 'block';
  logEl.innerHTML += `<div class="line">${escHtml(line)}</div>`;
  logEl.scrollTop = logEl.scrollHeight;
}

const _stepStates = new Map(); // { state: 'idle'|'running'|'done'|'error', source: 'user'|'full'|'status' }
let _fullInstallRunning = false;

/** Sync Install Everything button disabled state based on running steps */
function syncFullInstallBtn() {
  const btn = $('btnFullInstall');
  if (!btn) return;
  if (_fullInstallRunning) return; // Already managed by fullInstall()
  let anyRunning = false;
  for (const [, s] of _stepStates) {
    if (s.state === 'running') { anyRunning = true; break; }
  }
  btn.disabled = anyRunning;
  if (anyRunning) {
    btn.title = 'Wait for running step to finish';
  } else {
    btn.title = '';
  }
}

async function fullInstall() {
  if (_fullInstallRunning) return;
  // Block if any step is running individually
  for (const [, s] of _stepStates) {
    if (s.state === 'running' && s.source === 'user') return;
  }
  _fullInstallRunning = true;

  const btn = $('btnFullInstall');
  btn.disabled = true;
  btn.textContent = t('install.installing');

  // Clear log
  const logEl = $('installLogBox');
  if (logEl) logEl.innerHTML = '';
  $('installLog').style.display = 'block';

  // Reset step cards — skip user-initiated running steps
  for (const stepId of Object.keys(STEP_MAP)) {
    const st = _stepStates.get(stepId);
    if (st && st.state === 'running' && st.source === 'user') continue;
    _stepStates.set(stepId, { state: 'idle', source: 'full' });
    updateStepCard(stepId, '', 'Pending');
  }

  const res = await api('full_install', getFormData());

  if (!res.ok) {
    btn.disabled = false;
    btn.textContent = t('install.installAll');
    _fullInstallRunning = false;
    showToastMessage(t('toast.installFail', { msg: res.msg }), 'error');
  }
}

async function runStep(step) {
  // Block if full install running or any step running
  const st = _stepStates.get(step);
  if (_fullInstallRunning || (st && st.state === 'running')) return;
  // Block if another step is running individually
  for (const [, s] of _stepStates) {
    if (s.state === 'running' && s.source === 'user') return;
  }

  _stepStates.set(step, { state: 'running', source: 'user' });
  updateStepCard(step, 'running', 'Installing...');
  syncFullInstallBtn();
  $('installLog').style.display = 'block';

  try {
    const res = await api('run_step', { ...getFormData(), step });
    const state = res.ok ? 'done' : 'error';
    _stepStates.set(step, { state, source: 'user' });
    updateStepCard(step, state, res.msg || (res.ok ? t('install.done') : t('install.failed')));
    if (res.ok) {
      showToastMessage(t('toast.stepSuccess', { step: STEP_MAP[step]?.label || step, msg: res.msg }), 'success');
    } else {
      showToastMessage(t('toast.stepFail', { msg: res.msg }), 'error');
    }
    refreshStatus();
  } catch (e) {
    _stepStates.set(step, { state: 'error', source: 'user' });
    updateStepCard(step, 'error', 'Failed');
  } finally {
    syncFullInstallBtn();
    // After 2s, downgrade source so refreshStatus can update
    setTimeout(() => {
      const cur = _stepStates.get(step);
      if (cur && cur.source === 'user' && cur.state !== 'running') {
        _stepStates.set(step, { ...cur, source: 'status' });
      }
    }, 2000);
  }
}

// ---------------------------------------------------------------------------
// Create Project
// ---------------------------------------------------------------------------
async function createProject() {
  try {
    const name = ($('newProjName')?.value || '').trim();
    if (!name) { alert(t('toast.enterName')); return; }

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
    data.workers = $('newWorkers')?.value || '0';
    data.dbfilter = $('newDbfilter')?.value || '';
    data.proxy_mode = $('newProxyMode')?.value || 'True';
    data.project_domain = $('newProjDomain')?.value || '';

    console.log('Creating project with data:', JSON.stringify(data));
    showToastMessage(t('toast.projectCreating', { name }), 'info');

    const res = await api('create_project', data);
    console.log('Create project result:', JSON.stringify(res));

    hideModal('modalNewProject');
    refreshStatus();
    if (res.ok) {
      showToastMessage(t('toast.projectCreated'), 'success');
      // Switch to Dashboard to see new project
      showPanel('dashboard', document.querySelectorAll('.nav-tab')[0]);
    } else {
      showToastMessage(t('toast.failed', { msg: res.msg || '' }), 'error');
    }
  } catch (e) {
    console.error('createProject error:', e);
    showToastMessage(t('toast.error', { msg: e.message }), 'error');
  }
}

// ---------------------------------------------------------------------------
// Project Actions
// ---------------------------------------------------------------------------
const _pendingProjects = new Set(); // projects with start/stop in progress

function setProjectPending(name, label) {
  _pendingProjects.add(name);
  // Update all Start/Stop buttons for this project to pending state
  document.querySelectorAll(`[data-project-action="${name}"]`).forEach(btn => {
    btn.disabled = true;
    btn.textContent = label;
    btn.className = btn.className.replace(/btn-danger|btn-success/g, 'btn-outline');
  });
}

function clearProjectPending(name) {
  _pendingProjects.delete(name);
}

async function startOdoo(name) {
  if (_pendingProjects.has(name)) return;
  setProjectPending(name, 'Starting...');

  const proj = _status?.projects?.find(p => p.name === name);
  const data = getFormData();
  data.project_name = name;
  // Use project's own version, not the settings version
  if (proj?.odoo_version) data.odoo_version = proj.odoo_version;
  showToastMessage(t('toast.odooStarting'), 'info');
  const res = await api('start_odoo', data);
  if (res.ok) {
    showToastMessage(t('toast.odooWaiting'), 'info');
    const port = _status?.projects?.find(p => p.name === name)?.http_port || '8069';
    // Poll until running or timeout (30s)
    let running = false;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      await refreshStatus();
      const proj = _status?.projects?.find(p => p.name === name);
      if (proj?.is_running) { running = true; break; }
    }
    if (running) {
      const proj = _status?.projects?.find(p => p.name === name);
      const domain = proj?.domain || '';
      showToastMessage(t('toast.odooRunning'), 'success');
      // Optimistic: mark as running in local state
      if (proj) proj.is_running = true;
    } else {
      showToastMessage(t('toast.odooNotResponding'), 'error');
    }
  } else {
    showToastMessage(t('toast.failed', { msg: res.msg }), 'error');
  }
  clearProjectPending(name);
  // Render immediately with current state
  if (_status) { renderProjects(_status); renderDashboard(_status); }
  await refreshStatus();
}

async function stopOdoo(name) {
  if (_pendingProjects.has(name)) return;
  setProjectPending(name, 'Stopping...');

  const port = _status?.projects?.find(p => p.name === name)?.http_port || '8069';
  showToastMessage(t('toast.odooStopping'), 'info');
  const res = await api('stop_odoo', { http_port: port });
  if (res.ok) {
    showToastMessage(t('toast.odooStopped'), 'success');
    // Optimistic: mark as stopped in local state immediately
    const proj = _status?.projects?.find(p => p.name === name);
    if (proj) proj.is_running = false;
  } else {
    showToastMessage(t('toast.failed', { msg: res.msg }), 'error');
  }
  clearProjectPending(name);
  // Render immediately with optimistic state
  if (_status) { renderProjects(_status); renderDashboard(_status); }
  // Wait for port to fully release, then confirm with real status
  await new Promise(r => setTimeout(r, 1500));
  await refreshStatus();
}

function toggleOdoo(name, isRunning) {
  if (_pendingProjects.has(name)) return;
  if (isRunning) stopOdoo(name);
  else startOdoo(name);
}

async function openVSCode(path) { await api('open_vscode', { path }); }
async function openExplorer(path) { await api('open_explorer', { path }); }
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
  const data = getFormData();
  const res = await api('read_config', { projects_dir: data.projects_dir, project_name: name });
  if (!res.ok) { alert('\u274C ' + res.msg); return; }
  $('modalConfigName').textContent = name;
  $('modalConfigContent').value = res.content;
  showModal('modalConfig');
}

async function saveConfig() {
  const data = getFormData();
  const res = await api('save_config', {
    projects_dir: data.projects_dir,
    project_name: _editingProject,
    content: $('modalConfigContent').value
  });
  hideModal('modalConfig');
  refreshStatus();
  alert(res.ok ? '\u2705 Saved!' : '\u274C ' + res.msg);
}

let _deletingProject = '';
function deleteProject(name) {
  _deletingProject = name;
  $('deleteTargetName').textContent = name;
  $('deleteConfirmInput').value = '';
  showModal('modalDelete');
}

async function confirmDelete() {
  if ($('deleteConfirmInput').value !== _deletingProject) { alert(t('toast.nameNoMatch')); return; }
  const data = getFormData();
  const dropDb = $('deleteDropDb')?.checked ? 'true' : 'false';
  const res = await api('delete_project', {
    projects_dir: data.projects_dir,
    project_name: _deletingProject,
    drop_databases: dropDb,
  });
  hideModal('modalDelete');
  refreshStatus();
  alert(res.ok ? '\u2705 ' + res.msg : '\u274C ' + res.msg);
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
  showToastMessage(`Reset done: ${ok} OK, ${fail} failed.`, fail > 0 ? 'error' : 'success');
}

let _dupSource = '';
function duplicateProject(name, port) {
  _dupSource = name;
  $('dupSourceName').textContent = name;
  $('dupNewName').value = name + '_copy';
  $('dupNewPort').value = getNextAvailablePort();
  showModal('modalDuplicate');
}

async function confirmDuplicate() {
  const data = getFormData();
  const res = await api('duplicate_project', {
    base_dir: data.base_dir,
    projects_dir: data.projects_dir,
    project_name: _dupSource,
    new_name: $('dupNewName').value,
    new_http_port: $('dupNewPort').value
  });
  hideModal('modalDuplicate');
  refreshStatus();
  alert(res.ok ? '\u2705 Duplicated!\n' + res.msg : '\u274C ' + res.msg);
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
function refreshDashboard() {
  refreshStatus();
}

function renderDashboard(s) {
  if (!s || !s.projects) return;
  const projects = s.projects;

  // Stats row
  const totalProjects = projects.length;
  const totalModules = projects.reduce((sum, p) => sum + (p.custom_modules || 0), 0);
  const uniquePorts = new Set(projects.map(p => p.db_port || '5432')).size;

  $('dashStats').innerHTML = `
    <div class="dash-stat accent">
      <div class="dash-stat-value">${totalProjects}</div>
      <div class="dash-stat-label">Total Projects</div>
    </div>
    <div class="dash-stat green">
      <div class="dash-stat-value">${totalModules}</div>
      <div class="dash-stat-label">Custom Modules</div>
    </div>
    <div class="dash-stat blue">
      <div class="dash-stat-value">${uniquePorts}</div>
      <div class="dash-stat-label">DB Connections</div>
    </div>
    <div class="dash-stat">
      <div class="dash-stat-value">${s.python311 ? '<span style="color:#3fb950">OK</span>' : '<span style="color:#f85149">Missing</span>'}</div>
      <div class="dash-stat-label">Python 3.11</div>
    </div>
    <div class="dash-stat">
      <div class="dash-stat-value">${s.postgres ? '<span style="color:#3fb950">OK</span>' : '<span style="color:#f85149">Missing</span>'}</div>
      <div class="dash-stat-label">PostgreSQL</div>
    </div>
    <div class="dash-stat">
      <div class="dash-stat-value">${s.vscode ? '<span style="color:#3fb950">' + escHtml(s.vscode_version || 'OK') + '</span>' : '<span style="color:#f85149">Missing</span>'}</div>
      <div class="dash-stat-label">VS Code</div>
    </div>
  `;

  // Kanban cards
  renderKanban(projects);
}

function renderKanban(projects) {
  const search = ($('dashSearch')?.value || '').toLowerCase();
  const filter = $('dashFilter')?.value || 'all';

  let filtered = projects;

  // Search filter
  if (search) {
    filtered = filtered.filter(p =>
      p.name.toLowerCase().includes(search) ||
      (p.http_port || '').includes(search) ||
      (p.db_user || '').toLowerCase().includes(search) ||
      (p.path || '').toLowerCase().includes(search)
    );
  }

  // Category filter
  if (filter === 'custom') {
    filtered = filtered.filter(p => p.custom_modules > 0);
  }

  // Show/hide empty state
  $('dashEmpty').style.display = filtered.length === 0 ? 'block' : 'none';
  $('dashKanban').style.display = filtered.length === 0 ? 'none' : 'grid';

  $('dashKanban').innerHTML = filtered.map(p => `
    <div class="kanban-card">
      <div class="kanban-card-header">
        <span class="kanban-card-name">${escHtml(p.name)}</span>
        <span class="kanban-card-port" onclick="openProjectUrl('${escAttr(p.domain)}','${escAttr(p.http_port || '8069')}')" title="Open in browser" style="cursor:pointer">:${escHtml(p.http_port || '8069')}</span>
      </div>
      <div class="kanban-card-url" onclick="openProjectUrl('${escAttr(p.domain)}','${escAttr(p.http_port || '8069')}')" title="Click to open">${escHtml(getProjectUrl(p.domain, p.http_port || '8069'))}</div>
      <div class="kanban-card-body">
        <div class="kanban-card-tags">
          <span class="kanban-tag kanban-tag-version" style="background:${getVersionColor(p.odoo_version)};color:#fff">v${escHtml(p.odoo_version || '17')}</span>
          ${p.is_running
            ? '<span class="kanban-tag kanban-tag-running">${t('project.runningTag')}</span>'
            : '<span class="kanban-tag kanban-tag-stopped">${t('project.stoppedTag')}</span>'}
          ${p.custom_modules > 0 ? `<span class="kanban-tag kanban-tag-modules">${p.custom_modules} modules</span>` : ''}
        </div>
      </div>
      <div class="kanban-card-actions">
        ${p.is_running
          ? `<button class="btn btn-danger btn-xs" data-project-action="${escAttr(p.name)}" onclick="stopOdoo('${escAttr(p.name)}')">${t('project.stop')}</button>`
          : `<button class="btn btn-success btn-xs" data-project-action="${escAttr(p.name)}" onclick="startOdoo('${escAttr(p.name)}')">${t('project.start')}</button>`}
        <button class="btn btn-vscode btn-xs" onclick="openVSCode('${escAttr(p.path)}')">${t('project.vsCode')}</button>
        <button class="btn btn-outline btn-xs" onclick="openExplorer('${escAttr(p.path)}')">${t('project.explorer')}</button>
        <button class="btn btn-outline btn-xs" onclick="showProjectDetail('${escAttr(p.name)}')">${t('project.detail')}</button>
        <button class="btn btn-danger btn-xs" onclick="deleteProject('${escAttr(p.name)}')">${t('project.delete')}</button>
      </div>
    </div>
  `).join('');
}

function filterDashboard() {
  if (_status && _status.projects) {
    renderKanban(_status.projects);
  }
}

function showProjectDetail(name) {
  if (!_status || !_status.projects) return;
  const p = _status.projects.find(proj => proj.name === name);
  if (!p) return;

  $('detailTitle').innerHTML = `${escHtml(p.name)} <span class="tag" style="font-size:0.7rem;margin-left:8px;background:${getVersionColor(p.odoo_version)};color:#fff;border:none">v${escHtml(p.odoo_version || '17')}</span> ${p.is_running
    ? '<span class="tag tag-running" style="font-size:0.7rem;margin-left:4px">running</span>'
    : '<span class="tag tag-stopped" style="font-size:0.7rem;margin-left:8px">stopped</span>'}`;

  const editableFields = [
    ['http_port', 'HTTP Port', p.http_port, 'number'],
    ['db_port', 'DB Port', p.db_port || '5434', 'number'],
    ['log_level', 'Log Level', p.log_level || 'error', 'select:error,warn,info,debug'],
  ];

  const readonlyFields = [];
  if (p.custom_modules > 0) readonlyFields.push(['Custom Modules', p.custom_modules]);

  // Parse addons_path into array
  const addonsPaths = (p.addons_path || '').split(',').map(s => s.trim()).filter(Boolean);

  $('detailContent').innerHTML = `
    <div class="detail-grid">
      ${editableFields.map(([key, label, value, type]) => {
        if (type.startsWith('select:')) {
          const opts = type.split(':')[1].split(',');
          return `<div class="detail-item detail-editable">
            <div class="detail-label">${label}</div>
            <select class="detail-input" data-key="${key}">
              ${opts.map(o => `<option value="${o}" ${o === value ? 'selected' : ''}>${o}</option>`).join('')}
            </select>
          </div>`;
        }
        return `<div class="detail-item detail-editable">
          <div class="detail-label">${label}</div>
          <input class="detail-input" data-key="${key}" type="${type}" value="${escHtml(value)}">
        </div>`;
      }).join('')}
      <div class="detail-item detail-editable">
        <div class="detail-label">${t('project.adminPassword')}</div>
        <div style="display:flex;gap:4px;align-items:center;margin-top:4px">
          <input class="detail-input" data-key="admin_passwd" type="password" value="${escHtml(p.admin_passwd || 'odoo')}" style="margin:0;flex:1" id="detailAdminPwd">
          <button class="btn-icon" onclick="togglePwdVisibility('detailAdminPwd')" title="Show/Hide" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        </div>
      </div>
      ${readonlyFields.map(([l, v]) => `
        <div class="detail-item">
          <div class="detail-label">${l}</div>
          <div class="detail-value">${escHtml(v)}</div>
        </div>
      `).join('')}
      <div class="detail-item" style="grid-column:1/-1">
        <div class="detail-label">Path</div>
        <div class="detail-value detail-path" title="${escHtml(p.path)}" onclick="openExplorer('${escAttr(p.path)}')">${escHtml(p.path)}</div>
      </div>
    </div>
    <div class="detail-item" style="margin-bottom:16px;padding:12px;background:var(--bg-surface);border:1px solid var(--border-default);border-radius:8px">
      <div class="detail-label" style="margin-bottom:8px">${t('project.addonsPath')}</div>
      <div id="detailAddonsList">
        ${addonsPaths.map((ap, i) => `
          <div class="addons-row" style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
            <input class="detail-input detail-addons-input" value="${escHtml(ap)}" style="margin:0;flex:1" readonly>
            <button class="btn-icon btn-icon-danger" onclick="removeAddonPath(${i})" title="Remove">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        `).join('')}
      </div>
      <button class="btn btn-outline btn-xs" onclick="addAddonPath()" style="margin-top:4px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        ${t('project.addFolder')}
      </button>
    </div>
    ${p.addon_dirs && p.addon_dirs.length ? `
      <div style="margin-bottom:16px">
        <div class="detail-label" style="margin-bottom:8px">Addon Directories</div>
        <div class="detail-grid">
          ${p.addon_dirs.map(a => `
            <div class="detail-item">
              <div class="detail-label">${a.is_base ? 'Base Addons' : 'Custom Addons'}</div>
              <div class="detail-value">${escHtml(a.path)} (${a.count} modules)</div>
            </div>
          `).join('')}
        </div>
      </div>
    ` : ''}
    <div class="cmd-box" onclick="copyCmd(this)" title="Click to copy" style="margin-bottom:16px">
      <span>${escHtml(p.start_command)}</span>
      <span class="copy-hint">${t('project.clickCopy')}</span>
    </div>
    <div style="margin-bottom:16px">
      <div class="detail-label" style="margin-bottom:8px">${t('project.odooLog')}</div>
      <div class="log-box" id="detailLogBox" style="max-height:250px;font-size:0.72rem" data-logpath="${escAttr(p.logfile || (p.path + '\\odoo.log'))}">
        <div style="color:var(--text-tertiary);padding:8px">${t('project.loadingLog')}</div>
      </div>
    </div>
    <div class="btn-row" style="justify-content:space-between">
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${p.is_running
          ? `<button class="btn btn-danger btn-sm" data-project-action="${escAttr(p.name)}" onclick="stopOdoo('${escAttr(p.name)}');hideModal('modalDetail')">${t('project.stop')}</button>`
          : `<button class="btn btn-success btn-sm" data-project-action="${escAttr(p.name)}" onclick="startOdoo('${escAttr(p.name)}');hideModal('modalDetail')">${t('project.start')}</button>`}
        <button class="btn btn-vscode btn-sm" onclick="openVSCode('${escAttr(p.path)}')">${t('project.vsCode')}</button>
        <button class="btn btn-outline btn-sm" onclick="openExplorer('${escAttr(p.path)}')">${t('project.explorer')}</button>
        <button class="btn btn-outline btn-sm" onclick="resetTemplates('${escAttr(p.name)}','${escAttr(p.odoo_version || '17')}')">${t('project.resetTemplates')}</button>
        <button class="btn btn-outline btn-sm" onclick="hideModal('modalDetail');duplicateProject('${escAttr(p.name)}','${escAttr(p.http_port)}')">${t('project.duplicate')}</button>
        <button class="btn btn-danger btn-sm" onclick="hideModal('modalDetail');deleteProject('${escAttr(p.name)}')">${t('project.delete')}</button>
      </div>
      <button class="btn btn-primary btn-sm" onclick="saveDetailAndRestart('${escAttr(p.name)}')">${t('project.saveRestart')}</button>
    </div>
  `;

  showModal('modalDetail');

  // Start watching log file
  startLogWatch();
}

let _currentLogPath = null;
let _logRetryTimer = null;

async function startLogWatch() {
  const logBox = $('detailLogBox');
  if (!logBox) return;
  const logPath = logBox.getAttribute('data-logpath');
  if (!logPath) return;

  // Stop previous watcher + retry timer
  await stopLogWatch();
  _currentLogPath = logPath;

  try {
    const res = await api('watch-log', { logPath });
    if (res.ok && res.lines) {
      logBox.innerHTML = res.lines
        .filter(l => l.trim())
        .map(l => `<div class="line">${escHtml(l)}</div>`)
        .join('');
      logBox.scrollTop = logBox.scrollHeight;
    } else {
      logBox.innerHTML = '<div style="color:var(--text-tertiary);padding:8px">${t('project.noLogFile')}</div>';
      // Retry every 3s until log file appears
      _logRetryTimer = setInterval(async () => {
        if (_currentLogPath !== logPath) { clearInterval(_logRetryTimer); return; }
        try {
          const retry = await api('watch-log', { logPath });
          if (retry.ok && retry.lines) {
            clearInterval(_logRetryTimer);
            _logRetryTimer = null;
            const box = $('detailLogBox');
            if (box) {
              box.innerHTML = retry.lines
                .filter(l => l.trim())
                .map(l => `<div class="line">${escHtml(l)}</div>`)
                .join('');
              box.scrollTop = box.scrollHeight;
            }
            _setupLogListener();
          }
        } catch { /* keep retrying */ }
      }, 3000);
      return;
    }
  } catch {
    logBox.innerHTML = '<div style="color:var(--text-tertiary);padding:8px">${t('project.noLogFound')}</div>';
    return;
  }

  _setupLogListener();
}

function _setupLogListener() {
  // Listen for new lines
  if (window.electronAPI) {
    window.electronAPI.removeAllListeners('project-log');
    window.electronAPI.onEvent('project-log', (data) => {
      if (data.logPath !== _currentLogPath) return;
      const box = $('detailLogBox');
      if (!box) return;
      for (const line of data.lines) {
        box.innerHTML += `<div class="line">${escHtml(line)}</div>`;
      }
      box.scrollTop = box.scrollHeight;
      // Keep max 1000 lines in DOM
      while (box.children.length > 1000) box.removeChild(box.firstChild);
    });
  }
}

async function stopLogWatch() {
  if (_logRetryTimer) { clearInterval(_logRetryTimer); _logRetryTimer = null; }
  if (_currentLogPath) {
    try { await api('unwatch-log', { logPath: _currentLogPath }); } catch {}
    _currentLogPath = null;
  }
  if (window.electronAPI) {
    window.electronAPI.removeAllListeners('project-log');
  }
}

// Stop log watch when modal closes
const _origHideModal = typeof hideModal === 'function' ? hideModal : null;

function autoGenerateDomain() {
  const name = ($('newProjName')?.value || '').trim();
  const domain = name ? name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase() + '.odoo.local' : '';
  if ($('newProjDomain')) $('newProjDomain').value = domain;
}

function togglePwdVisibility(id) {
  const el = $(id);
  if (!el) return;
  el.type = el.type === 'password' ? 'text' : 'password';
}

function removeAddonPath(index) {
  const rows = document.querySelectorAll('#detailAddonsList .addons-row');
  if (rows[index]) rows[index].remove();
}

async function addAddonPath() {
  const result = await api('pick-folder');
  if (!result || !result.path) return;
  const list = $('detailAddonsList');
  const i = list.querySelectorAll('.addons-row').length;
  const div = document.createElement('div');
  div.className = 'addons-row';
  div.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:6px';
  div.innerHTML = `
    <input class="detail-input detail-addons-input" value="${escHtml(result.path)}" style="margin:0;flex:1" readonly>
    <button class="btn-icon btn-icon-danger" onclick="this.parentElement.remove()" title="Remove">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  `;
  list.appendChild(div);
}

async function saveDetailAndRestart(name) {
  try {
    // Read current config
    const data = getFormData();
    const readRes = await api('read_config', { projects_dir: data.projects_dir, project_name: name });
    if (!readRes.ok) { showToastMessage(t('toast.readConfigFail', { msg: readRes.msg }), 'error'); return; }

    // Parse current config and update fields
    let content = readRes.content;

    // Collect addons_path from addon rows (convert \ to / for odoo.conf)
    const addonInputs = document.querySelectorAll('#detailAddonsList .detail-addons-input');
    const addonPaths = [...addonInputs].map(el => el.value.trim().replace(/\\/g, '/')).filter(Boolean).join(',');
    const addonsRegex = /^addons_path\s*=.*$/m;
    if (addonsRegex.test(content)) {
      content = content.replace(addonsRegex, `addons_path = ${addonPaths}`);
    } else {
      // addons_path not found in config, add it after [options]
      content = content.replace('[options]', `[options]\naddons_path = ${addonPaths}`);
    }

    // Update other fields
    const inputs = document.querySelectorAll('#detailContent .detail-input:not(.detail-addons-input)');
    for (const input of inputs) {
      const key = input.getAttribute('data-key');
      const value = input.value;
      if (!key) continue;
      // Replace or add key in [options] section
      const regex = new RegExp(`^${key}\\s*=.*$`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${key} = ${value}`);
      } else {
        // Add after [options] line
        content = content.replace('[options]', `[options]\n${key} = ${value}`);
      }
    }

    // Save config
    showToastMessage(t('toast.configSaving'), 'info');
    const saveRes = await api('save_config', { projects_dir: data.projects_dir, project_name: name, content });
    if (!saveRes.ok) { showToastMessage(t('toast.saveFail', { msg: saveRes.msg }), 'error'); return; }

    // Restart Odoo if running
    const port = _status?.projects?.find(p => p.name === name)?.http_port || '8069';
    const proj = _status?.projects?.find(p => p.name === name);
    if (proj?.is_running) {
      showToastMessage(t('toast.restarting'), 'info');
      await api('stop_odoo', { http_port: port });
      await new Promise(r => setTimeout(r, 2000));
      hideModal('modalDetail');
      await startOdoo(name);
      showToastMessage(t('toast.configRestarted'), 'success');
    } else {
      hideModal('modalDetail');
      showToastMessage(t('toast.configSaved'), 'success');
      refreshStatus();
    }
  } catch (e) {
    showToastMessage(t('toast.error', { msg: e.message }), 'error');
  }
}

// ---------------------------------------------------------------------------
// Auto-Update — auto download + auto restart
// ---------------------------------------------------------------------------

let _manualCheckResolve = null;

async function checkForUpdate() {
  const el = $('navVersion');
  const original = el.textContent;
  el.textContent = t('update.checking');
  try {
    // Reset periodic interval so it doesn't overlap
    await api('update-reset-interval');
    // Create a promise that resolves when update-status event arrives
    const result = await new Promise((resolve) => {
      _manualCheckResolve = resolve;
      api('update-check');
      // Timeout after 15s if no response
      setTimeout(() => resolve({ status: 'timeout' }), 15000);
    });
    _manualCheckResolve = null;

    if (result.status === 'available') {
      el.textContent = original + ' \u2192 v' + result.version;
      // showUpdateCard is already called by the event listener
    } else if (result.status === 'up-to-date') {
      el.textContent = original + ' (latest)';
      showToastMessage(t('toast.latestVersion'), 'success');
      setTimeout(() => { el.textContent = original; }, 3000);
    } else {
      el.textContent = original;
      showToastMessage(t('toast.cannotCheck'), 'error');
      setTimeout(() => { el.textContent = original; }, 3000);
    }
  } catch {
    el.textContent = original;
  }
}

function showUpdateCard(version) {
  const toast = $('updateToast');
  $('updateTitle').textContent = t('update.title');
  $('updateVersion').textContent = 'v' + version;
  $('updateDesc').textContent = t('update.readyDownload');
  $('updateActions').style.display = 'flex';
  $('updateProgressWrap').style.display = 'none';
  $('updateFill').style.width = '0%';
  $('updatePct').textContent = '0%';
  $('updateSpinner').classList.remove('hidden');
  $('btnUpdateDownload').disabled = false;
  $('btnUpdateDownload').textContent = t('update.downloadNow');
  toast.style.animation = 'none';
  toast.classList.add('visible');
  requestAnimationFrame(() => { toast.style.animation = ''; });
}

function startUpdateDownload() {
  $('btnUpdateDownload').disabled = true;
  $('btnUpdateDownload').textContent = t('update.downloading');
  $('updateDesc').textContent = t('update.downloadingUpdate');
  $('updateActions').style.display = 'none';
  $('updateProgressWrap').style.display = '';
  api('update-download');
}

function dismissUpdate() {
  $('updateToast').classList.remove('visible');
}

function updateProgress(pct) {
  $('updateFill').style.width = pct + '%';
  $('updatePct').textContent = pct + '%';
}

function updateReady(version) {
  $('updateDesc').textContent = t('update.downloadComplete');
  $('updateActions').style.display = 'none';
  $('updateProgressWrap').style.display = '';
  $('updateFill').style.width = '100%';
  $('updatePct').textContent = '100%';
  $('updateSpinner').classList.add('hidden');
  setTimeout(() => api('update-install'), 1500);
}

// Listen for update events from main process
if (window.electronAPI) {
  window.electronAPI.onEvent('update-status', (data) => {
    // Resolve manual check promise if waiting
    if (_manualCheckResolve && (data.status === 'available' || data.status === 'up-to-date' || data.status === 'error')) {
      _manualCheckResolve(data);
    }

    switch (data.status) {
      case 'available':
        showUpdateCard(data.version);
        break;

      case 'downloading':
        $('updateProgressWrap').style.display = '';
        $('updateActions').style.display = 'none';
        updateProgress(data.percent || 0);
        break;

      case 'ready':
        updateReady(data.version);
        break;

      case 'error':
        console.log('Update check:', data.message);
        break;
    }
  });
}

// ---------------------------------------------------------------------------
// Theme System: Mode (dark/light) + Preset (default/autonsi/cyberpunk/luxury)
// ---------------------------------------------------------------------------

/** Toggle dark/light mode with View Transition API circle reveal */
function toggleMode() {
  const current = document.documentElement.getAttribute('data-mode') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  const btn = $('themeToggle');

  // Fallback if View Transition API not available
  if (!document.startViewTransition || !btn) {
    applyMode(next);
    localStorage.setItem('mode', next);
    return;
  }

  // Get button center for circle origin
  const rect = btn.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const maxR = Math.hypot(
    Math.max(cx, window.innerWidth - cx),
    Math.max(cy, window.innerHeight - cy)
  );

  // Store origin for CSS to use
  document.documentElement.style.setProperty('--vt-cx', cx + 'px');
  document.documentElement.style.setProperty('--vt-cy', cy + 'px');
  document.documentElement.style.setProperty('--vt-r', maxR + 'px');

  // Mark direction for CSS z-index control
  const dirClass = next === 'dark' ? 'vt-going-dark' : 'vt-going-light';
  document.documentElement.classList.add(dirClass);

  const transition = document.startViewTransition(() => {
    applyMode(next);
    localStorage.setItem('mode', next);
  });

  // Cleanup classes + CSS vars when done (or on error)
  const cleanup = () => {
    document.documentElement.classList.remove('vt-going-dark', 'vt-going-light');
    document.documentElement.style.removeProperty('--vt-cx');
    document.documentElement.style.removeProperty('--vt-cy');
    document.documentElement.style.removeProperty('--vt-r');
  };
  transition.finished.then(cleanup).catch(cleanup);
}

/** Apply dark/light mode (no animation) */
function applyMode(mode) {
  const iconDark = $('themeIconDark');
  const iconLight = $('themeIconLight');
  if (mode === 'light') {
    document.documentElement.setAttribute('data-mode', 'light');
    if (iconDark) iconDark.style.display = 'none';
    if (iconLight) iconLight.style.display = 'block';
  } else {
    document.documentElement.removeAttribute('data-mode');
    if (iconDark) iconDark.style.display = 'block';
    if (iconLight) iconLight.style.display = 'none';
  }
  syncTitlebarAccent();
}

/** Apply a theme preset */
function applyPreset(preset) {
  // Clear custom colors when switching preset
  localStorage.removeItem('customColors');
  document.documentElement.style.cssText = '';

  if (preset && preset !== 'default') {
    document.documentElement.setAttribute('data-preset', preset);
  } else {
    document.documentElement.removeAttribute('data-preset');
  }
  localStorage.setItem('preset', preset || 'default');

  // Update preset card active state
  document.querySelectorAll('.preset-card').forEach(card => {
    card.classList.toggle('active', card.getAttribute('data-preset') === (preset || 'default'));
  });

  syncTitlebarAccent();
  syncColorPickers();
}

/** Sync titlebar SVG stroke to current accent color */
function syncTitlebarAccent() {
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const svg = $('titlebarSvg');
  if (svg) svg.setAttribute('stroke', accent);
}

// Legacy compat: applyTheme maps to mode for old localStorage
function applyTheme(theme) {
  if (theme === 'autonsi') {
    applyPreset('autonsi');
    applyMode('dark');
  } else {
    applyMode(theme);
  }
}

// Load saved mode + preset on startup
(function() {
  // Migrate old 'theme' key
  const oldTheme = localStorage.getItem('theme');
  if (oldTheme) {
    if (oldTheme === 'autonsi') {
      localStorage.setItem('preset', 'autonsi');
      localStorage.setItem('mode', 'dark');
    } else {
      localStorage.setItem('mode', oldTheme);
    }
    localStorage.removeItem('theme');
  }

  const mode = localStorage.getItem('mode') || 'dark';
  const preset = localStorage.getItem('preset') || 'default';
  applyMode(mode);
  // Apply preset attribute (without clearing custom colors on load)
  if (preset && preset !== 'default') {
    document.documentElement.setAttribute('data-preset', preset);
  }
  // Mark active preset card
  setTimeout(() => {
    document.querySelectorAll('.preset-card').forEach(card => {
      card.classList.toggle('active', card.getAttribute('data-preset') === preset);
    });
  }, 0);
})();

// --- Settings Modal ---
function openSettingsModal() {
  // Sync preset cards
  const preset = localStorage.getItem('preset') || 'default';
  document.querySelectorAll('.preset-card').forEach(card => {
    card.classList.toggle('active', card.getAttribute('data-preset') === preset);
  });
  syncColorPickers();
  loadIconPreview();
  $('settingsModal').classList.add('visible');
}

// --- Custom Colors ---
function applyCustomColor(varName, value) {
  document.documentElement.style.setProperty(varName, value);
  const custom = JSON.parse(localStorage.getItem('customColors') || '{}');
  custom[varName] = value;
  localStorage.setItem('customColors', JSON.stringify(custom));
  if (varName === '--accent') {
    const svg = $('titlebarSvg');
    if (svg) svg.setAttribute('stroke', value);
  }
}

function syncColorPickers() {
  const style = getComputedStyle(document.documentElement);
  const pick = (id, v) => { const el = $(id); if (el) el.value = rgbToHex(style.getPropertyValue(v).trim()); };
  pick('colorAccent', '--accent');
  pick('colorBg', '--bg-canvas');
  pick('colorSurface', '--bg-surface');
  pick('colorText', '--text-primary');
}

function rgbToHex(color) {
  if (color.startsWith('#')) return color.length === 4
    ? '#' + color[1]+color[1]+color[2]+color[2]+color[3]+color[3]
    : color;
  const m = color.match(/(\d+)/g);
  if (!m) return '#000000';
  return '#' + m.slice(0,3).map(n => parseInt(n).toString(16).padStart(2,'0')).join('');
}

function resetCustomColors() {
  localStorage.removeItem('customColors');
  document.documentElement.style.cssText = '';
  // Re-apply current mode + preset
  applyMode(localStorage.getItem('mode') || 'dark');
  const preset = localStorage.getItem('preset') || 'default';
  if (preset !== 'default') document.documentElement.setAttribute('data-preset', preset);
  syncColorPickers();
  showToast('Colors reset to theme defaults', 'success');
}

// Restore custom colors on load
(function() {
  const custom = JSON.parse(localStorage.getItem('customColors') || '{}');
  for (const [k, v] of Object.entries(custom)) {
    document.documentElement.style.setProperty(k, v);
  }
})();

// --- Icon ---
/** Update titlebar icon: show custom image or default SVG */
function syncTitlebarIcon(dataUrl, isCustom) {
  const img = $('titlebarIcon');
  const svg = $('titlebarSvg');
  if (isCustom && dataUrl) {
    img.src = dataUrl;
    img.style.display = 'block';
    svg.style.display = 'none';
  } else {
    img.style.display = 'none';
    svg.style.display = 'block';
  }
}

async function loadIconPreview() {
  try {
    const res = await window.electronAPI.invoke('get-icon');
    if (res.ok) {
      $('iconPreview').src = res.dataUrl;
      if (res.path) $('iconPath').textContent = res.path;
      syncTitlebarIcon(res.dataUrl, res.isCustom);
    } else {
      syncTitlebarIcon(null, false);
    }
  } catch { syncTitlebarIcon(null, false); }
}
loadIconPreview();

async function pickIcon() {
  try {
    const res = await window.electronAPI.invoke('pick-icon');
    if (res.ok) {
      $('iconPreview').src = res.dataUrl;
      $('iconPath').textContent = 'Custom: ' + res.fileName;
      syncTitlebarIcon(res.dataUrl, true);
      showToast('Icon applied!', 'success');
    }
  } catch (e) {
    showToast('Failed to upload icon: ' + e, 'error');
  }
}

async function resetIcon() {
  try {
    await window.electronAPI.invoke('reset-icon');
    await loadIconPreview();
    showToast('Icon reset to default', 'success');
  } catch (e) {
    showToast('Failed to reset icon: ' + e, 'error');
  }
}

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

refreshStatus();

// ---------------------------------------------------------------------------
// Help Panel — Documentation + Troubleshooting
// ---------------------------------------------------------------------------

const DOC_ICONS = {
  rocket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 3 0 3 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-3 0-3"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><polygon points="5,3 19,12 5,21 5,3"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><polyline points="16,18 22,12 16,6"/><polyline points="8,6 2,12 8,18"/></svg>',
  database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><polygon points="23,7 16,12 23,17 23,7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>',
};

let _helpRendered = false;
let _expandedDocId = null;

function renderHelpPanel() {
  if (_helpRendered) return;
  _helpRendered = true;
  renderDocs();
  renderTourSteps();
  renderTroubleshooting();
}

function renderTourSteps() {
  const container = $('helpTour');
  if (!container || typeof TOUR_STEPS === 'undefined') return;
  container.innerHTML = `
    <p class="desc" style="margin-bottom:14px">${t('help.tourStepsDesc')}</p>
    <div style="margin-bottom:12px">
      <button class="btn btn-primary btn-sm" onclick="startTour()">${t('help.startFullTour')}</button>
    </div>
    ${TOUR_STEPS.map((step, i) => `
      <div class="tour-step-item" onclick="startTourAtStep(${i})" style="display:flex;align-items:center;gap:12px;padding:10px 14px;margin-bottom:6px;background:var(--bg-surface);border:1px solid var(--border-muted);border-radius:8px;cursor:pointer;transition:border-color 0.15s"
        onmouseenter="this.style.borderColor='var(--accent)'" onmouseleave="this.style.borderColor='var(--border-muted)'">
        <span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:var(--accent);color:#fff;font-size:0.78rem;font-weight:600;flex-shrink:0">${i + 1}</span>
        <div>
          <div style="font-size:0.88rem;font-weight:600;color:var(--text-primary)">${escHtml(step.title)}</div>
          <div style="font-size:0.75rem;color:var(--text-secondary);margin-top:2px">${escHtml(step.text).substring(0, 100)}${step.text.length > 100 ? '...' : ''}</div>
        </div>
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" stroke-width="2" width="16" height="16" style="margin-left:auto;flex-shrink:0"><polyline points="9,18 15,12 9,6"/></svg>
      </div>
    `).join('')}
  `;
}

function renderDocs(filter) {
  const container = $('helpDocs');
  let entries = typeof DOCS_ENTRIES !== 'undefined' ? DOCS_ENTRIES : [];
  if (filter) {
    const q = filter.toLowerCase();
    entries = entries.filter(e =>
      e.title.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.category.toLowerCase().includes(q)
    );
  }

  // Group by category
  const groups = {};
  for (const e of entries) {
    if (!groups[e.category]) groups[e.category] = [];
    groups[e.category].push(e);
  }

  if (entries.length === 0) {
    container.innerHTML = '<div class="help-empty">' + t('help.noDocs') + '</div>';
    return;
  }

  let html = '';
  for (const [cat, items] of Object.entries(groups)) {
    html += `<div class="doc-category-title">${escHtml(cat)}</div>`;
    html += '<div class="doc-grid">';
    for (const item of items) {
      html += `
        <div class="doc-card" onclick="expandDocCard('${item.id}')">
          <div class="doc-card-header">
            <div class="doc-card-icon">${DOC_ICONS[item.icon] || DOC_ICONS.folder}</div>
            <div class="doc-card-title">${escHtml(item.title)}</div>
          </div>
          <div class="doc-card-desc">${escHtml(item.description)}</div>
        </div>`;
    }
    html += '</div>';
  }
  container.innerHTML = html;
}

function expandDocCard(id) {
  const entry = DOCS_ENTRIES.find(e => e.id === id);
  if (!entry) return;

  // Toggle if already expanded
  if (_expandedDocId === id) {
    _expandedDocId = null;
    renderDocs($('helpSearch')?.value || '');
    return;
  }
  _expandedDocId = id;

  const container = $('helpDocs');
  let videoHtml = '';
  if (entry.videoUrl) {
    videoHtml = `<div class="doc-video-wrap"><iframe src="${escHtml(entry.videoUrl)}" loading="lazy" allowfullscreen></iframe></div>`;
  }

  container.innerHTML = `
    <div class="doc-expanded">
      <div class="doc-expanded-header">
        <div class="doc-expanded-title">${escHtml(entry.title)}</div>
        <button class="btn btn-outline btn-xs" onclick="expandDocCard('${id}')">${t('help.close')}</button>
      </div>
      <div class="doc-expanded-body">${entry.body || ''}${videoHtml}</div>
    </div>
  `;
}

function renderTroubleshooting(filter) {
  const container = $('helpTroubleshoot');
  let entries = typeof TROUBLESHOOT_ENTRIES !== 'undefined' ? TROUBLESHOOT_ENTRIES : [];
  if (filter) {
    const q = filter.toLowerCase();
    entries = entries.filter(e =>
      e.title.toLowerCase().includes(q) ||
      e.tags.some(t => t.toLowerCase().includes(q)) ||
      e.symptom.toLowerCase().includes(q) ||
      e.solution.toLowerCase().includes(q)
    );
  }

  if (entries.length === 0) {
    container.innerHTML = '<div class="help-empty">' + t('help.noIssues') + '</div>';
    return;
  }

  container.innerHTML = entries.map(e => `
    <div class="troubleshoot-item" id="ts-${e.id}">
      <div class="troubleshoot-header" onclick="toggleTroubleshootItem('${e.id}')">
        <span class="troubleshoot-arrow">&#9654;</span>
        <span class="troubleshoot-title">${escHtml(e.title)}</span>
        <div class="troubleshoot-tags">${e.tags.slice(0, 3).map(tag => `<span class="troubleshoot-tag">${escHtml(tag)}</span>`).join('')}</div>
      </div>
      <div class="troubleshoot-body">
        <div class="troubleshoot-label">${t('help.symptom')}</div>
        <p>${e.symptom}</p>
        <div class="troubleshoot-label">${t('help.cause')}</div>
        <p>${e.cause}</p>
        <div class="troubleshoot-label">${t('help.solution')}</div>
        <p>${e.solution}</p>
      </div>
    </div>
  `).join('');
}

function toggleTroubleshootItem(id) {
  const el = document.getElementById('ts-' + id);
  if (el) el.classList.toggle('open');
}

function showHelpTab(tab, el) {
  document.querySelectorAll('.help-tab').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  $('helpDocs').style.display = tab === 'docs' ? '' : 'none';
  $('helpTour').style.display = tab === 'tour' ? '' : 'none';
  $('helpTroubleshoot').style.display = tab === 'troubleshoot' ? '' : 'none';
}

function filterHelpContent() {
  const q = ($('helpSearch')?.value || '').trim();
  _expandedDocId = null;
  renderDocs(q);
  renderTroubleshooting(q);
}

// Auto-refresh status every 10 seconds (real-time running/stopped sync)
setInterval(() => refreshStatus(), 10000);

// Load app version + saved settings + default paths
if (window.electronAPI) {
  api('app-version').then(v => {
    const ver = 'v' + v;
    const el = document.querySelector('.nav-version');
    if (el) el.textContent = ver;
    if ($('settingsVersion')) $('settingsVersion').textContent = ver;
  });
  // Restore saved settings first, then fill empty fields with defaults
  loadSettingsFromDisk().then(() => {
    api('default-paths', { odoo_version: $('odooVersion')?.value || '17' }).then(paths => {
      if ($('baseDir') && !$('baseDir').value) $('baseDir').value = paths.base_dir || '';
      if ($('projectsDir') && !$('projectsDir').value) $('projectsDir').value = paths.projects_dir || '';
    });
  });
}

// First-launch tour prompt
try {
  if (!localStorage.getItem('tour_completed')) {
    setTimeout(() => {
      showToastMessage(t('toast.welcome'), 'info');
    }, 5000);
  }
} catch {}

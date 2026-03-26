// ---------------------------------------------------------------------------
// Odoo 17 Installer - Renderer Script
// Communicates with main process via IPC (window.electronAPI)
// ---------------------------------------------------------------------------

const $ = id => document.getElementById(id);
let _status = null;

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function showPanel(name, el) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(m => m.classList.remove('active'));
  $('panel-' + name).classList.add('active');
  if (el) el.classList.add('active');
  if (name === 'dashboard' || name === 'status' || name === 'projects') refreshStatus();
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
function hideModal(id) { $(id).classList.remove('visible'); }

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
// Status
// ---------------------------------------------------------------------------
async function refreshStatus() {
  const data = getFormData();
  const s = await api('status', data);
  _status = s;

  // Status grid
  const items = [
    ['Python 3.11', s.python311, s.python311_path],
    ['PostgreSQL', s.postgres, s.postgres_path],
    ['Docker', s.docker, s.docker ? 'Available' : 'Not found'],
    ['Odoo Source', s.odoo_cloned, ''],
    ['Virtual Env', s.venv_created, ''],
    ['Requirements', s.requirements_installed, ''],
    ['VS Code', s.vscode, s.vscode_version || ''],
  ];
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

  // Projects list + Dashboard
  renderProjects(s);
  renderDashboard(s);
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
          <span class="tag tag-port" onclick="openBrowser('${escAttr(p.http_port)}')" style="cursor:pointer" title="Open in browser">:${escHtml(p.http_port)}</span>
          <span class="tag tag-ready">ready</span>
          <span class="project-url" onclick="openBrowser('${escAttr(p.http_port)}')" title="Click to open">http://localhost:${escHtml(p.http_port)}</span></div>
        <div style="font-size:0.75rem;color:var(--text-tertiary)">${escHtml(p.path)}</div>
      </div>
      <div class="project-detail-grid">
        ${details.map(([l, v]) => `<div class="detail-item"><div class="detail-label">${l}</div><div class="detail-value">${escHtml(v)}</div></div>`).join('')}
        ${p.addon_dirs && p.addon_dirs.length ? p.addon_dirs.map(a => `<div class="detail-item"><div class="detail-label">${a.is_base ? 'Base Addons' : 'Custom Addons'}</div><div class="detail-value">${escHtml(a.path)} (${a.count} modules)</div></div>`).join('') : ''}
        ${p.data_dir ? `<div class="detail-item"><div class="detail-label">Data Dir</div><div class="detail-value">${escHtml(p.data_dir)}</div></div>` : ''}
      </div>
      <div class="cmd-box" onclick="copyCmd(this)" title="Click to copy">
        <span>${escHtml(p.start_command)}</span>
        <span class="copy-hint">click to copy</span>
      </div>
      <div class="project-actions">
        <button class="btn btn-success btn-xs" onclick="startOdoo('${escAttr(p.name)}')">Start Odoo</button>
        <button class="btn btn-outline btn-xs" onclick="openBrowser('${escAttr(p.http_port)}')">Open Browser</button>
        <button class="btn btn-outline btn-xs" onclick="openVSCode('${escAttr(p.path)}')">VS Code</button>
        <button class="btn btn-outline btn-xs" onclick="openExplorer('${escAttr(p.path)}')">Explorer</button>
        <button class="btn btn-outline btn-xs" onclick="editConfig('${escAttr(p.name)}')">Edit Config</button>
        <button class="btn btn-outline btn-xs" onclick="duplicateProject('${escAttr(p.name)}','${escAttr(p.http_port)}')">Duplicate</button>
        <button class="btn btn-danger btn-xs" onclick="deleteProject('${escAttr(p.name)}')">Delete</button>
      </div>
    </div>`;
  }).join('');
}

function copyCmd(el) {
  const text = el.querySelector('span').textContent;
  navigator.clipboard.writeText(text).then(() => {
    const hint = el.querySelector('.copy-hint');
    hint.textContent = 'copied!';
    setTimeout(() => hint.textContent = 'click to copy', 1500);
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
    const el = $('log');
    if (el) {
      el.innerHTML += `<div class="line">${escHtml(line)}</div>`;
      el.scrollTop = el.scrollHeight;
    }
  });

  window.electronAPI.onTaskProgress((task) => {
    if (task.status === 'running') {
      $('progressWrap').classList.add('visible');
      $('progressFill').style.width = task.progress + '%';
      $('progressStep').textContent = task.step;
      $('progressPct').textContent = task.progress + '%';
    } else if (task.status === 'done') {
      $('progressFill').style.width = '100%';
      $('progressStep').textContent = 'Done!';
      $('progressPct').textContent = '100%';
    }
  });
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------
async function fullInstall() {
  const btn = $('btnFullInstall');
  btn.disabled = true;
  btn.textContent = 'Installing...';
  $('results').innerHTML = '';
  startLogPoll();
  const res = await api('full_install', getFormData());
  btn.disabled = false;
  btn.textContent = 'Install Everything';
  stopLogPoll();
  $('progressFill').style.width = '100%';
  $('progressStep').textContent = 'Done!';
  $('progressPct').textContent = '100%';
  if (res.results) {
    $('results').innerHTML = res.results.map(r => `
      <div class="result-item" style="display:flex;align-items:center;gap:8px;padding:8px 0;font-size:0.9rem;border-bottom:1px solid #1e1e1e">
        <span style="font-size:1.1rem">${r.ok ? '\u2705' : '\u274C'}</span><span>${escHtml(r.step)}</span>
        <span style="color:#666;font-size:0.8rem;margin-left:auto">${escHtml(r.msg)}</span>
      </div>`).join('');
  }
  refreshStatus();
}

async function runStep(step) {
  startLogPoll();
  const res = await api('run_step', { ...getFormData(), step });
  stopLogPoll();
  refreshStatus();
  alert(res.ok ? '\u2705 ' + res.msg : '\u274C ' + res.msg);
}

// ---------------------------------------------------------------------------
// Create Project
// ---------------------------------------------------------------------------
async function createProject() {
  const name = $('newProjName').value.trim();
  if (!name) { alert('Enter a project name'); return; }
  startLogPoll();
  const data = getFormData();
  data.project_name = name;
  data.http_port = $('newProjPort').value;
  data.db_host = $('newProjDbHost').value;
  data.db_port = $('newProjDbPort').value;
  data.db_user = $('newProjDbUser').value;
  data.db_password = $('newProjDbPass').value;
  data.log_level = $('newLogLevel').value;
  data.workers = $('newWorkers').value;
  data.dbfilter = $('newDbfilter').value;
  data.proxy_mode = $('newProxyMode').value;
  const res = await api('create_project', data);
  stopLogPoll();
  refreshStatus();
  alert(res.ok ? '\u2705 Project created!\n' + res.msg : '\u274C ' + res.msg);
}

// ---------------------------------------------------------------------------
// Project Actions
// ---------------------------------------------------------------------------
async function startOdoo(name) {
  const data = getFormData();
  data.project_name = name;
  const res = await api('start_odoo', data);
  if (res.ok) alert('\u2705 Odoo started!\nCommand: ' + res.command);
  else alert('\u274C ' + res.msg);
}

async function openVSCode(path) { await api('open_vscode', { path }); }
async function openExplorer(path) { await api('open_explorer', { path }); }
async function openBrowser(port) { await api('open_browser', { url: `http://localhost:${port}` }); }

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
  if ($('deleteConfirmInput').value !== _deletingProject) { alert('Name does not match!'); return; }
  const data = getFormData();
  const res = await api('delete_project', { projects_dir: data.projects_dir, project_name: _deletingProject });
  hideModal('modalDelete');
  refreshStatus();
  alert(res.ok ? '\u2705 Deleted!' : '\u274C ' + res.msg);
}

let _dupSource = '';
function duplicateProject(name, port) {
  _dupSource = name;
  $('dupSourceName').textContent = name;
  $('dupNewName').value = name + '_copy';
  $('dupNewPort').value = String(Number(port) + 1);
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
        <span class="kanban-card-port" onclick="openBrowser('${escAttr(p.http_port || '8069')}')" title="Open in browser" style="cursor:pointer">:${escHtml(p.http_port || '8069')}</span>
      </div>
      <div class="kanban-card-url" onclick="openBrowser('${escAttr(p.http_port || '8069')}')" title="Click to open">http://localhost:${escHtml(p.http_port || '8069')}</div>
      <div class="kanban-card-body">
        <div class="kanban-card-meta">
          <div class="kanban-meta-item">
            <span class="kanban-meta-label">Database</span>
            <span class="kanban-meta-value">${escHtml(p.db_host || 'localhost')}:${escHtml(p.db_port || '5432')}</span>
          </div>
          <div class="kanban-meta-item">
            <span class="kanban-meta-label">DB User</span>
            <span class="kanban-meta-value">${escHtml(p.db_user || 'odoo')}</span>
          </div>
          <div class="kanban-meta-item">
            <span class="kanban-meta-label">Workers</span>
            <span class="kanban-meta-value">${escHtml(p.workers || '0')}</span>
          </div>
          <div class="kanban-meta-item">
            <span class="kanban-meta-label">Log Level</span>
            <span class="kanban-meta-value">${escHtml(p.log_level || 'error')}</span>
          </div>
        </div>
        <div class="kanban-card-tags">
          <span class="kanban-tag kanban-tag-ready">ready</span>
          ${p.custom_modules > 0 ? `<span class="kanban-tag kanban-tag-modules">${p.custom_modules} modules</span>` : ''}
        </div>
      </div>
      <div class="kanban-card-actions">
        <button class="btn btn-success btn-xs" onclick="startOdoo('${escAttr(p.name)}')">Start</button>
        <button class="btn btn-outline btn-xs" onclick="openBrowser('${escAttr(p.http_port)}')">Browser</button>
        <button class="btn btn-outline btn-xs" onclick="openVSCode('${escAttr(p.path)}')">VS Code</button>
        <button class="btn btn-outline btn-xs" onclick="openExplorer('${escAttr(p.path)}')">Explorer</button>
        <button class="btn btn-outline btn-xs" onclick="showProjectDetail('${escAttr(p.name)}')">Detail</button>
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

  $('detailTitle').textContent = p.name;

  const details = [
    ['HTTP Port', p.http_port],
    ['Longpolling', p.longpolling_port],
    ['DB Host', p.db_host || 'localhost'],
    ['DB Port', p.db_port || '5432'],
    ['DB User', p.db_user],
    ['Workers', p.workers],
    ['Log Level', p.log_level],
    ['Custom Modules', p.custom_modules],
    ['List DB', p.list_db],
    ['DB Filter', p.dbfilter],
    ['Proxy Mode', p.proxy_mode],
    ['Server Modules', p.server_wide_modules],
    ['Data Dir', p.data_dir],
    ['Path', p.path],
  ].filter(([, v]) => v !== '' && v !== undefined && v !== null);

  $('detailContent').innerHTML = `
    <div class="detail-grid">
      ${details.map(([l, v]) => `
        <div class="detail-item">
          <div class="detail-label">${l}</div>
          <div class="detail-value">${escHtml(v)}</div>
        </div>
      `).join('')}
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
      <span class="copy-hint">click to copy</span>
    </div>
    <div class="btn-row">
      <button class="btn btn-success btn-sm" onclick="startOdoo('${escAttr(p.name)}');hideModal('modalDetail')">Start Odoo</button>
      <button class="btn btn-outline btn-sm" onclick="openBrowser('${escAttr(p.http_port)}')">Open Browser</button>
      <button class="btn btn-outline btn-sm" onclick="openVSCode('${escAttr(p.path)}')">VS Code</button>
      <button class="btn btn-outline btn-sm" onclick="openExplorer('${escAttr(p.path)}')">Explorer</button>
      <button class="btn btn-outline btn-sm" onclick="hideModal('modalDetail');editConfig('${escAttr(p.name)}')">Edit Config</button>
      <button class="btn btn-outline btn-sm" onclick="hideModal('modalDetail');duplicateProject('${escAttr(p.name)}','${escAttr(p.http_port)}')">Duplicate</button>
      <button class="btn btn-danger btn-sm" onclick="hideModal('modalDetail');deleteProject('${escAttr(p.name)}')">Delete</button>
    </div>
  `;

  showModal('modalDetail');
}

// ---------------------------------------------------------------------------
// Auto-Update
// ---------------------------------------------------------------------------
let _updateState = 'idle'; // idle, available, downloading, ready

function showUpdateToast(title, desc, btnText, state) {
  const toast = $('updateToast');
  $('updateTitle').textContent = title;
  $('updateDesc').textContent = desc;
  $('updateBtn').textContent = btnText;
  _updateState = state;

  toast.className = 'update-toast visible';
  if (state === 'downloading') toast.classList.add('downloading');
  if (state === 'ready') toast.classList.add('ready');

  $('updateBtn').className = 'update-toast-btn';
  if (state === 'downloading') $('updateBtn').classList.add('downloading');
}

function dismissUpdate() {
  $('updateToast').classList.remove('visible');
}

function handleUpdateAction() {
  if (_updateState === 'available') {
    // Start download
    api('update-download');
    showUpdateToast('Downloading...', 'Please wait', 'Downloading...', 'downloading');
    $('updateBtn').disabled = true;
  } else if (_updateState === 'ready') {
    // Install and restart
    api('update-install');
  }
}

// Listen for update events from main process
if (window.electronAPI) {
  window.electronAPI.onEvent('update-status', (data) => {
    switch (data.status) {
      case 'available':
        showUpdateToast(
          'Update Available',
          `Version ${data.version} is ready to download`,
          'Update Now',
          'available'
        );
        break;

      case 'downloading':
        showUpdateToast(
          'Downloading Update...',
          `${data.percent || 0}% complete`,
          `${data.percent || 0}%`,
          'downloading'
        );
        $('updateBtn').disabled = true;
        break;

      case 'ready':
        showUpdateToast(
          'Update Ready',
          `Version ${data.version} downloaded. Restart to apply.`,
          'Restart Now',
          'ready'
        );
        $('updateBtn').disabled = false;
        break;

      case 'error':
        // Silently ignore update errors (network issues, etc.)
        console.log('Update check:', data.message);
        break;
    }
  });
}

// ---------------------------------------------------------------------------
// Theme Toggle
// ---------------------------------------------------------------------------
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'light' ? 'dark' : 'light';
  applyTheme(next);
  localStorage.setItem('theme', next);
}

function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    $('themeIconDark').style.display = 'none';
    $('themeIconLight').style.display = 'block';
  } else {
    document.documentElement.removeAttribute('data-theme');
    $('themeIconDark').style.display = 'block';
    $('themeIconLight').style.display = 'none';
  }
  // Update titlebar brand SVG stroke color
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  document.querySelectorAll('.titlebar-brand svg').forEach(svg => svg.setAttribute('stroke', accent));
}

// Load saved theme
(function() {
  const saved = localStorage.getItem('theme') || 'dark';
  applyTheme(saved);
})();

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
refreshStatus();

// Load app version into nav
if (window.electronAPI) {
  api('app-version').then(v => {
    const el = document.querySelector('.nav-version');
    if (el) el.textContent = 'v' + v;
  });
}

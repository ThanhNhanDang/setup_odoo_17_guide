// Dashboard
// ---------------------------------------------------------------------------
const LOGO_PLACEHOLDER = 'images/placeholder.png';
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

  const _ok = `<span style="color:#3fb950">${t('status.ok')}</span>`;
  const _miss = `<span style="color:#f85149">${t('status.missing')}</span>`;
  $('dashStats').innerHTML = `
    <div class="dash-stat accent">
      <div class="dash-stat-value">${totalProjects}</div>
      <div class="dash-stat-label">${t('dashboard.totalProjects')}</div>
    </div>
    <div class="dash-stat green">
      <div class="dash-stat-value">${totalModules}</div>
      <div class="dash-stat-label">${t('dashboard.customModules')}</div>
    </div>
    <div class="dash-stat blue">
      <div class="dash-stat-value">${uniquePorts}</div>
      <div class="dash-stat-label">${t('dashboard.dbConnections')}</div>
    </div>
    <div class="dash-stat">
      <div class="dash-stat-value">${s.python311 ? _ok : _miss}</div>
      <div class="dash-stat-label">${t('dashboard.python')}</div>
    </div>
    <div class="dash-stat">
      <div class="dash-stat-value">${s.postgres ? (typeof _pgNeedsVector === 'function' && _pgNeedsVector() && !s.pgvector_available ? '<span style="color:#d29922">' + t('install.pgvectorMissing') + '</span>' : _ok) : _miss}</div>
      <div class="dash-stat-label">${t('dashboard.postgresql')}</div>
    </div>
    <div class="dash-stat">
      <div class="dash-stat-value">${s.vscode ? '<span style="color:#3fb950">' + escHtml(s.vscode_version || t('status.ok')) + '</span>' : _miss}</div>
      <div class="dash-stat-label">VS Code</div>
    </div>
  `;

  // Kanban cards
  renderKanban(projects);
}

/**
 * Render a single kanban card HTML.
 * @param {object} p - project data
 * @param {boolean} isDemo - if true, card is a non-interactive demo for tour
 */
function renderKanbanCard(p, isDemo) {
  const demoClass = isDemo ? ' kanban-card-demo' : '';
  const demoLabel = isDemo ? `<span class="kanban-tag" style="background:var(--text-tertiary);color:var(--bg-surface);font-size:0.65rem">${t('dashboard.sample')}</span>` : '';
  const versionColor = getVersionColor(p.odoo_version);
  const versionKey = p.odoo_version || '17';

  // For demo cards, disable all onclick handlers
  const onclick = (fn) => isDemo ? '' : `onclick="${fn}"`;
  const btnDisabled = isDemo ? ' disabled' : '';

  const statusTag = isDemo
    ? `<span class="kanban-tag kanban-tag-stopped">${t('project.stoppedTag')}</span>`
    : _pendingProjects.has(p.name)
      ? `<span class="kanban-tag kanban-tag-pending"><span class="spinner-sm"></span></span>`
      : p.is_running
        ? `<span class="kanban-tag kanban-tag-running">${t('project.runningTag')}</span>`
        : `<span class="kanban-tag kanban-tag-stopped">${t('project.stoppedTag')}</span>`;

  const actionBtn = isDemo
    ? `<button class="kanban-icon-btn kanban-action-btn btn-start-icon"${btnDisabled} title="${t('project.start')}"><svg viewBox="0 0 24 24" fill="currentColor" width="26" height="26"><polygon points="6,4 20,12 6,20"/></svg></button>`
    : renderActionBtn(p);

  const logoSrc = p.logo || LOGO_PLACEHOLDER;

  return `
    <div class="kanban-card${demoClass}">
      <div class="kanban-card-banner" data-tour="card-header">
        <img class="kanban-card-banner-img" src="${escAttr(logoSrc)}" alt="" onerror="this.src='${LOGO_PLACEHOLDER}'">
        <div class="kanban-card-banner-overlay">
          <span class="kanban-card-name">${escHtml(p.name)} ${demoLabel}</span>
        </div>
        <div class="kanban-card-banner-actions">
          <span class="kanban-card-port" ${onclick(`openProjectUrl('${escAttr(p.domain)}','${escAttr(p.http_port || '8069')}')`)} title="Open in browser" style="cursor:pointer">:${escHtml(p.http_port || '8069')}</span>
          <button class="kanban-icon-btn" ${onclick(`duplicateProject('${escAttr(p.name)}','${escAttr(p.http_port)}')`)} title="${t('project.duplicate')}"${btnDisabled}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>
        </div>
      </div>
      <div class="kanban-card-url" ${onclick(`openProjectUrl('${escAttr(p.domain)}','${escAttr(p.http_port || '8069')}')`)} title="Click to open">${escHtml(getProjectUrl(p.domain, p.http_port || '8069'))}</div>
      <div class="kanban-card-body">
        <div class="kanban-card-tags" data-tour="card-tags">
          <span class="kanban-tag kanban-tag-version" style="background:${versionColor};color:#fff">v${escHtml(versionKey)}</span>
          ${statusTag}
          ${p.custom_modules > 0 ? `<span class="kanban-tag kanban-tag-modules">${p.custom_modules} modules</span>` : ''}
        </div>
        <button class="kanban-log-btn" data-tour="card-monitor" ${onclick(`openLogWindow('${escAttr(p.name)}','${escAttr(p.logfile || (p.path + '\\\\odoo.log'))}',event,'${escAttr(p.http_port || '8069')}','${escAttr(p.domain || '')}')`)} title="${t('project.monitor')}"${btnDisabled}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        </button>
      </div>
      <div class="kanban-card-actions" data-tour="card-actions">
        ${actionBtn}
        <div class="kanban-actions-center">
          <button class="kanban-icon-btn kanban-action-btn btn-vscode" ${onclick(`openVSCode('${escAttr(p.path)}',event)`)} title="${t('project.vsCode')}"${btnDisabled}><img src="images/vscode.png" width="18" height="18" style="border-radius:2px"></button>
          <button class="kanban-icon-btn kanban-action-btn" ${onclick(`openExplorer('${escAttr(p.path)}',event)`)} title="${t('project.explorer')}"${btnDisabled}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg></button>
          <button class="kanban-icon-btn kanban-action-btn" ${onclick(`showProjectDetail('${escAttr(p.name)}')`)} title="${t('project.detail')}"${btnDisabled}><svg viewBox="0 0 32 32" fill="currentColor" width="16" height="16"><path d="M 2 6 L 2 26 L 7 26 L 7 31.09375 L 8.625 29.78125 L 13.34375 26 L 30 26 L 30 6 Z M 4 8 L 28 8 L 28 24 L 12.65625 24 L 12.375 24.21875 L 9 26.90625 L 9 24 L 4 24 Z M 15 10 L 15 12 L 17 12 L 17 10 Z M 15 14 L 15 22 L 17 22 L 17 14 Z"/></svg></button>
        </div>
        <button class="kanban-icon-btn kanban-action-btn btn-delete-icon" ${onclick(`deleteProject('${escAttr(p.name)}')`)} title="${t('project.delete')}"${btnDisabled}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
      </div>
    </div>`;
}

function renderKanban(projects) {
  const search = ($('dashSearch')?.value || '').toLowerCase();
  const filter = $('dashFilter')?.value || 'all';
  const globalVer = $('globalVersion')?.value || '';

  let filtered = projects;

  // Version filter from global selector
  if (globalVer) {
    filtered = filtered.filter(p => (p.odoo_version || '17') === globalVer);
  }

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
  if (filter === 'running') {
    filtered = filtered.filter(p => p.is_running);
  } else if (filter === 'custom') {
    filtered = filtered.filter(p => p.custom_modules > 0);
  }

  // Show/hide empty state
  const hasProjects = filtered.length > 0;
  $('dashEmpty').style.display = hasProjects ? 'none' : 'block';
  $('dashKanban').style.display = 'grid'; // Always show grid (for demo card or real cards)

  if (hasProjects) {
    $('dashKanban').innerHTML = filtered.map(p => renderKanbanCard(p, false)).join('');
  } else {
    // Show demo card so tour can highlight card elements
    $('dashKanban').innerHTML = renderKanbanCard({
      name: 'my_project',
      http_port: '8069',
      domain: 'my-project.odoo.local',
      odoo_version: _odooVersions?.default || '17',
      is_running: false,
      custom_modules: 2,
      path: '',
      logfile: '',
    }, true);
  }
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

  const detailLogo = p.logo || LOGO_PLACEHOLDER;
  $('detailTitle').innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">
      <img id="detailLogo" src="${escAttr(detailLogo)}" alt="" class="detail-logo" onclick="pickDetailLogo('${escAttr(p.name)}')" title="Click to change logo" onerror="this.src='${LOGO_PLACEHOLDER}'">
      <div>${escHtml(p.name)} <span class="tag" style="font-size:0.7rem;margin-left:8px;background:${getVersionColor(p.odoo_version)};color:#fff;border:none">v${escHtml(p.odoo_version || '17')}</span> ${p.is_running
    ? '<span class="tag tag-running" style="font-size:0.7rem;margin-left:4px">running</span>'
    : '<span class="tag tag-stopped" style="font-size:0.7rem;margin-left:8px">stopped</span>'}</div>
    </div>`;

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
        <div class="detail-value detail-path" title="${escHtml(p.path)}" onclick="openExplorer('${escAttr(p.path)}',event)">${escHtml(p.path)}</div>
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
    <div>
      <div class="detail-label" style="margin-bottom:8px">${t('project.odooLog')}</div>
      <div class="log-box" id="detailLogBox" style="max-height:450px;font-size:0.72rem" data-logpath="${escAttr(p.logfile || (p.path + '\\odoo.log'))}">
        <div style="color:var(--text-tertiary);padding:8px">${t('project.loadingLog')}</div>
      </div>
    </div>
  `;

  // Render footer buttons (fixed, outside scrollable body)
  $('detailFooter').innerHTML = `
    <div class="btn-row" style="flex:1;justify-content:space-between">
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${renderActionBtn(p, 'btn-sm', "hideModal('modalDetail')")}
        <button class="btn btn-vscode btn-sm" onclick="openVSCode('${escAttr(p.path)}',event)">${t('project.vsCode')}</button>
        <button class="btn btn-outline btn-sm" onclick="openExplorer('${escAttr(p.path)}',event)">${t('project.explorer')}</button>
        <button class="btn btn-outline btn-sm" onclick="hideModal('modalDetail');editConfig('${escAttr(p.name)}')">${t('project.editConfig')}</button>
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
      logBox.innerHTML = `<div style="color:var(--text-tertiary);padding:8px">${t('project.noLogFile')}</div>`;
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
    logBox.innerHTML = `<div style="color:var(--text-tertiary);padding:8px">${t('project.noLogFound')}</div>`;
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
      const fragment = data.lines.map(line => `<div class="line">${escHtml(line)}</div>`).join('');
      box.insertAdjacentHTML('beforeend', fragment);
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
// (dead code removed)

function autoGenerateDomain() {
  const name = ($('newProjName')?.value || '').trim();
  const ver = $('newProjVersion')?.value || $('globalVersion')?.value || '17';
  const suffix = _odooVersions?.versions?.find(v => v.key === ver)?.domainSuffix || 'odoo.local';
  const domain = name ? name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase() + '.' + suffix : '';
  if ($('newProjDomain')) $('newProjDomain').value = domain;
}

async function pickDetailLogo(projectName) {
  const data = getFormData();
  const res = await api('pick-logo', { projects_dir: data.projects_dir, project_name: projectName });
  if (res?.ok && res.dataUrl) {
    const img = $('detailLogo');
    if (img) img.src = res.dataUrl;
    refreshStatus();
  }
}

async function pickNewProjectLogo() {
  const data = getFormData();
  const res = await api('pick-logo', { projects_dir: data.projects_dir, project_name: '' });
  if (res?.ok && res.dataUrl) {
    $('newProjLogoPath').value = 'selected';
    $('newProjLogoPreview').src = res.dataUrl;
  }
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

    // Map log_level → log_handler (log_handler overrides log_level in Odoo)
    const _logHandlerMap = {
      'critical': ':CRITICAL', 'error': ':ERROR', 'warn': ':WARNING', 'warning': ':WARNING',
      'info': ':INFO', 'debug': ':DEBUG', 'debug_rpc': ':DEBUG', 'debug_sql': ':DEBUG',
      'debug_rpc_answer': ':DEBUG',
    };

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
        content = content.replace('[options]', `[options]\n${key} = ${value}`);
      }
      // Sync log_handler when log_level changes
      if (key === 'log_level') {
        const handlerVal = _logHandlerMap[value] || ':INFO';
        const handlerRegex = /^log_handler\s*=.*$/m;
        if (handlerRegex.test(content)) {
          content = content.replace(handlerRegex, `log_handler = ${handlerVal}`);
        }
      }
    }

    // Save config
    showToastMessage(t('toast.configSaving'), 'info');
    const saveRes = await api('save_config', { projects_dir: data.projects_dir, project_name: name, content });
    if (!saveRes.ok) { showToastMessage(t('toast.saveFail', { msg: saveRes.msg }), 'error'); return; }

    // Stop Odoo if running, then always (re)start
    const port = _status?.projects?.find(p => p.name === name)?.http_port || '8069';
    const proj = _status?.projects?.find(p => p.name === name);
    if (proj?.is_running) {
      showToastMessage(t('toast.restarting'), 'info');
      await api('stop_odoo', { http_port: port });
      await new Promise(r => setTimeout(r, 2000));
    } else {
      showToastMessage(t('toast.starting'), 'info');
    }
    hideModal('modalDetail');
    await startOdoo(name);
    showToastMessage(t('toast.configRestarted'), 'success');
  } catch (e) {
    showToastMessage(t('toast.error', { msg: e.message }), 'error');
  }
}

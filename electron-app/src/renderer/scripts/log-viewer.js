const params = new URLSearchParams(window.location.search);
const projectName = params.get('project') || 'Unknown';
const logFilePath = params.get('logPath') || '';
const accentColor = params.get('color') || '#f0883e';
const odooVersion = params.get('odooVersion') || '';
const baseDir = params.get('baseDir') || '';
const projectsDir = params.get('projectsDir') || '';
let httpPort = params.get('httpPort') || '';
const projectDomain = params.get('domain') || '';
const odooSourceDir = params.get('odooSourceDir') || '';

// Apply theme from main app
function applyMonitorTheme(preset, mode, customJson) {
  const root = document.documentElement;
  // Preset
  if (preset && preset !== 'default') {
    root.setAttribute('data-preset', preset);
  } else {
    root.removeAttribute('data-preset');
  }
  // Mode
  if (mode === 'light') {
    root.setAttribute('data-mode', 'light');
  } else {
    root.removeAttribute('data-mode');
  }
  // Custom color overrides (from main app's color pickers)
  root.style.cssText = '';
  root.style.setProperty('--accent-color', accentColor);
  if (customJson) {
    try {
      const custom = JSON.parse(customJson);
      // Map main.css var names to monitor var names
      const map = { '--bg-canvas': '--bg', '--bg-surface': '--bg-surface', '--text-primary': '--text', '--text-secondary': '--text-dim', '--border-default': '--border', '--accent': '--accent' };
      for (const [mainVar, val] of Object.entries(custom)) {
        const monitorVar = map[mainVar] || mainVar;
        root.style.setProperty(monitorVar, val);
        if (mainVar === '--accent') root.style.setProperty('--accent-color', val);
      }
    } catch {}
  }
}

// Apply initial theme from query params
const themePreset = params.get('themePreset') || 'default';
const themeMode = params.get('themeMode') || 'dark';
const themeCustom = params.get('themeCustom') || '';
applyMonitorTheme(themePreset, themeMode, themeCustom);

// Apply accent color to header (per-window unique color)
document.documentElement.style.setProperty('--accent-color', accentColor);
document.title = `${projectName} — Monitor`;
document.getElementById('logPath').textContent = logFilePath;

// --- Tab switching ---
let activeTab = 'log';
let dbLoaded = false;

function switchTab(tabId) {
  if (tabId === activeTab) return;
  activeTab = tabId;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.id === 'tabBtn' + tabId.charAt(0).toUpperCase() + tabId.slice(1)));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab' + tabId.charAt(0).toUpperCase() + tabId.slice(1)));
  if (tabId === 'database' && !dbLoaded) {
    dbLoaded = true;
    loadDatabases();
  }
}

// Populate project switcher dropdown
let currentProjectName = projectName;
let currentLogPath = logFilePath;

async function loadProjectList() {
  if (!window.electronAPI) return;
  try {
    const res = await window.electronAPI.invoke('log-viewer-projects');
    if (!res?.ok || !res.projects) return;
    const select = document.getElementById('projectSelect');
    select.innerHTML = '';
    for (const p of res.projects) {
      const opt = document.createElement('option');
      opt.value = JSON.stringify({ name: p.name, logPath: p.logPath, httpPort: p.httpPort });
      opt.textContent = p.name;
      if (p.name === currentProjectName) opt.selected = true;
      select.appendChild(opt);
    }
  } catch {}
}
// loadProjectList() called inside loadI18n().then() to avoid double-init

function switchProject(val) {
  try {
    const parsed = JSON.parse(val);
    if (parsed.name === currentProjectName) return;
    // Unwatch current log
    if (window.electronAPI && currentLogPath) {
      window.electronAPI.invoke('unwatch-log', { logPath: currentLogPath });
    }
    // Update state
    currentProjectName = parsed.name;
    currentLogPath = parsed.logPath;
    httpPort = parsed.httpPort || '';
    document.title = `${parsed.name} — Monitor`;
    document.getElementById('logPath').textContent = parsed.logPath;
    // Clear log and start watching new file
    clearLog();
    lineCount = 0;
    document.getElementById('lineCount').textContent = ti('logViewer.linesCount', { count: 0 });
    window.electronAPI.invoke('watch-log', { logPath: currentLogPath }).then(res => {
      if (res?.ok && res.lines?.length) {
        const box = document.getElementById('logBox');
        if (box.querySelector('.empty-state')) box.innerHTML = '';
        appendLines(res.lines);
        document.getElementById('statusDot').className = 'status-dot watching';
        document.getElementById('statusText').textContent = ti('logViewer.watching');
      } else {
        document.getElementById('logBox').innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg><div>' + ti('logViewer.noLogYet') + '</div></div>';
        document.getElementById('statusDot').className = 'status-dot idle';
        document.getElementById('statusText').textContent = ti('logViewer.noLogFile');
      }
    });
    // Reset database tab so it reloads for new project
    dbLoaded = false;
    if (activeTab === 'database') { dbLoaded = true; loadDatabases(); }
    // Reload sidebar info + server status for new project
    loadProjectInfo();
    checkServerStatus();
  } catch {}
}

function minimizeWindow() {
  if (window.electronAPI) window.electronAPI.invoke('log-window-minimize');
}
function maximizeWindow() {
  if (window.electronAPI) window.electronAPI.invoke('log-window-maximize');
}

// Server status check
async function checkServerStatus() {
  if (!window.electronAPI || !httpPort) return;
  try {
    const res = await window.electronAPI.invoke('log-viewer-server-status', { httpPort });
    const dot = document.getElementById('serverDot');
    const text = document.getElementById('serverStatus');
    if (res?.running) {
      dot.className = 'status-dot watching';
      text.textContent = `Odoo :${httpPort}`;
      text.style.color = '#3fb950';
    } else {
      dot.className = 'status-dot idle';
      text.textContent = `Stopped :${httpPort}`;
      text.style.color = '';
    }
  } catch {}
}
// checkServerStatus() called inside loadI18n().then() to avoid running before UI is ready
let _serverStatusInterval = null;

let autoScroll = true;
let lineCount = 0;
let pinned = false;
let highlightOn = true;
let sidebarOpen = true;
let customModules = [];
let isRestarting = false;

// Simple i18n for log viewer (fetches from main app's locale files)
let _i18n = {};
async function loadI18n() {
  // Read language from saved user settings
  try {
    const res = await window.electronAPI.invoke('load-settings', {});
    const lang = res?.settings?.language || res?.language || 'en';
    const resp = await fetch(`locales/${lang}.json`);
    if (resp.ok) _i18n = await resp.json();
  } catch {
    try {
      const resp = await fetch('locales/en.json');
      if (resp.ok) _i18n = await resp.json();
    } catch { /* fallback to hardcoded */ }
  }
  applyI18n();
}

// Listen for language change from main app
if (window.electronAPI) {
  window.electronAPI.onEvent('language-changed', (data) => {
    const lang = data?.language || data;
    if (lang) {
      fetch(`locales/${lang}.json`).then(r => r.ok ? r.json() : null).then(json => {
        if (json) { _i18n = json; applyI18n(); }
      }).catch(() => {});
    }
  });

  // Listen for theme changes from main app (real-time sync)
  window.electronAPI.onEvent('theme-changed', (data) => {
    if (data) applyMonitorTheme(data.preset, data.mode, data.custom);
  });
}

function ti(key, params) {
  const parts = key.split('.');
  let val = _i18n;
  for (const p of parts) {
    if (val && typeof val === 'object') val = val[p];
    else return key;
  }
  if (typeof val !== 'string') return key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      val = val.replace(`{${k}}`, v);
    }
  }
  return val;
}

function applyI18n() {
  // Batch: set textContent by id
  const texts = {
    statusText: ti('logViewer.waiting'),
    serverStatus: ti('logViewer.checking'),
    sidebarTitle: ti('logViewer.config'),
    logLevelLabel: ti('logViewer.logLevel'),
    upgradeLabel: ti('logViewer.upgradeModules'),
    btnSelectAll: ti('logViewer.selectAll'),
    btnDeselectAll: ti('logViewer.deselectAll'),
    noModulesMsg: ti('logViewer.noCustomModules'),
    createDbTitle: ti('monitor.createDb'),
    createDbPasswdLabel: ti('monitor.adminPasswd'),
    createDbNameLabel: ti('monitor.createDbName'),
    createDbEmailLabel: ti('monitor.adminEmail'),
    createDbPasswordLabel: ti('monitor.adminPasswordLabel'),
    createDbPhoneLabel: ti('monitor.adminPhone'),
    createDbLangLabel: ti('monitor.langLabel'),
    createDbCountryLabel: ti('monitor.countryLabel'),
    createDbDemoLabel: ti('monitor.demoData'),
    createDbHint: ti('monitor.createHint'),
    btnDoCreateDb: ti('logViewer.create'),
    createDbCancelBtn: ti('logViewer.cancel'),
    restoreDbTitle: ti('monitor.restoreDb'),
    restoreDbPasswdLabel: ti('monitor.adminPasswd'),
    restoreDbNameLabel: ti('monitor.createDbName'),
    restoreDbFileLabel: ti('monitor.restoreDbFile'),
    btnDoRestoreDb: ti('logViewer.restore'),
    restoreDbCancelBtn: ti('logViewer.cancel'),
    dropDbTitle: ti('monitor.dropDb'),
    btnDoDropDb: ti('logViewer.drop'),
    lineCount: ti('logViewer.linesCount', { count: lineCount }),
  };
  for (const id in texts) {
    const el = document.getElementById(id);
    if (el) el.textContent = texts[id];
  }

  // Batch: set title by id
  const titles = {
    btnPin: ti('logViewer.alwaysOnTop'),
    btnMaximize: ti('logViewer.maximize'),
    btnSidebar: ti('logViewer.toggleSidebar'),
    btnOpenBrowser: ti('logViewer.openBrowser'),
  };
  for (const id in titles) {
    const el = document.getElementById(id);
    if (el) el.title = titles[id];
  }

  // innerHTML updates
  const el = document.getElementById('restartLabel');
  if (el) el.innerHTML = ti('logViewer.saveRestart');
  document.getElementById('dbConnLabel').textContent = ti('monitor.connInfo') + ':';
  document.getElementById('dbRefreshLabel').textContent = ti('monitor.refresh');

  // Minimize button (no id, use query)
  const minBtn = document.querySelector('[onclick="minimizeWindow()"]');
  if (minBtn) minBtn.title = ti('logViewer.minimize');

  // Span children inside buttons
  const createSpan = document.getElementById('btnCreateDb')?.querySelector('span');
  if (createSpan) createSpan.textContent = ti('monitor.createDb');
  const restoreSpan = document.getElementById('btnRestoreDb')?.querySelector('span');
  if (restoreSpan) restoreSpan.textContent = ti('monitor.restoreDb');

  // Floating buttons
  const clearBtn = document.querySelector('[onclick="clearLog()"]');
  if (clearBtn) { clearBtn.title = ti('logViewer.clearLog'); clearBtn.lastChild.textContent = '\n        ' + ti('logViewer.clear') + '\n      '; }
  const scrollBtn = document.getElementById('btnAutoScroll');
  if (scrollBtn) { scrollBtn.title = ti('logViewer.autoScroll'); scrollBtn.innerHTML = '<span class="fab-dot"></span> ' + ti('logViewer.scroll'); }
  const hlBtn = document.getElementById('btnHighlight');
  if (hlBtn) { hlBtn.title = ti('logViewer.highlightLevels'); hlBtn.innerHTML = '<span class="fab-dot"></span> ' + ti('logViewer.highlight'); }

  // Tab labels
  const tabLog = document.querySelector('[data-tab-label="log"]');
  const tabDb = document.querySelector('[data-tab-label="database"]');
  if (tabLog) tabLog.textContent = ti('monitor.tabLog');
  if (tabDb) tabDb.textContent = ti('monitor.tabDatabase');

  // Modal query selectors
  const restoreFileBtn = document.querySelector('#modalRestoreDb [onclick="pickRestoreFile()"]');
  if (restoreFileBtn) restoreFileBtn.textContent = ti('logViewer.browse');
  const dropCancelBtn = document.querySelector('#modalDropDb [onclick*="hideDbModal"]');
  if (dropCancelBtn) dropCancelBtn.textContent = ti('logViewer.cancel');

  // Database table headers (no reload)
  if (dbLoaded) {
    const ths = document.querySelectorAll('.db-table th');
    if (ths.length >= 5) {
      ths[0].textContent = ti('monitor.dbName');
      ths[1].textContent = ti('monitor.dbSize');
      ths[2].textContent = ti('monitor.dbOwner');
      ths[3].textContent = ti('monitor.dbEncoding');
      ths[4].textContent = ti('monitor.dbActions');
    }
  }
}

// Help tooltips
const helpTexts = {
  helpLogLevel: 'Changes the log_level in odoo.conf. Takes effect after restart.',
  helpUpgrade: 'Selected modules will be upgraded (-u flag) when restarting Odoo.',
};

function showTooltip(event, key) {
  const el = document.getElementById('tooltip');
  const text = ti(`logViewer.${key}`) !== `logViewer.${key}` ? ti(`logViewer.${key}`) : helpTexts[key];
  el.textContent = text;
  el.style.display = 'block';
  const rect = event.target.getBoundingClientRect();
  el.style.left = (rect.right + 8) + 'px';
  el.style.top = rect.top + 'px';
}
function hideTooltip() {
  document.getElementById('tooltip').style.display = 'none';
}

// Start with highlight on
document.body.classList.add('highlight-on');

// Track last log level for continuation lines (Traceback, stack traces inherit parent level)
let _lastLogLevel = '';
const _LOG_LINE_RE = /^\d{4}-\d{2}-\d{2}\s/; // Odoo log lines start with timestamp

function getLineClass(text) {
  // Lines starting with timestamp = new log entry → detect level
  if (_LOG_LINE_RE.test(text)) {
    if (/\bCRITICAL\b/i.test(text)) { _lastLogLevel = 'line-critical'; return _lastLogLevel; }
    if (/\bERROR\b/i.test(text)) { _lastLogLevel = 'line-error'; return _lastLogLevel; }
    if (/\bWARNING\b/i.test(text)) { _lastLogLevel = 'line-warning'; return _lastLogLevel; }
    if (/\bINFO\b/i.test(text)) { _lastLogLevel = 'line-info'; return _lastLogLevel; }
    if (/\bDEBUG\b/i.test(text)) { _lastLogLevel = 'line-debug'; return _lastLogLevel; }
    _lastLogLevel = '';
    return '';
  }
  // Continuation line (Traceback, stack trace, etc.) — inherit parent level
  if (_lastLogLevel) return _lastLogLevel;
  // Fallback for standalone Traceback/Exception (no parent context)
  if (/Traceback|Exception/i.test(text)) return 'line-error';
  return '';
}

function appendLines(lines) {
  const box = document.getElementById('logBox');
  const fragment = document.createDocumentFragment();
  for (const line of lines) {
    const div = document.createElement('div');
    div.className = 'line ' + getLineClass(line);
    div.textContent = line;
    fragment.appendChild(div);
    lineCount++;
  }
  box.appendChild(fragment);
  while (box.childElementCount > 1000) {
    box.removeChild(box.firstChild);
    lineCount--;
  }
  document.getElementById('lineCount').textContent = ti('logViewer.linesCount', { count: lineCount });
  if (autoScroll) box.scrollTop = box.scrollHeight;
}

function clearLog() {
  document.getElementById('logBox').innerHTML = '';
  lineCount = 0;
  document.getElementById('lineCount').textContent = ti('logViewer.linesCount', { count: 0 });
}

function toggleAutoScroll() {
  autoScroll = !autoScroll;
  const btn = document.getElementById('btnAutoScroll');
  btn.classList.toggle('active', autoScroll);
  btn.innerHTML = '<span class="fab-dot"></span> ' + ti('logViewer.scroll');
}

function toggleHighlight() {
  highlightOn = !highlightOn;
  document.body.classList.toggle('highlight-on', highlightOn);
  const btn = document.getElementById('btnHighlight');
  btn.classList.toggle('active', highlightOn);
  btn.innerHTML = '<span class="fab-dot"></span> ' + ti('logViewer.highlight');
}

function togglePin() {
  pinned = !pinned;
  window.electronAPI.invoke('log-window-pin', { pinned });
  const btn = document.getElementById('btnPin');
  btn.classList.remove('animate-in', 'animate-out');
  btn.classList.toggle('pinned', pinned);
  // Restart animation without forced reflow
  requestAnimationFrame(() => {
    btn.classList.add(pinned ? 'animate-in' : 'animate-out');
  });
  btn.title = pinned ? ti('logViewer.pinnedOnTop') : ti('logViewer.alwaysOnTop');
}

function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  document.getElementById('sidebar').classList.toggle('collapsed', !sidebarOpen);
}

// --- Sidebar: Load project info ---
async function loadProjectInfo() {
  if (!window.electronAPI) return;
  try {
    const res = await window.electronAPI.invoke('log-viewer-info', {
      projectName: currentProjectName, projectsDir, baseDir, odooVersion,
    });
    if (!res?.ok) return;

    // Set log level
    const select = document.getElementById('logLevelSelect');
    if (res.logLevel) {
      // Add option if not in predefined list
      let found = false;
      for (const opt of select.options) {
        if (opt.value === res.logLevel) { found = true; break; }
      }
      if (!found) {
        const opt = document.createElement('option');
        opt.value = res.logLevel;
        opt.textContent = res.logLevel;
        select.appendChild(opt);
      }
      select.value = res.logLevel;
    }

    // Populate modules
    customModules = res.customModules || [];
    renderModuleList();
  } catch (e) {
    console.error('loadProjectInfo:', e);
  }
}

function renderModuleList() {
  const area = document.getElementById('moduleListArea');
  const noMsg = document.getElementById('noModulesMsg');
  const actions = document.getElementById('moduleActions');
  const countEl = document.getElementById('moduleCount');
  const searchEl = document.getElementById('moduleSearch');

  if (customModules.length === 0) {
    noMsg.style.display = 'block';
    actions.style.display = 'none';
    countEl.style.display = 'none';
    if (searchEl) searchEl.style.display = 'none';
    return;
  }

  noMsg.style.display = 'none';
  actions.style.display = 'flex';
  if (searchEl) { searchEl.style.display = ''; searchEl.value = ''; }
  area.innerHTML = '';

  for (const mod of customModules) {
    const item = document.createElement('div');
    item.className = 'module-item';
    item.setAttribute('data-module', mod.toLowerCase());
    item.innerHTML = `<input type="checkbox" id="mod_${mod}" value="${mod}"><label for="mod_${mod}">${mod}</label>`;
    item.querySelector('input').addEventListener('change', updateModuleCount);
    area.appendChild(item);
  }
  updateModuleCount();
}

function filterModules(query) {
  const q = (query || '').toLowerCase();
  document.querySelectorAll('#moduleListArea .module-item').forEach(item => {
    const name = item.getAttribute('data-module') || '';
    item.style.display = !q || name.includes(q) ? '' : 'none';
  });
}

function updateModuleCount() {
  const checked = document.querySelectorAll('#moduleListArea input[type="checkbox"]:checked');
  const countEl = document.getElementById('moduleCount');
  if (checked.length > 0) {
    countEl.style.display = 'block';
    countEl.textContent = ti('logViewer.modulesSelected', { count: checked.length });
  } else {
    countEl.style.display = 'none';
  }
}

function selectAllModules() {
  document.querySelectorAll('#moduleListArea input[type="checkbox"]').forEach(cb => cb.checked = true);
  updateModuleCount();
}
function deselectAllModules() {
  document.querySelectorAll('#moduleListArea input[type="checkbox"]').forEach(cb => cb.checked = false);
  updateModuleCount();
}

// --- Open Browser ---
async function openBrowserFromMonitor() {
  if (!window.electronAPI) return;
  // Prefer HTTPS domain if available, fallback to localhost
  const url = projectDomain ? `https://${projectDomain}` : `http://localhost:${httpPort}`;
  await window.electronAPI.invoke('open_browser', { url });
}

// --- Save & Restart ---
async function saveAndRestart() {
  if (isRestarting || !window.electronAPI) return;
  isRestarting = true;

  const btn = document.getElementById('btnRestart');
  const label = document.getElementById('restartLabel');
  btn.disabled = true;
  label.innerHTML = ti('logViewer.restarting');
  // Show spinner
  btn.querySelector('svg').style.display = 'none';
  const spinner = document.createElement('span');
  spinner.className = 'restart-spinner';
  btn.insertBefore(spinner, label);

  try {
    const logLevel = document.getElementById('logLevelSelect').value;
    const selectedModules = [];
    document.querySelectorAll('#moduleListArea input[type="checkbox"]:checked').forEach(cb => {
      selectedModules.push(cb.value);
    });

    const res = await window.electronAPI.invoke('log-viewer-restart', {
      projectName: currentProjectName, projectsDir, baseDir, odooVersion,
      httpPort, logLevel, upgradeModules: selectedModules, odooSourceDir,
    });

    if (res?.ok) {
      label.innerHTML = ti('logViewer.restartSuccess');
      // Refresh server status after restart
      setTimeout(checkServerStatus, 2000);
    } else {
      label.innerHTML = ti('logViewer.restartFail') + (res?.msg ? `: ${res.msg}` : '');
    }
  } catch (e) {
    console.error('[log-viewer] restart error:', e);
    label.innerHTML = ti('logViewer.restartFail') + (e?.message ? `: ${e.message}` : '');
  } finally {
    setTimeout(() => {
      isRestarting = false;
      btn.disabled = false;
      spinner.remove();
      btn.querySelector('svg').style.display = '';
      label.innerHTML = ti('logViewer.saveRestart');
    }, 2000);
  }
}

// IPC: receive log lines from main process
if (window.electronAPI) {
  // Load i18n FIRST, then init everything else
  loadI18n().then(() => {
    // Run all init tasks in parallel — none depend on each other
    loadProjectInfo();
    loadProjectList();
    checkServerStatus();
    _serverStatusInterval = setInterval(checkServerStatus, 5000);

    // Start watching log file
    window.electronAPI.invoke('watch-log', { logPath: currentLogPath }).then(res => {
      if (res?.ok && res.lines?.length) {
        const box = document.getElementById('logBox');
        if (box.querySelector('.empty-state')) box.innerHTML = '';
        appendLines(res.lines);
        document.getElementById('statusDot').className = 'status-dot watching';
        document.getElementById('statusText').textContent = ti('logViewer.watching');
      } else {
        document.getElementById('logBox').innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg><div>' + ti('logViewer.noLogYet') + '</div></div>';
      }
    }).catch(err => {
      console.error('[log-viewer] watch-log error:', err);
    });

    // Realtime updates (register after i18n loaded so ti() works)
    window.electronAPI.onEvent('project-log', (data) => {
      if (data.logPath === currentLogPath && data.lines?.length) {
        document.getElementById('statusDot').className = 'status-dot watching';
        document.getElementById('statusText').textContent = ti('logViewer.watching');
        appendLines(data.lines);
      }
    });
  });
}

// ======== Database Tab ========
let _dbDropTarget = '';
let _adminPasswd = 'odoo';

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

const stepLabels = {
  creating_db: () => ti('monitor.stepCreatingDb'),
  init_schema: () => ti('monitor.stepInitSchema'),
  configuring_admin: () => ti('monitor.stepConfiguringAdmin'),
  extracting: () => ti('monitor.stepExtracting'),
  restoring_data: () => ti('monitor.stepRestoringData'),
  copying_filestore: () => ti('monitor.stepCopyingFilestore'),
  preparing: () => ti('monitor.restoring'),
  terminating_connections: () => ti('monitor.stepTerminating'),
  dropping_db: () => ti('monitor.stepDropping'),
  interrupted: () => ti('monitor.interrupted'),
  done: () => ti('monitor.done'),
  error: () => ti('monitor.error'),
};

// --- Inline progress rows: track active jobs in frontend ---
const _inlineJobs = new Map(); // key → { type, dbName, status, step, elapsed, output[], error }

// Progress percentage comes from backend via `progress` field in events

// --- Render a single inline progress row ---
function renderProgressRow(job) {
  const typeLabels = { create: ti('monitor.creating'), restore: ti('monitor.restoring'), drop: ti('monitor.dropping') };
  const typeLabel = typeLabels[job.type] || job.type;
  const stepLabel = (stepLabels[job.step] || (() => job.step))();
  const elapsed = job.elapsed ? formatElapsed(job.elapsed) : (job.startTime ? formatElapsed(Date.now() - job.startTime) : '');
  const pct = job.status === 'done' ? 100 : job.status === 'error' || job.status === 'interrupted' ? 0 : (job.progress || 0);

  const statusCls = job.status === 'done' ? 'db-row-done' : job.status === 'error' ? 'db-row-error' : job.status === 'interrupted' ? 'db-row-error' : 'db-row-progress';
  const icon = job.status === 'done' ? '<span style="color:var(--success);margin-right:6px">&#10003;</span>' : job.status === 'error' || job.status === 'interrupted' ? '<span style="color:var(--danger);margin-right:6px">&#10007;</span>' : '';
  const errorMsg = job.error ? (() => { const t = ti('monitor.' + job.error); return t !== 'monitor.' + job.error ? t : job.error; })() : '';
  const dismissBtn = (job.status === 'done' || job.status === 'error' || job.status === 'interrupted') ? `<button class="db-toolbar-btn" onclick="dismissJob('${escJs(job.type)}','${escJs(job.dbName)}')" style="padding:2px 8px;font-size:0.65rem">${ti('monitor.dismiss')}</button>` : '';

  const barColor = job.status === 'done' ? 'var(--success)' : job.status === 'error' || job.status === 'interrupted' ? 'var(--danger)' : 'var(--accent)';
  const progressBar = `<div class="db-progress-bar"><div class="db-progress-fill" style="width:${pct}%;background:${barColor}"></div></div>`;

  return `<tr class="${statusCls}" data-job-type="${esc(job.type)}" data-job-db="${esc(job.dbName)}">
    <td><strong>${esc(job.dbName)}</strong> <span class="db-job-badge db-job-badge-${job.type}">${typeLabel}</span></td>
    <td colspan="3" class="db-progress-cell">
      <div class="db-progress-info">${icon}<span class="db-step-label">${stepLabel}</span>${elapsed ? `<span class="db-elapsed">${elapsed}</span>` : ''}${job.status === 'running' ? `<span class="db-pct">${pct}%</span>` : ''}${errorMsg ? `<span class="db-error-msg">${esc(errorMsg)}</span>` : ''}</div>
      ${progressBar}
    </td>
    <td class="db-actions">${dismissBtn}</td>
  </tr>`;
}

// --- Listen for db-job-progress events → update inline rows ---
if (window.electronAPI) {
  window.electronAPI.onEvent('db-job-progress', (data) => {
    // Update _inlineJobs map
    const key = data.type === 'drop' ? `${data.type}:${data.dbName}` : data.type;
    let job = _inlineJobs.get(key);
    if (!job) {
      job = { type: data.type, dbName: data.dbName, status: 'running', step: '', elapsed: 0, output: [], error: null };
      _inlineJobs.set(key, job);
    }
    job.status = data.status;
    job.step = data.step;
    job.elapsed = data.elapsed || 0;
    if (data.progress !== undefined) job.progress = data.progress;
    if (data.error) job.error = data.error;
    if (data.detail) {
      job.output.push(data.detail);
      if (job.output.length > 100) job.output.shift();
    }

    // Find existing row in DOM and update in place
    const row = document.querySelector(`tr[data-job-type="${data.type}"][data-job-db="${CSS.escape(data.dbName)}"]`);
    if (row) {
      const tmp = document.createElement('tbody');
      tmp.innerHTML = renderProgressRow(job);
      row.replaceWith(tmp.firstElementChild);
    }
    // If row not found, loadDatabases() will render it from _inlineJobs

    // On done: reload table after short delay
    if (data.status === 'done') {
      setTimeout(() => {
        _inlineJobs.delete(key);
        loadDatabases(true);
      }, 1500);
    }
  });
}

// --- Elapsed timer: update running job rows every second ---
let _elapsedTimer = null;
function _startElapsedTimer() {
  if (_elapsedTimer) return;
  _elapsedTimer = setInterval(() => {
    let hasRunning = false;
    for (const [key, job] of _inlineJobs) {
      if (job.status !== 'running') continue;
      hasRunning = true;
      const elapsed = job.startTime ? formatElapsed(Date.now() - job.startTime) : '';
      const row = document.querySelector(`tr[data-job-type="${job.type}"][data-job-db="${CSS.escape(job.dbName)}"]`);
      if (row) {
        const el = row.querySelector('.db-elapsed');
        if (el) el.textContent = elapsed;
      }
    }
    if (!hasRunning) { clearInterval(_elapsedTimer); _elapsedTimer = null; }
  }, 1000);
}

// --- Load databases + active jobs into table ---
async function loadDatabases(silent) {
  const wrap = document.getElementById('dbTableWrap');
  if (!silent) wrap.innerHTML = '<div class="db-loading"><span class="restart-spinner"></span><span>' + ti('logViewer.loading') + '</span></div>';

  // Fetch DB list + active jobs in parallel
  const [dbRes, jobRes] = await Promise.all([
    window.electronAPI.invoke('monitor-list-databases', { projectName: currentProjectName, projectsDir, odooVersion }).catch(() => null),
    window.electronAPI.invoke('monitor-db-job-status', { projectName: currentProjectName }).catch(() => null),
  ]);

  if (!dbRes?.ok) {
    wrap.innerHTML = `<div class="db-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg><div>${esc(dbRes?.msg || 'Failed to load databases')}</div></div>`;
    return;
  }

  // Connection info
  if (dbRes.connInfo) {
    document.getElementById('dbHost').textContent = dbRes.connInfo.host || '-';
    document.getElementById('dbPort').textContent = dbRes.connInfo.port || '-';
    document.getElementById('dbUser').textContent = dbRes.connInfo.user || '-';
    if (dbRes.connInfo.adminPasswd) _adminPasswd = dbRes.connInfo.adminPasswd;
  }
  // Show dbfilter if set
  const filterTag = document.getElementById('dbFilterTag');
  const filterEl = document.getElementById('dbFilter');
  if (filterTag && filterEl && dbRes.dbfilter) {
    filterEl.textContent = dbRes.dbfilter;
    filterTag.style.display = '';
  }

  // Merge active jobs into _inlineJobs
  if (jobRes?.ok && jobRes.jobs) {
    for (const j of jobRes.jobs) {
      if (j.status === 'running' || j.status === 'error' || j.status === 'interrupted') {
        const key = j.type === 'drop' ? `drop:${j.dbName}` : j.type;
        if (!_inlineJobs.has(key)) {
          _inlineJobs.set(key, { type: j.type, dbName: j.dbName, status: j.status, step: j.step, elapsed: Date.now() - j.startTime, output: [], error: j.error || null });
        }
      }
    }
  }

  const dbs = dbRes.databases || [];
  // Build set of DB names with active drop jobs (these rows become progress rows)
  const droppingDbs = new Set();
  for (const [, j] of _inlineJobs) {
    if (j.type === 'drop' && (j.status === 'running' || j.status === 'error' || j.status === 'interrupted')) droppingDbs.add(j.dbName);
  }

  const hasData = dbs.length > 0 || _inlineJobs.size > 0;
  if (!hasData) {
    wrap.innerHTML = '<div class="db-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg><div>' + ti('monitor.noDatabases') + '</div></div>';
    return;
  }

  let html = '<table class="db-table"><thead><tr>';
  html += `<th>${ti('monitor.dbName')}</th><th>${ti('monitor.dbSize')}</th><th>${ti('monitor.dbOwner')}</th><th>${ti('monitor.dbEncoding')}</th><th>${ti('monitor.dbActions')}</th>`;
  html += '</tr></thead><tbody>';

  // Prepend create/restore progress rows
  for (const [, j] of _inlineJobs) {
    if (j.type !== 'drop' && (j.status === 'running' || j.status === 'error' || j.status === 'interrupted')) {
      html += renderProgressRow(j);
    }
  }

  // Normal DB rows (skip those being dropped)
  for (const db of dbs) {
    if (droppingDbs.has(db.name)) {
      // Render as progress row instead
      const j = [..._inlineJobs.values()].find(j => j.type === 'drop' && j.dbName === db.name);
      if (j) { html += renderProgressRow(j); continue; }
    }
    html += `<tr>
      <td><strong>${esc(db.name)}</strong></td>
      <td class="db-size">${esc(db.size)}</td>
      <td>${esc(db.owner)}</td>
      <td>${esc(db.encoding)}</td>
      <td class="db-actions">${
        ['postgres','template0','template1'].includes(db.name) ? '' :
        `<button class="db-toolbar-btn danger" onclick="showDropDbModal('${escJs(db.name)}')" style="padding:3px 8px;font-size:0.68rem">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/></svg>
          ${ti('monitor.drop')}
        </button>`
      }</td>
    </tr>`;
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
function escJs(s) { return (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"'); }

function showDbModal(id) { document.getElementById(id).classList.add('show'); }
function hideDbModal(id) {
  document.getElementById(id).classList.remove('show');
  // Clear messages
  const msg = document.getElementById(id)?.querySelector('.db-msg');
  if (msg) { msg.className = 'db-msg'; msg.textContent = ''; }
}

function _getDbPrefix() {
  return currentProjectName || '';
}

function showCreateDbModal() {
  document.getElementById('createDbPrefix').textContent = _getDbPrefix();
  document.getElementById('createDbName').value = '';
  document.getElementById('createDbName').placeholder = ti('logViewer.dbNamePlaceholder');
  document.getElementById('createDbMsg').className = 'db-msg';
  document.getElementById('btnDoCreateDb').disabled = false;
  document.getElementById('createDbPasswd').value = _adminPasswd || 'odoo';
  showDbModal('modalCreateDb');
  setTimeout(() => document.getElementById('createDbName').focus(), 100);
}

async function doCreateDb() {
  const suffix = document.getElementById('createDbName').value.trim();
  const prefix = _getDbPrefix();
  const name = suffix ? prefix + suffix : prefix;
  const msgEl = document.getElementById('createDbMsg');
  if (!name) { msgEl.className = 'db-msg error'; msgEl.textContent = ti('logViewer.dbNameRequired'); return; }
  const demoData = document.getElementById('createDbDemo').checked;
  const adminEmail = document.getElementById('createDbEmail').value.trim() || 'admin';
  const adminPassword = document.getElementById('createDbPassword').value.trim() || 'admin';
  const adminPhone = document.getElementById('createDbPhone').value.trim();
  const lang = document.getElementById('createDbLang').value;
  const country = document.getElementById('createDbCountry').value.trim();

  document.getElementById('btnDoCreateDb').disabled = true;

  // Pre-register job + insert row BEFORE API call to prevent race with db-job-progress event
  _inlineJobs.set('create', { type: 'create', dbName: name, status: 'running', step: 'creating_db', elapsed: 0, output: [], error: null, startTime: Date.now() });
  hideDbModal('modalCreateDb');
  const tbody = document.querySelector('.db-table tbody');
  if (tbody) tbody.insertAdjacentHTML('afterbegin', renderProgressRow(_inlineJobs.get('create')));
  _startElapsedTimer();

  try {
    const res = await window.electronAPI.invoke('monitor-create-database', {
      projectName: currentProjectName, dbName: name, demoData,
      adminEmail, adminPassword, adminPhone, lang, country,
      projectsDir, baseDir, odooVersion, odooSourceDir,
    });
    if (!res?.ok && res?.msg !== 'STARTED') {
      // API rejected — remove inline row, reopen modal with error
      _inlineJobs.delete('create');
      const row = document.querySelector('tr[data-job-type="create"][data-job-db="' + CSS.escape(name) + '"]');
      if (row) row.remove();
      showDbModal('modalCreateDb');
      msgEl.className = 'db-msg error'; msgEl.textContent = ti('monitor.' + res?.msg) || res?.msg || 'Error';
    }
  } catch (e) {
    _inlineJobs.delete('create');
    const row = document.querySelector('tr[data-job-type="create"][data-job-db="' + CSS.escape(name) + '"]');
    if (row) row.remove();
    showDbModal('modalCreateDb');
    msgEl.className = 'db-msg error'; msgEl.textContent = e?.message || 'Error';
  } finally {
    document.getElementById('btnDoCreateDb').disabled = false;
  }
}

function showRestoreDbModal() {
  document.getElementById('restoreDbPrefix').textContent = _getDbPrefix();
  document.getElementById('restoreDbName').value = '';
  document.getElementById('restoreDbName').placeholder = ti('logViewer.dbNamePlaceholder');
  document.getElementById('restoreDbFile').value = '';
  document.getElementById('restoreDbMsg').className = 'db-msg';
  document.getElementById('restoreDbPasswd').value = _adminPasswd || 'odoo';
  document.getElementById('btnDoRestoreDb').disabled = false;
  showDbModal('modalRestoreDb');
  setTimeout(() => document.getElementById('restoreDbName').focus(), 100);
}

async function pickRestoreFile() {
  try {
    const res = await window.electronAPI.invoke('pick-file', {
      title: 'Select database backup',
      filters: [{ name: 'Database backup', extensions: ['zip', 'dump', 'sql'] }],
    });
    if (res?.path) document.getElementById('restoreDbFile').value = res.path;
  } catch {}
}

async function doRestoreDb() {
  const suffix = document.getElementById('restoreDbName').value.trim();
  const filePath = document.getElementById('restoreDbFile').value.trim();
  const prefix = _getDbPrefix();
  const name = suffix ? prefix + suffix : prefix;
  const msgEl = document.getElementById('restoreDbMsg');
  if (!name) { msgEl.className = 'db-msg error'; msgEl.textContent = ti('logViewer.dbNameRequired'); return; }
  if (!filePath) { msgEl.className = 'db-msg error'; msgEl.textContent = ti('logViewer.backupRequired'); return; }

  document.getElementById('btnDoRestoreDb').disabled = true;

  // Pre-register job + insert row BEFORE API call to prevent race with db-job-progress event
  _inlineJobs.set('restore', { type: 'restore', dbName: name, status: 'running', step: 'preparing', elapsed: 0, output: [], error: null, startTime: Date.now() });
  hideDbModal('modalRestoreDb');
  const tbody = document.querySelector('.db-table tbody');
  if (tbody) tbody.insertAdjacentHTML('afterbegin', renderProgressRow(_inlineJobs.get('restore')));
  _startElapsedTimer();

  try {
    const res = await window.electronAPI.invoke('monitor-restore-database', {
      projectName: currentProjectName, dbName: name, filePath,
      projectsDir, baseDir, odooVersion, odooSourceDir,
    });
    if (!res?.ok && res?.msg !== 'STARTED') {
      _inlineJobs.delete('restore');
      const row = document.querySelector('tr[data-job-type="restore"][data-job-db="' + CSS.escape(name) + '"]');
      if (row) row.remove();
      showDbModal('modalRestoreDb');
      msgEl.className = 'db-msg error'; msgEl.textContent = ti('monitor.' + res?.msg) || res?.msg || 'Error';
    }
  } catch (e) {
    _inlineJobs.delete('restore');
    const row = document.querySelector('tr[data-job-type="restore"][data-job-db="' + CSS.escape(name) + '"]');
    if (row) row.remove();
    showDbModal('modalRestoreDb');
    msgEl.className = 'db-msg error'; msgEl.textContent = e?.message || 'Error';
  } finally {
    document.getElementById('btnDoRestoreDb').disabled = false;
  }
}

function showDropDbModal(dbName) {
  _dbDropTarget = dbName;
  document.getElementById('dropDbConfirmText').textContent = ti('monitor.dropConfirm', { name: dbName });
  document.getElementById('dropDbConfirmInput').value = '';
  document.getElementById('dropDbMsg').className = 'db-msg';
  showDbModal('modalDropDb');
  setTimeout(() => document.getElementById('dropDbConfirmInput').focus(), 100);
}

async function doDropDb() {
  const input = document.getElementById('dropDbConfirmInput').value.trim();
  const msgEl = document.getElementById('dropDbMsg');
  if (input !== _dbDropTarget) { msgEl.className = 'db-msg error'; msgEl.textContent = ti('logViewer.nameNotMatch'); return; }
  document.getElementById('btnDoDropDb').disabled = true;
  const dropTarget = _dbDropTarget;
  const dropKey = `drop:${dropTarget}`;

  // Pre-register job + transform row BEFORE API call to prevent race
  _inlineJobs.set(dropKey, { type: 'drop', dbName: dropTarget, status: 'running', step: 'terminating_connections', elapsed: 0, output: [], error: null, startTime: Date.now() });
  hideDbModal('modalDropDb');
  const existingRow = [...document.querySelectorAll('.db-table tbody tr')].find(r => r.querySelector('td strong')?.textContent === dropTarget);
  if (existingRow) {
    const tmp = document.createElement('tbody');
    tmp.innerHTML = renderProgressRow(_inlineJobs.get(dropKey));
    existingRow.replaceWith(tmp.firstElementChild);
  }
  _startElapsedTimer();

  try {
    const res = await window.electronAPI.invoke('monitor-drop-database', {
      projectName: currentProjectName, dbName: dropTarget, projectsDir, odooVersion,
    });
    if (!res?.ok && res?.msg !== 'STARTED') {
      _inlineJobs.delete(dropKey);
      loadDatabases(true);
      showDbModal('modalDropDb');
      msgEl.className = 'db-msg error'; msgEl.textContent = res?.msg || 'Error';
    }
  } catch (e) {
    _inlineJobs.delete(dropKey);
    loadDatabases(true);
    showDbModal('modalDropDb');
    msgEl.className = 'db-msg error'; msgEl.textContent = e?.message || 'Error';
  } finally {
    document.getElementById('btnDoDropDb').disabled = false;
  }
}

async function dismissJob(type, dbName) {
  const key = type === 'drop' ? `drop:${dbName}` : type;
  _inlineJobs.delete(key);
  // Remove row from DOM
  const row = document.querySelector(`tr[data-job-type="${type}"][data-job-db="${CSS.escape(dbName)}"]`);
  if (row) row.remove();
  // Tell backend to cleanup
  if (window.electronAPI) {
    window.electronAPI.invoke('monitor-dismiss-db-job', { projectName: currentProjectName, type, dbName });
  }
}

// ======== Monitor Guided Tour ========
// Use function (lazy) so ti() is called after i18n is loaded
function _mt(key, fallback) { const v = ti(key); return v !== key ? v : fallback; }
function getMonitorTourSteps() {
  return [
    { selector: '[data-tour="monitor-tabs"]', title: _mt('logViewer.tourTabs', 'Tabs'), text: _mt('logViewer.tourTabsText', 'Switch between Log (real-time Odoo logs) and Database (create, restore, drop databases).'), position: 'bottom' },
    { selector: '[data-tour="monitor-status"]', title: _mt('logViewer.tourStatus', 'Status Bar'), text: _mt('logViewer.tourStatusText', 'Log watcher status and Odoo server status. Green dot = active.'), position: 'bottom' },
    { selector: '[data-tour="monitor-pin"]', title: _mt('logViewer.tourPin', 'Pin Window'), text: _mt('logViewer.tourPinText', 'Keep this window always on top of other windows.'), position: 'bottom' },
    { selector: '[data-tour="monitor-actions"]', title: _mt('logViewer.tourActions', 'Save & Restart'), text: _mt('logViewer.tourActionsText', 'Save config changes (log level, modules) and restart Odoo. Open browser button on the right.'), position: 'bottom' },
    { selector: '[data-tour="monitor-log-level"]', title: _mt('logViewer.tourLogLevel', 'Log Level'), text: _mt('logViewer.tourLogLevelText', 'Change Odoo log verbosity. Takes effect after Save & Restart.'), position: 'right' },
    { selector: '[data-tour="monitor-modules"]', title: _mt('logViewer.tourModules', 'Module Upgrade'), text: _mt('logViewer.tourModulesText', 'Select modules to upgrade (-u flag) when restarting Odoo.'), position: 'right' },
    { selector: '[data-tour="monitor-log-controls"]', title: _mt('logViewer.tourLogControls', 'Log Controls'), text: _mt('logViewer.tourLogControlsText', 'Clear log, toggle auto-scroll, toggle log level highlighting.'), position: 'left' },
    { selector: '[data-tour="monitor-log-area"]', title: _mt('logViewer.tourLogArea', 'Log Viewer'), text: _mt('logViewer.tourLogAreaText', 'Real-time Odoo logs. Colors: red = error, yellow = warning, blue = info. Max 1000 lines.'), position: 'top' },
    { selector: '[data-tour="monitor-db-toolbar"]', title: _mt('logViewer.tourDbToolbar', 'Database Toolbar'), text: _mt('logViewer.tourDbToolbarText', 'Create new database, restore from backup, or refresh the list. Works without Odoo running.'), position: 'bottom', actionBefore: 'switchToDb' },
  ];
}

let _mTourStep = -1;
let _mTourEls = {};
let _mTourPrev = null;

function startMonitorTour() {
  if (_mTourEls.container) _mTourEls.container.remove();

  const container = document.createElement('div');
  container.id = 'monitorTourOverlay';
  container.innerHTML = `
    <div class="mtour-overlay mtour-top"></div>
    <div class="mtour-overlay mtour-bottom"></div>
    <div class="mtour-overlay mtour-left"></div>
    <div class="mtour-overlay mtour-right"></div>
    <div class="mtour-tooltip" id="mtourTooltip">
      <div class="mtour-arrow" id="mtourArrow"></div>
      <div class="mtour-title" id="mtourTitle"></div>
      <div class="mtour-text" id="mtourText"></div>
      <div class="mtour-footer">
        <span class="mtour-counter" id="mtourCounter"></span>
        <span class="mtour-skip" onclick="endMonitorTour()">Skip</span>
        <button class="mtour-btn" id="mtourPrev" onclick="prevMTour()">Prev</button>
        <button class="mtour-btn mtour-btn-next" id="mtourNext" onclick="nextMTour()">Next</button>
      </div>
    </div>`;
  document.body.appendChild(container);
  _mTourEls = {
    container,
    top: container.querySelector('.mtour-top'),
    bottom: container.querySelector('.mtour-bottom'),
    left: container.querySelector('.mtour-left'),
    right: container.querySelector('.mtour-right'),
    tooltip: document.getElementById('mtourTooltip'),
  };
  _mTourStep = -1;
  nextMTour();
}

function endMonitorTour() {
  if (_mTourPrev) { _mTourPrev.classList.remove('tour-highlight'); _mTourPrev = null; }
  if (_mTourEls.container) _mTourEls.container.remove();
  _mTourEls = {};
  try { localStorage.setItem('monitor_tour_done', '1'); } catch {}
}

function nextMTour() {
  const cur = getMonitorTourSteps()[_mTourStep];
  if (cur && cur.actionAfter) _execMTourAction(cur.actionAfter);
  _mTourStep++;
  if (_mTourStep >= getMonitorTourSteps().length) { endMonitorTour(); return; }
  _goMTourStep(_mTourStep);
}

function prevMTour() {
  const cur = getMonitorTourSteps()[_mTourStep];
  if (cur && cur.actionAfter) _execMTourAction(cur.actionAfter);
  if (_mTourStep > 0) { _mTourStep--; _goMTourStep(_mTourStep); }
}

function _execMTourAction(action) {
  if (action === 'switchToDb') switchTab('database');
  if (action === 'switchToLog') switchTab('log');
}

function _goMTourStep(idx) {
  const step = getMonitorTourSteps()[idx];
  if (!step) { endMonitorTour(); return; }
  if (step.actionBefore) _execMTourAction(step.actionBefore);

  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (_mTourPrev) { _mTourPrev.classList.remove('tour-highlight'); _mTourPrev = null; }
    const target = document.querySelector(step.selector);
    if (!target) { nextMTour(); return; }

    target.scrollIntoView({ behavior: 'instant', block: 'center' });
    requestAnimationFrame(() => {
      const rect = target.getBoundingClientRect();
      const pad = 8;
      const W = window.innerWidth, H = window.innerHeight;
      const top = Math.max(0, rect.top - pad), left = Math.max(0, rect.left - pad);
      const bottom = Math.min(H, rect.bottom + pad), right = Math.min(W, rect.right + pad);

      _setMOverlay('top', 0, 0, W, top);
      _setMOverlay('bottom', 0, bottom, W, H - bottom);
      _setMOverlay('left', 0, top, left, bottom - top);
      _setMOverlay('right', right, top, W - right, bottom - top);

      target.classList.add('tour-highlight');
      _mTourPrev = target;

      // Position tooltip
      const pos = step.position || 'bottom';
      const tooltip = _mTourEls.tooltip;
      const arrow = document.getElementById('mtourArrow');
      tooltip.setAttribute('data-pos', pos);
      let tl, tt;
      const gap = 14;
      if (pos === 'bottom') { tt = rect.bottom + gap; tl = Math.max(8, Math.min(rect.left, W - 320)); }
      else if (pos === 'top') { tt = rect.top - gap - 150; tl = Math.max(8, Math.min(rect.left, W - 320)); }
      else if (pos === 'left') { tt = rect.top; tl = rect.left - gap - 310; }
      else { tt = rect.top; tl = rect.right + gap; }
      tl = Math.max(8, Math.min(tl, W - 320));
      tt = Math.max(8, Math.min(tt, H - 180));
      tooltip.style.left = tl + 'px';
      tooltip.style.top = tt + 'px';

      // Arrow
      if (arrow) {
        arrow.style.left = ''; arrow.style.top = '';
        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
        if (pos === 'bottom' || pos === 'top') arrow.style.left = Math.max(12, Math.min(cx - tl - 6, 290)) + 'px';
        else arrow.style.top = Math.max(10, Math.min(cy - tt - 6, 130)) + 'px';
      }

      document.getElementById('mtourTitle').textContent = step.title;
      document.getElementById('mtourText').textContent = step.text;
      document.getElementById('mtourCounter').textContent = (idx + 1) + ' / ' + getMonitorTourSteps().length;
      document.getElementById('mtourPrev').style.display = idx === 0 ? 'none' : '';
      document.getElementById('mtourNext').textContent = idx === getMonitorTourSteps().length - 1 ? 'Done' : 'Next';
    });
  }));
}

function _setMOverlay(side, x, y, w, h) {
  const el = _mTourEls[side];
  if (!el) return;
  el.style.left = x + 'px'; el.style.top = y + 'px';
  el.style.width = Math.max(0, w) + 'px'; el.style.height = Math.max(0, h) + 'px';
}

// Monitor tour available via startMonitorTour() — not auto-started

// Cleanup on close
window.addEventListener('beforeunload', () => {
  if (window.electronAPI) {
    window.electronAPI.invoke('unwatch-log', { logPath: currentLogPath });
  }
});

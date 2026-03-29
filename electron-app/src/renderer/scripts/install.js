// Installation - Step Cards UI
// ---------------------------------------------------------------------------

const STEP_MAP = {
  install_nginx: { label: 'Installing Nginx (HTTPS)...', check: s => s.nginx },
  install_git: { label: 'Installing Git...', check: s => s.git },
  install_vscode: { label: 'Installing VS Code...', check: s => s.vscode },
  install_wkhtmltopdf: { label: 'Installing wkhtmltopdf...', check: s => s.wkhtmltopdf },
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
    showToastMessage(t('install.allInstalled'), 'success');
  } else {
    showToastMessage(t('install.installedCount', { installed, total }), installed > 0 ? 'info' : 'error');
  }

  if (btn) { btn.disabled = false; btn.textContent = t('install.checkStatus'); }
}

function appendInstallLog(line) {
  const logEl = $('installLogBox');
  const wrap = $('installLog');
  if (!logEl || !wrap) return;
  wrap.style.display = 'block';
  logEl.insertAdjacentHTML('beforeend', `<div class="line">${escHtml(line)}</div>`);
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

  // Check current status first — mark already-installed steps as done immediately
  await refreshStatus();
  for (const stepId of Object.keys(STEP_MAP)) {
    const st = _stepStates.get(stepId);
    if (st && st.state === 'running' && st.source === 'user') continue;
    const info = STEP_MAP[stepId];
    if (info.check && _status && info.check(_status)) {
      _stepStates.set(stepId, { state: 'done', source: 'full' });
      updateStepCard(stepId, 'done', t('install.installed'));
    } else {
      _stepStates.set(stepId, { state: 'idle', source: 'full' });
      updateStepCard(stepId, '', 'Pending');
    }
  }

  const res = await api('full_install', getFormData());

  if (!res.ok) {
    btn.disabled = false;
    btn.textContent = t('install.installAll');
    _fullInstallRunning = false;
    showToastMessage(t('toast.installFail', { msg: tMsg(res.msg) }), 'error');
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
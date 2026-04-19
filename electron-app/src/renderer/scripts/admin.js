// ============================================================
// Admin Dashboard — Password gate (opens separate window)
// ============================================================

/* global api */

// --- State ---
let _adminUnlocked = false;

// ============================================================
// Password Gate
// ============================================================

function showAdminPasswordModal() {
  const overlay = document.getElementById('adminPasswordOverlay');
  const input = document.getElementById('adminPasswordInput');
  const errEl = document.getElementById('adminPasswordError');
  if (!overlay || !input) return;
  overlay.classList.add('active');
  input.value = '';
  input.classList.remove('error');
  if (errEl) errEl.textContent = '';
  setTimeout(() => input.focus(), 100);
}

function hideAdminPasswordModal() {
  const overlay = document.getElementById('adminPasswordOverlay');
  if (overlay) overlay.classList.remove('active');
}

async function verifyAdminPassword() {
  const input = document.getElementById('adminPasswordInput');
  const errEl = document.getElementById('adminPasswordError');
  if (!input) return;

  const password = input.value;
  if (!password) {
    input.classList.add('error');
    if (errEl) errEl.textContent = 'Please enter password';
    return;
  }

  try {
    const result = await api('admin-verify-password', { password });
    if (result.ok) {
      _adminUnlocked = true;
      hideAdminPasswordModal();
      const dashAdminBtn = document.getElementById('dashAdminBtn');
      if (dashAdminBtn) dashAdminBtn.style.display = 'inline-flex';
      openAdminWindow();
    } else {
      input.classList.add('error');
      if (errEl) errEl.textContent = 'Incorrect password';
      setTimeout(() => input.classList.remove('error'), 400);
    }
  } catch (e) {
    if (errEl) errEl.textContent = 'Error: ' + e.message;
  }
}

function onAdminPasswordKeydown(e) {
  if (e.key === 'Enter') verifyAdminPassword();
  if (e.key === 'Escape') hideAdminPasswordModal();
}

function openAdminDashboard() {
  if (_adminUnlocked) {
    openAdminWindow();
  } else {
    showAdminPasswordModal();
  }
}

async function openAdminWindow() {
  // Gather theme settings from main window
  const r = document.documentElement;
  const preset = r.getAttribute('data-preset') || 'default';
  const mode = r.getAttribute('data-mode') || (document.body.classList.contains('light') ? 'light' : 'dark');
  const custom = r.style.cssText || '';

  try {
    await api('open-admin-window', {
      themePreset: preset,
      themeMode: mode,
      themeCustom: custom,
    });
  } catch (e) {
    console.error('[Admin] Failed to open window:', e);
  }
}

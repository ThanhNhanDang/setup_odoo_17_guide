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
    localStorage.setItem('mode', next);
    applyMode(next);
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

  localStorage.setItem('mode', next);
  const transition = document.startViewTransition(() => {
    applyMode(next);
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
  broadcastTheme();
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
  broadcastTheme();
}

/** Broadcast theme to all monitor windows */
function broadcastTheme() {
  if (window.electronAPI) {
    window.electronAPI.invoke('broadcast-theme', {
      preset: localStorage.getItem('preset') || 'default',
      mode: localStorage.getItem('mode') || 'dark',
      custom: localStorage.getItem('customColors') || '',
    });
  }
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
  broadcastTheme();
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
  showToastMessage('Colors reset to theme defaults', 'success');
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
      showToastMessage('Icon applied!', 'success');
    }
  } catch (e) {
    showToastMessage('Failed to upload icon: ' + e, 'error');
  }
}

async function resetIcon() {
  try {
    await window.electronAPI.invoke('reset-icon');
    await loadIconPreview();
    showToastMessage('Icon reset to default', 'success');
  } catch (e) {
    showToastMessage('Failed to reset icon: ' + e, 'error');
  }
}
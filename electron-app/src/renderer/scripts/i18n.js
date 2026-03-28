// ---------------------------------------------------------------------------
// i18n Engine — Zero-dependency internationalization
// Supports: en (English), vi (Vietnamese), ko (Korean)
// ---------------------------------------------------------------------------

let _translations = {};
let _fallback = {};
let _currentLang = 'en';

/** Get nested value from object by dot-path key */
function _getByPath(obj, path) {
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

/**
 * Translate a key. Supports {param} interpolation.
 * Falls back to English, then returns the key itself.
 */
function t(key, params) {
  let val = _getByPath(_translations, key);
  if (val === undefined) val = _getByPath(_fallback, key);
  if (val === undefined) return key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      val = val.replace(new RegExp('\\{' + k + '\\}', 'g'), v);
    }
  }
  return val;
}

/** Load a locale JSON file (local file, near-instant in Electron) */
async function _loadLocale(lang) {
  try {
    // Resolve path relative to the HTML file
    const resp = await fetch('locales/' + lang + '.json');
    if (!resp.ok) throw new Error(resp.status);
    return await resp.json();
  } catch (e) {
    console.warn('[i18n] Failed to load locale:', lang, e);
    return {};
  }
}

/** Get current language from localStorage */
function getCurrentLanguage() {
  try { return localStorage.getItem('lang') || 'en'; } catch { return 'en'; }
}

/** Initialize i18n — load translations */
async function initI18n(lang) {
  _currentLang = lang || getCurrentLanguage();
  // Always load English as fallback
  _fallback = await _loadLocale('en');
  if (_currentLang !== 'en') {
    _translations = await _loadLocale(_currentLang);
  } else {
    _translations = _fallback;
  }
  document.documentElement.setAttribute('lang', _currentLang);
}

/** Apply translations to all elements with data-i18n attributes */
function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const val = t(key);
    if (val !== key) el.textContent = val;
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    const key = el.getAttribute('data-i18n-html');
    const val = t(key);
    if (val !== key) el.innerHTML = val;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const val = t(key);
    if (val !== key) el.placeholder = val;
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    const val = t(key);
    if (val !== key) el.title = val;
  });
}

/** Switch language — save, reload translations, re-render UI */
async function setLanguage(lang) {
  try { localStorage.setItem('lang', lang); } catch {}
  // Persist to settings file so Monitor windows can read it
  if (window.electronAPI) {
    try {
      const res = await window.electronAPI.invoke('load-settings', {});
      const settings = res?.settings || {};
      settings.language = lang;
      await window.electronAPI.invoke('save-settings', settings);
    } catch {}
  }
  await initI18n(lang);
  applyTranslations();

  // Sync language selector
  const sel = document.getElementById('langSelect');
  if (sel) sel.value = lang;

  // Update language label in nav
  if (typeof updateLangLabel === 'function') updateLangLabel();

  // Force re-render dynamic panels
  if (typeof _helpRendered !== 'undefined') _helpRendered = false;
  if (typeof refreshStatus === 'function') refreshStatus();
  if (typeof renderHelpPanel === 'function') renderHelpPanel();
}

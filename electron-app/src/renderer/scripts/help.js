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
        <p>${escHtml(e.symptom)}</p>
        <div class="troubleshoot-label">${t('help.cause')}</div>
        <p>${escHtml(e.cause)}</p>
        <div class="troubleshoot-label">${t('help.solution')}</div>
        <p>${escHtml(e.solution)}</p>
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

// Load app version + saved settings + default paths (parallelized where possible)
if (window.electronAPI) {
  // app-version runs independently in parallel with the version→settings chain
  api('app-version').then(v => {
    const ver = 'v' + v;
    const el = document.querySelector('.nav-version');
    if (el) el.textContent = ver;
    if ($('settingsVersion')) $('settingsVersion').textContent = ver;
  });
  // versions → settings → defaults → refreshStatus (sequential chain, but version+appVersion parallel)
  loadOdooVersions().then(() => loadSettingsFromDisk()).then(() => {
    if (_odooVersions && $('odooVersion')?.value) {
      const ver = $('odooVersion').value;
      if ($('installVersion')) $('installVersion').value = ver;
    }
    const ver = $('odooVersion')?.value || '17';
    return api('default-paths', { odoo_version: ver });
  }).then(paths => {
    if ($('baseDir') && !$('baseDir').value) $('baseDir').value = paths.base_dir || '';
    if ($('projectsDir') && !$('projectsDir').value) $('projectsDir').value = paths.projects_dir || '';
  }).catch(() => {}).finally(() => {
    // Only call refreshStatus AFTER settings are loaded (so paths are correct)
    refreshStatus();
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

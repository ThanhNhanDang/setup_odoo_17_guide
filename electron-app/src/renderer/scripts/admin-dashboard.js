// ============================================================
// Admin Dashboard — Standalone Window Script
// Charts, table, realtime auto-refresh, time range filters
// With smooth animated data transitions
// ============================================================

/* global Chart */

const api = (channel, data) => window.electronAPI.invoke(channel, data);

// --- State ---
let _charts = {};
let _data = null;
let _currentRange = 'hour';
let _refreshTimer = null;
let _countdownTimer = null;
let _countdownValue = 30;
let _prevStats = null;       // For animated value transitions
let _isFirstLoad = true;

// --- Valid Odoo Versions (for filtering) ---
const VALID_ODOO_VERSIONS = ['15', '16', '17', '18', '19', '20'];

// ============================================================
// Initialization
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  loadDashboard();
  startAutoRefresh();

  // Listen for theme changes from main window
  window.electronAPI.onEvent('theme-changed', (data) => {
    const r = document.documentElement;
    if (data.preset && data.preset !== 'default') r.setAttribute('data-preset', data.preset);
    else r.removeAttribute('data-preset');
    if (data.mode === 'light') r.setAttribute('data-mode', 'light');
    else r.removeAttribute('data-mode');
    // If custom colors, apply them
    if (data.custom) {
      try {
        const c = JSON.parse(data.custom);
        Object.entries(c).forEach(([k, v]) => r.style.setProperty(k, v));
      } catch {}
    }
    // Re-render charts with new theme colors
    if (_data) {
      Object.values(_charts).forEach(c => { if (c) c.destroy(); });
      _charts = {};
      renderCharts(_data.logs || [], _data.users || []);
    }
  });

  // ML-4: Cleanup on window close — destroy charts, clear timers, remove listeners
  window.addEventListener('beforeunload', () => {
    stopAutoRefresh();
    Object.values(_charts).forEach(c => { if (c) { try { c.destroy(); } catch {} } });
    _charts = {};
    if (window.electronAPI) {
      window.electronAPI.removeAllListeners('theme-changed');
    }
  });
});

// ============================================================
// Time Range Filters
// ============================================================

function setTimeRange(range, btn) {
  _currentRange = range;
  // Update active button
  document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  loadDashboard();
  resetCountdown();
}

function getDateRange() {
  const now = new Date();
  let from;
  switch (_currentRange) {
    case 'hour':
      from = new Date(now.getTime() - 60 * 60 * 1000);
      break;
    case 'day':
      from = new Date(now);
      from.setHours(0, 0, 0, 0);
      break;
    case 'week':
      from = new Date(now);
      from.setDate(from.getDate() - from.getDay()); // start of week (Sunday)
      from.setHours(0, 0, 0, 0);
      break;
    case 'month':
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'year':
      from = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      from = new Date(now.getTime() - 60 * 60 * 1000);
  }
  return { dateFrom: from.toISOString(), dateTo: now.toISOString() };
}

// ============================================================
// Auto-Refresh (30 seconds) with Ring Progress
// ============================================================

function startAutoRefresh() {
  stopAutoRefresh();
  _countdownValue = 30;
  updateRingProgress();

  _refreshTimer = setInterval(() => {
    loadDashboard();
    _countdownValue = 30;
  }, 30000);

  _countdownTimer = setInterval(() => {
    _countdownValue = Math.max(0, _countdownValue - 1);
    const el = document.getElementById('refreshCountdown');
    if (el) el.textContent = `${_countdownValue}s`;
    updateRingProgress();
  }, 1000);
}

function stopAutoRefresh() {
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
  if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
}

function resetCountdown() {
  _countdownValue = 30;
  const el = document.getElementById('refreshCountdown');
  if (el) el.textContent = '30s';
  updateRingProgress();
}

function updateRingProgress() {
  const ring = document.getElementById('ringProgress');
  if (!ring) return;
  // 0 = full circle, 100 = empty
  const offset = ((30 - _countdownValue) / 30) * 100;
  ring.style.strokeDashoffset = offset;
}

function manualRefresh() {
  const btn = document.querySelector('.btn-refresh');
  if (btn) btn.classList.add('spinning');
  // Add a pulse effect to the whole dashboard
  const content = document.getElementById('dashContent');
  if (content) content.classList.add('refreshing');
  loadDashboard().then(() => {
    if (btn) setTimeout(() => btn.classList.remove('spinning'), 600);
    if (content) setTimeout(() => content.classList.remove('refreshing'), 600);
  });
  resetCountdown();
  // Restart the 30s timer
  startAutoRefresh();
}

// ============================================================
// Data Loading
// ============================================================

async function loadDashboard() {
  const container = document.getElementById('dashContent');
  if (!container) return;

  // Only show loading on first load
  if (!_data) {
    container.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <span>Loading analytics data...</span>
      </div>`;
  }

  try {
    const { dateFrom, dateTo } = getDateRange();
    const result = await api('fetch-admin-stats', { dateFrom, dateTo });

    if (!result.ok) {
      if (!_data) {
        container.innerHTML = `<div class="no-data">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
          <span>Failed to load data. Check connection.</span>
        </div>`;
      }
      return;
    }

    _data = result.data;
    renderDashboard(_data);
  } catch (e) {
    if (!_data) {
      container.innerHTML = `<div class="no-data"><span>Error: ${e.message}</span></div>`;
    }
  }
}

// ============================================================
// Dashboard Rendering (with animated transitions)
// ============================================================

function renderDashboard(data) {
  const container = document.getElementById('dashContent');
  if (!container || !data) return;

  const logs = data.logs || [];
  const users = data.users || [];

  // Stats
  const uniqueUsers = new Set(logs.map(l => l.machine_id)).size;
  const uniqueProjects = new Set(
    logs.map(l => l.details?.name || l.details?.project || l.details?.source).filter(Boolean)
  ).size;
  const odooVersions = new Set(
    logs.map(l => l.details?.version).filter(v => v && VALID_ODOO_VERSIONS.includes(String(v)))
  ).size;

  const rangeLabel = {
    hour: 'This Hour',
    day: 'Today',
    week: 'This Week',
    month: 'This Month',
    year: 'This Year'
  }[_currentRange] || 'Selected';

  const newStats = {
    users: uniqueUsers,
    actions: logs.length,
    projects: uniqueProjects,
    versions: odooVersions
  };

  // Check if dashboard skeleton already exists (for animated updates)
  const existingGrid = container.querySelector('.stats-grid');
  if (existingGrid && !_isFirstLoad) {
    // Animate stat card values
    animateStatCards(newStats, rangeLabel);
    // Update charts with animation
    updateChartsAnimated(logs, users);
    // Update table with crossfade
    renderTable(logs, users);
  } else {
    // First render: build the full skeleton
    _isFirstLoad = false;
    container.innerHTML = `
      <!-- Stats Cards -->
      <div class="stats-grid">
        <div class="stat-card card-users animate-in" style="--delay:0">
          <div class="stat-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          </div>
          <div class="stat-info">
            <div class="stat-label">Active Users</div>
            <div class="stat-value" id="statUsers">${uniqueUsers}</div>
            <div class="stat-sub" id="statUsersSub">${rangeLabel}</div>
          </div>
        </div>
        <div class="stat-card card-actions animate-in" style="--delay:1">
          <div class="stat-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22,12 18,12 15,21 9,3 6,12 2,12"/></svg>
          </div>
          <div class="stat-info">
            <div class="stat-label">Total Actions</div>
            <div class="stat-value" id="statActions">${logs.length}</div>
            <div class="stat-sub" id="statActionsSub">${rangeLabel}</div>
          </div>
        </div>
        <div class="stat-card card-today animate-in" style="--delay:2">
          <div class="stat-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          </div>
          <div class="stat-info">
            <div class="stat-label">Projects</div>
            <div class="stat-value" id="statProjects">${uniqueProjects}</div>
            <div class="stat-sub" id="statProjectsSub">Active projects</div>
          </div>
        </div>
        <div class="stat-card card-versions animate-in" style="--delay:3">
          <div class="stat-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
          </div>
          <div class="stat-info">
            <div class="stat-label">Odoo Versions</div>
            <div class="stat-value" id="statVersions">${odooVersions}</div>
            <div class="stat-sub" id="statVersionsSub">In use</div>
          </div>
        </div>
      </div>

      <!-- Charts -->
      <div class="charts-grid">
        <div class="chart-card full-width animate-in" style="--delay:4">
          <h4>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22,12 18,12 15,21 9,3 6,12 2,12"/></svg>
            Activity Timeline
          </h4>
          <canvas id="chartTimeline" height="180"></canvas>
        </div>
        <div class="chart-card animate-in" style="--delay:5">
          <h4>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
            Top Actions
          </h4>
          <canvas id="chartActions" height="200"></canvas>
        </div>
        <div class="chart-card animate-in" style="--delay:6">
          <h4>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 1 0 20"/><path d="M12 2v10l7 7"/></svg>
            Action Distribution
          </h4>
          <canvas id="chartDistribution" height="200"></canvas>
        </div>
        <div class="chart-card animate-in" style="--delay:7">
          <h4>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            Users
          </h4>
          <canvas id="chartUsers" height="200"></canvas>
        </div>
        <div class="chart-card animate-in" style="--delay:8">
          <h4>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
            Odoo Versions
          </h4>
          <canvas id="chartVersions" height="200"></canvas>
        </div>
      </div>

      <!-- Recent Activity Table -->
      <div class="table-card animate-in" style="--delay:9">
        <h4>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>
          Recent Activity
        </h4>
        <div class="table-wrap">
          <table class="activity-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>User</th>
                <th>Action</th>
                <th>Project</th>
                <th>Version</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody id="activityTableBody"></tbody>
          </table>
        </div>
      </div>
    `;

    renderCharts(logs, users);
    renderTable(logs, users);
  }

  _prevStats = newStats;
}

// ============================================================
// Animated Stat Card Updates
// ============================================================

function animateStatCards(newStats, rangeLabel) {
  const cards = [
    { id: 'statUsers', subId: 'statUsersSub', key: 'users', subText: rangeLabel },
    { id: 'statActions', subId: 'statActionsSub', key: 'actions', subText: rangeLabel },
    { id: 'statProjects', subId: 'statProjectsSub', key: 'projects', subText: 'Active projects' },
    { id: 'statVersions', subId: 'statVersionsSub', key: 'versions', subText: 'In use' },
  ];

  cards.forEach(({ id, subId, key, subText }) => {
    const el = document.getElementById(id);
    const subEl = document.getElementById(subId);
    if (!el) return;

    const oldVal = _prevStats ? _prevStats[key] : 0;
    const newVal = newStats[key];

    if (subEl) subEl.textContent = subText;

    if (oldVal !== newVal) {
      // Animate number counting
      animateNumber(el, oldVal, newVal, 600);
      // Add a pulse highlight
      const card = el.closest('.stat-card');
      if (card) {
        card.classList.add('value-changed');
        setTimeout(() => card.classList.remove('value-changed'), 800);
      }
    }
  });
}

function animateNumber(el, from, to, duration) {
  const start = performance.now();
  const diff = to - from;

  function tick(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    // Ease out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(from + diff * eased);
    el.textContent = current.toLocaleString();
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ============================================================
// Chart Rendering (with smooth transitions on update)
// ============================================================

function getChartColors() {
  const style = getComputedStyle(document.documentElement);
  return {
    accent: style.getPropertyValue('--accent')?.trim() || '#f0883e',
    textPrimary: style.getPropertyValue('--text-primary')?.trim() || '#e6edf3',
    textSecondary: style.getPropertyValue('--text-secondary')?.trim() || '#8b949e',
    textTertiary: style.getPropertyValue('--text-tertiary')?.trim() || '#6e7681',
    borderMuted: style.getPropertyValue('--border-muted')?.trim() || '#30363d',
    bgSurface: style.getPropertyValue('--bg-surface')?.trim() || '#161b22',
  };
}

function updateChartsAnimated(logs, users) {
  // Instead of destroying and re-creating, update data for smooth transitions
  const colors = getChartColors();

  if (_charts.timeline) {
    const { labels, data } = getTimelineLabelsAndBuckets(logs);
    _charts.timeline.data.labels = labels;
    _charts.timeline.data.datasets[0].data = data;
    _charts.timeline.update('active'); // smooth animation
  } else {
    renderTimelineChart(logs, colors);
  }

  if (_charts.actions) {
    const actionCounts = {};
    logs.forEach(l => { const t = l.action_type || 'UNKNOWN'; actionCounts[t] = (actionCounts[t] || 0) + 1; });
    const sorted = Object.entries(actionCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    _charts.actions.data.labels = sorted.map(s => formatActionType(s[0]));
    _charts.actions.data.datasets[0].data = sorted.map(s => s[1]);
    _charts.actions.update('active');
  } else {
    renderActionsChart(logs, colors);
  }

  if (_charts.distribution) {
    const actionCounts = {};
    logs.forEach(l => { const t = l.action_type || 'UNKNOWN'; actionCounts[t] = (actionCounts[t] || 0) + 1; });
    const entries = Object.entries(actionCounts).sort((a, b) => b[1] - a[1]);
    _charts.distribution.data.labels = entries.map(e => formatActionType(e[0]));
    _charts.distribution.data.datasets[0].data = entries.map(e => e[1]);
    _charts.distribution.update('active');
  } else {
    renderDistributionChart(logs, colors);
  }

  if (_charts.users) {
    const userActions = {};
    logs.forEach(l => { const mid = l.machine_id || 'unknown'; userActions[mid] = (userActions[mid] || 0) + 1; });
    const userMap = {};
    users.forEach(u => { userMap[u.machine_id] = formatUserLabel(u.machine_id, u.os_username); });
    const sorted = Object.entries(userActions).sort((a, b) => b[1] - a[1]).slice(0, 10);
    _charts.users.data.labels = sorted.map(s => userMap[s[0]] || formatUserLabel(s[0], null));
    _charts.users.data.datasets[0].data = sorted.map(s => s[1]);
    _charts.users.update('active');
  } else {
    renderUsersChart(logs, users, colors);
  }

  if (_charts.versions) {
    const versionCounts = {};
    logs.forEach(l => {
      if (l.details && l.details.version) {
        const v = String(l.details.version);
        if (VALID_ODOO_VERSIONS.includes(v)) {
          const label = 'Odoo ' + v;
          versionCounts[label] = (versionCounts[label] || 0) + 1;
        }
      }
    });
    const entries = Object.entries(versionCounts).sort((a, b) => b[1] - a[1]);
    _charts.versions.data.labels = entries.length > 0 ? entries.map(e => e[0]) : ['No Data'];
    _charts.versions.data.datasets[0].data = entries.length > 0 ? entries.map(e => e[1]) : [1];
    _charts.versions.update('active');
  } else {
    renderVersionsChart(logs, colors);
  }
}

function renderCharts(logs, users) {
  Object.values(_charts).forEach(c => { if (c) c.destroy(); });
  _charts = {};

  if (typeof Chart === 'undefined') return;

  const colors = getChartColors();
  Chart.defaults.color = colors.textTertiary;
  Chart.defaults.borderColor = colors.borderMuted;
  Chart.defaults.font.family = "'Inter', 'Segoe UI', sans-serif";
  Chart.defaults.font.size = 11;

  renderTimelineChart(logs, colors);
  renderActionsChart(logs, colors);
  renderDistributionChart(logs, colors);
  renderUsersChart(logs, users, colors);
  renderVersionsChart(logs, colors);
}

function getTimelineLabelsAndBuckets(logs) {
  const now = new Date();
  const labels = [];
  const bucketMap = {};

  if (_currentRange === 'hour') {
    // Last 60 minutes, bucketed by 5-min intervals
    for (let i = 11; i >= 0; i--) {
      const t = new Date(now.getTime() - i * 5 * 60000);
      const key = `${String(t.getHours()).padStart(2, '0')}:${String(Math.floor(t.getMinutes() / 5) * 5).padStart(2, '0')}`;
      labels.push(key);
      bucketMap[key] = 0;
    }
    logs.forEach(l => {
      const d = new Date(l.created_at);
      const key = `${String(d.getHours()).padStart(2, '0')}:${String(Math.floor(d.getMinutes() / 5) * 5).padStart(2, '0')}`;
      if (key in bucketMap) bucketMap[key]++;
    });
  } else if (_currentRange === 'day') {
    // 24 hours
    for (let i = 0; i < 24; i++) {
      const key = `${String(i).padStart(2, '0')}:00`;
      labels.push(key);
      bucketMap[key] = 0;
    }
    logs.forEach(l => {
      const d = new Date(l.created_at);
      const key = `${String(d.getHours()).padStart(2, '0')}:00`;
      if (key in bucketMap) bucketMap[key]++;
    });
  } else if (_currentRange === 'week') {
    // 7 days
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      labels.push(dayNames[d.getDay()] + ' ' + d.getDate());
      bucketMap[key] = 0;
    }
    logs.forEach(l => {
      const key = l.created_at?.split('T')[0];
      if (key in bucketMap) bucketMap[key]++;
    });
  } else if (_currentRange === 'month') {
    // Days in current month
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    for (let i = 1; i <= daysInMonth; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), i);
      const key = d.toISOString().split('T')[0];
      labels.push(String(i));
      bucketMap[key] = 0;
    }
    logs.forEach(l => {
      const key = l.created_at?.split('T')[0];
      if (key in bucketMap) bucketMap[key]++;
    });
  } else if (_currentRange === 'year') {
    // 12 months
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    for (let i = 0; i < 12; i++) {
      const key = `${now.getFullYear()}-${String(i + 1).padStart(2, '0')}`;
      labels.push(monthNames[i]);
      bucketMap[key] = 0;
    }
    logs.forEach(l => {
      if (!l.created_at) return;
      const d = new Date(l.created_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (key in bucketMap) bucketMap[key]++;
    });
  }

  return { labels, data: Object.values(bucketMap) };
}

function renderTimelineChart(logs, colors) {
  const ctx = document.getElementById('chartTimeline')?.getContext('2d');
  if (!ctx) return;

  const { labels, data } = getTimelineLabelsAndBuckets(logs);

  // Create gradient
  const gradient = ctx.createLinearGradient(0, 0, 0, 180);
  gradient.addColorStop(0, colors.accent + '40');
  gradient.addColorStop(1, colors.accent + '05');

  _charts.timeline = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Events',
        data,
        borderColor: colors.accent,
        backgroundColor: gradient,
        fill: true,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6,
        pointBackgroundColor: colors.accent,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 800, easing: 'easeOutCubic' },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => items[0]?.label || '',
            label: (item) => `${item.raw} events`,
          },
        },
      },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, ticks: { precision: 0 } },
      },
    },
  });
}

function renderActionsChart(logs, colors) {
  const ctx = document.getElementById('chartActions')?.getContext('2d');
  if (!ctx) return;

  const actionCounts = {};
  logs.forEach(l => {
    const t = l.action_type || 'UNKNOWN';
    actionCounts[t] = (actionCounts[t] || 0) + 1;
  });

  const sorted = Object.entries(actionCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const barColors = ['#58a6ff', '#f0883e', '#3fb950', '#bc8cff', '#f85149', '#d29922', '#38bdf8', '#fbbf24'];

  _charts.actions = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sorted.map(s => formatActionType(s[0])),
      datasets: [{
        label: 'Count',
        data: sorted.map(s => s[1]),
        backgroundColor: sorted.map((_, i) => barColors[i % barColors.length] + '99'),
        borderColor: sorted.map((_, i) => barColors[i % barColors.length]),
        borderWidth: 1,
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 800, easing: 'easeOutCubic' },
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, ticks: { precision: 0 } },
      },
    },
  });
}

function renderDistributionChart(logs, colors) {
  const ctx = document.getElementById('chartDistribution')?.getContext('2d');
  if (!ctx) return;

  const actionCounts = {};
  logs.forEach(l => {
    const t = l.action_type || 'UNKNOWN';
    actionCounts[t] = (actionCounts[t] || 0) + 1;
  });

  const entries = Object.entries(actionCounts).sort((a, b) => b[1] - a[1]);
  const pieColors = ['#58a6ff', '#f0883e', '#3fb950', '#bc8cff', '#f85149', '#d29922', '#38bdf8', '#fbbf24', '#a5d6ff', '#ffc680'];

  _charts.distribution = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: entries.map(e => formatActionType(e[0])),
      datasets: [{
        data: entries.map(e => e[1]),
        backgroundColor: entries.map((_, i) => pieColors[i % pieColors.length] + 'cc'),
        borderColor: colors.bgSurface,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 800, easing: 'easeOutCubic', animateRotate: true },
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 12, padding: 8, font: { size: 10 } } },
      },
    },
  });
}

function renderUsersChart(logs, users, colors) {
  const ctx = document.getElementById('chartUsers')?.getContext('2d');
  if (!ctx) return;

  const userActions = {};
  logs.forEach(l => {
    const mid = l.machine_id || 'unknown';
    userActions[mid] = (userActions[mid] || 0) + 1;
  });

  const userMap = {};
  users.forEach(u => { userMap[u.machine_id] = formatUserLabel(u.machine_id, u.os_username); });

  const sorted = Object.entries(userActions).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const uColors = ['#58a6ff', '#3fb950', '#f0883e', '#bc8cff', '#f85149', '#d29922', '#38bdf8', '#fbbf24'];

  _charts.users = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sorted.map(s => userMap[s[0]] || formatUserLabel(s[0], null)),
      datasets: [{
        label: 'Actions',
        data: sorted.map(s => s[1]),
        backgroundColor: sorted.map((_, i) => uColors[i % uColors.length] + '88'),
        borderColor: sorted.map((_, i) => uColors[i % uColors.length]),
        borderWidth: 1,
        borderRadius: 6,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 800, easing: 'easeOutCubic' },
      plugins: { legend: { display: false } },
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0 } },
        y: { grid: { display: false } },
      },
    },
  });
}

function renderVersionsChart(logs, colors) {
  const ctx = document.getElementById('chartVersions')?.getContext('2d');
  if (!ctx) return;

  // Only count VALID Odoo versions (15, 17, 18, 19...), skip app versions like 1.13.10
  const versionCounts = {};
  logs.forEach(l => {
    if (l.details && l.details.version) {
      const v = String(l.details.version);
      if (VALID_ODOO_VERSIONS.includes(v)) {
        const label = 'Odoo ' + v;
        versionCounts[label] = (versionCounts[label] || 0) + 1;
      }
    }
  });

  const entries = Object.entries(versionCounts).sort((a, b) => b[1] - a[1]);
  const vColors = ['#bc8cff', '#58a6ff', '#3fb950', '#f0883e', '#f85149'];

  _charts.versions = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: entries.length > 0 ? entries.map(e => e[0]) : ['No Data'],
      datasets: [{
        data: entries.length > 0 ? entries.map(e => e[1]) : [1],
        backgroundColor: entries.length > 0 ? entries.map((_, i) => vColors[i % vColors.length] + 'cc') : [colors.borderMuted],
        borderColor: colors.bgSurface,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 800, easing: 'easeOutCubic', animateRotate: true },
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 12, padding: 8, font: { size: 10 } } },
      },
    },
  });
}

// ============================================================
// Table Rendering
// ============================================================

function renderTable(logs, users) {
  const tbody = document.getElementById('activityTableBody');
  if (!tbody) return;

  const userMap = {};
  if (users) {
    users.forEach(u => { userMap[u.machine_id] = formatUserLabel(u.machine_id, u.os_username); });
  }

  const recent = logs.slice(0, 100);
  if (recent.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-tertiary);padding:24px">No activity in this time range</td></tr>';
    return;
  }

  const newHtml = recent.map((log, idx) => {
    const time = formatTimeAgo(log.created_at);
    // Prefer formatting from the log's joined machine, fallback to userMap, fallback to raw machine_id
    let user = log.machine_id ? formatUserLabel(log.machine_id, null) : '—';
    if (log.users_machine?.os_username) user = formatUserLabel(log.machine_id, log.users_machine.os_username);
    else if (userMap[log.machine_id]) user = userMap[log.machine_id];
    const actionClass = getActionBadgeClass(log.action_type);
    const actionLabel = formatActionType(log.action_type);

    let details = '—';
    if (log.details && Object.keys(log.details).length > 0) {
      details = Object.entries(log.details).map(([k, v]) => `${k}: ${v}`).join(', ');
    }

    let projectName = log.details?.name || log.details?.project || log.details?.source;
    if (!projectName && log.action_type === 'PROJECT_DUPLICATED') projectName = log.details?.target;
    !projectName && (projectName = '—');

    // Show Odoo version (skip app versions like 1.13.10)
    let versionStr = '—';
    if (log.details?.version && VALID_ODOO_VERSIONS.includes(String(log.details.version))) {
      versionStr = `Odoo ${log.details.version}`;
    } else if (log.details?.app_version) {
      versionStr = `v${log.details.app_version}`;
    }

    return `<tr class="row-animate" style="--row-delay:${idx}">
      <td title="${new Date(log.created_at).toLocaleString()}">${time}</td>
      <td>${escapeHtml(user)}</td>
      <td><span class="action-badge ${actionClass}">${actionLabel}</span></td>
      <td style="font-weight:600;color:var(--text-secondary)">${escapeHtml(projectName)}</td>
      <td><span class="version-badge">${escapeHtml(versionStr)}</span></td>
      <td class="detail-json" title="${escapeHtml(details)}">${escapeHtml(details)}</td>
    </tr>`;
  }).join('');

  // Crossfade table rows
  tbody.style.opacity = '0';
  tbody.style.transform = 'translateY(4px)';
  setTimeout(() => {
    tbody.innerHTML = newHtml;
    tbody.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
    tbody.style.opacity = '1';
    tbody.style.transform = 'translateY(0)';
  }, 100);
}

// ============================================================
// Helpers
// ============================================================

function formatActionType(type) {
  const map = {
    'APP_LAUNCHED': 'App Launch',
    'PROJECT_CREATED': 'Create Project',
    'PROJECT_DELETED': 'Delete Project',
    'PROJECT_DUPLICATED': 'Duplicate',
    'ODOO_STARTED': 'Start Odoo',
    'ODOO_STOPPED': 'Stop Odoo',
    'FULL_INSTALL_STARTED': 'Install Start',
    'FULL_INSTALL_COMPLETED': 'Install Done',
    'STEP_RUN': 'Step Run',
    'SETTINGS_SAVED': 'Settings',
  };
  return map[type] || type;
}

function getActionBadgeClass(type) {
  const map = {
    'APP_LAUNCHED': 'act-launch',
    'PROJECT_CREATED': 'act-create',
    'PROJECT_DELETED': 'act-delete',
    'PROJECT_DUPLICATED': 'act-dup',
    'ODOO_STARTED': 'act-start',
    'ODOO_STOPPED': 'act-stop',
    'FULL_INSTALL_STARTED': 'act-install',
    'FULL_INSTALL_COMPLETED': 'act-install',
    'STEP_RUN': 'act-step',
    'SETTINGS_SAVED': 'act-settings',
  };
  return map[type] || '';
}

function formatTimeAgo(isoString) {
  if (!isoString) return '—';
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diff = now - then;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;

  const d = new Date(isoString);
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatUserLabel(machineId, osUsername) {
  if (!machineId) return 'unknown';
  if (osUsername) return `${osUsername} (${String(machineId).substring(0, 4)})`;
  return String(machineId).substring(0, 8);
}

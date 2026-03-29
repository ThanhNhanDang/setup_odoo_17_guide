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
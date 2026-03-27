// ---------------------------------------------------------------------------
// Guided Tour Engine — Custom spotlight overlay with tooltip navigation
// Zero dependencies. Uses TOUR_STEPS from docs-data.js.
// ---------------------------------------------------------------------------

let _tourActive = false;
let _tourStep = 0;
let _tourEls = {};      // overlay + tooltip DOM elements
let _tourPrevHighlight = null;

function startTour() {
  if (_tourActive) return;
  _tourActive = true;
  _tourStep = 0;

  // Create overlay panels (top, bottom, left, right)
  const container = document.createElement('div');
  container.id = 'tourContainer';
  for (const side of ['top', 'bottom', 'left', 'right']) {
    const el = document.createElement('div');
    el.className = 'tour-overlay';
    el.id = 'tourOverlay-' + side;
    container.appendChild(el);
    _tourEls[side] = el;
  }

  // Create tooltip
  const tooltip = document.createElement('div');
  tooltip.className = 'tour-tooltip';
  tooltip.id = 'tourTooltip';
  tooltip.innerHTML = `
    <div class="tour-tooltip-arrow" id="tourArrow"></div>
    <div class="tour-tooltip-title" id="tourTitle"></div>
    <div class="tour-tooltip-text" id="tourText"></div>
    <div class="tour-tooltip-footer">
      <span class="tour-tooltip-counter" id="tourCounter"></span>
      <div class="tour-tooltip-btns">
        <button class="tour-btn-skip" onclick="endTour()">Skip</button>
        <button class="tour-btn-prev" id="tourBtnPrev" onclick="prevTourStep()">Prev</button>
        <button class="tour-btn-next" id="tourBtnNext" onclick="nextTourStep()">Next</button>
      </div>
    </div>
  `;
  container.appendChild(tooltip);
  _tourEls.tooltip = tooltip;
  _tourEls.container = container;

  document.body.appendChild(container);

  // Click overlay to advance
  for (const side of ['top', 'bottom', 'left', 'right']) {
    _tourEls[side].addEventListener('click', nextTourStep);
  }

  // Keyboard navigation
  window.addEventListener('keydown', _tourKeyHandler);
  window.addEventListener('resize', _tourResizeHandler);

  goToTourStep(0);
}

function endTour() {
  if (!_tourActive) return;
  _tourActive = false;

  // Remove highlight from previous element
  if (_tourPrevHighlight) {
    _tourPrevHighlight.classList.remove('tour-highlight');
    _tourPrevHighlight = null;
  }

  // Remove all tour elements
  if (_tourEls.container) {
    _tourEls.container.remove();
  }
  _tourEls = {};

  window.removeEventListener('keydown', _tourKeyHandler);
  window.removeEventListener('resize', _tourResizeHandler);

  // Mark tour as completed
  try { localStorage.setItem('tour_completed', '1'); } catch {}
}

function nextTourStep() {
  if (_tourStep < TOUR_STEPS.length - 1) {
    goToTourStep(_tourStep + 1);
  } else {
    endTour();
  }
}

function prevTourStep() {
  if (_tourStep > 0) {
    goToTourStep(_tourStep - 1);
  }
}

function goToTourStep(index) {
  const step = TOUR_STEPS[index];
  if (!step) { endTour(); return; }
  _tourStep = index;

  // Switch panel if needed
  if (step.panelBefore && typeof showPanel === 'function') {
    // Find the nav tab for this panel
    const tabs = document.querySelectorAll('.nav-tab');
    for (const tab of tabs) {
      if (tab.textContent.trim().toLowerCase().includes(step.panelBefore)) {
        showPanel(step.panelBefore, tab);
        break;
      }
    }
    // Fallback: just show the panel
    showPanel(step.panelBefore);
  }

  // Small delay to let panel render
  setTimeout(() => _positionTourStep(step, index), step.panelBefore ? 150 : 0);
}

function _positionTourStep(step, index) {
  // Remove previous highlight
  if (_tourPrevHighlight) {
    _tourPrevHighlight.classList.remove('tour-highlight');
    _tourPrevHighlight = null;
  }

  // Find target element
  const target = document.querySelector(step.selector);
  if (!target) {
    // Skip to next step if element not found
    if (index < TOUR_STEPS.length - 1) {
      goToTourStep(index + 1);
    } else {
      endTour();
    }
    return;
  }

  // Scroll into view
  target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Wait for scroll to finish
  setTimeout(() => {
    const rect = target.getBoundingClientRect();
    const pad = 8;
    const W = window.innerWidth;
    const H = window.innerHeight;

    // Position four overlay panels around the target
    const top = Math.max(0, rect.top - pad);
    const left = Math.max(0, rect.left - pad);
    const bottom = Math.min(H, rect.bottom + pad);
    const right = Math.min(W, rect.right + pad);

    _setOverlay('top', 0, 0, W, top);
    _setOverlay('bottom', 0, bottom, W, H - bottom);
    _setOverlay('left', 0, top, left, bottom - top);
    _setOverlay('right', right, top, W - right, bottom - top);

    // Highlight target
    target.classList.add('tour-highlight');
    _tourPrevHighlight = target;

    // Position tooltip
    _positionTooltip(step, rect);

    // Update content
    document.getElementById('tourTitle').textContent = step.title;
    document.getElementById('tourText').textContent = step.text;
    document.getElementById('tourCounter').textContent = (index + 1) + ' / ' + TOUR_STEPS.length;

    // Prev button visibility
    document.getElementById('tourBtnPrev').style.display = index === 0 ? 'none' : '';
    document.getElementById('tourBtnNext').textContent = index === TOUR_STEPS.length - 1 ? 'Done' : 'Next';

    // Animate tooltip in
    const tooltip = _tourEls.tooltip;
    tooltip.classList.remove('visible');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        tooltip.classList.add('visible');
      });
    });
  }, 200);
}

function _setOverlay(side, x, y, w, h) {
  const el = _tourEls[side];
  if (!el) return;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.width = Math.max(0, w) + 'px';
  el.style.height = Math.max(0, h) + 'px';
}

function _positionTooltip(step, rect) {
  const tooltip = _tourEls.tooltip;
  const arrow = document.getElementById('tourArrow');
  const pos = step.position || 'bottom';
  const gap = 16;

  tooltip.setAttribute('data-pos', pos);

  // Reset
  tooltip.style.left = '';
  tooltip.style.top = '';
  tooltip.style.right = '';
  tooltip.style.bottom = '';

  const W = window.innerWidth;
  const H = window.innerHeight;

  let tooltipLeft, tooltipTop;

  switch (pos) {
    case 'bottom':
      tooltipTop = rect.bottom + gap;
      tooltipLeft = Math.max(12, Math.min(rect.left, W - 380));
      break;
    case 'top':
      tooltipTop = rect.top - gap - 180; // estimate tooltip height
      tooltipLeft = Math.max(12, Math.min(rect.left, W - 380));
      break;
    case 'left':
      tooltipTop = rect.top;
      tooltipLeft = rect.left - gap - 370;
      break;
    case 'right':
      tooltipTop = rect.top;
      tooltipLeft = rect.right + gap;
      break;
  }

  // Clamp to viewport
  tooltipLeft = Math.max(12, Math.min(tooltipLeft, W - 380));
  tooltipTop = Math.max(12, Math.min(tooltipTop, H - 200));

  tooltip.style.left = tooltipLeft + 'px';
  tooltip.style.top = tooltipTop + 'px';
}

function _tourKeyHandler(e) {
  if (!_tourActive) return;
  if (e.key === 'Escape') { endTour(); e.preventDefault(); }
  if (e.key === 'ArrowRight' || e.key === 'Enter') { nextTourStep(); e.preventDefault(); }
  if (e.key === 'ArrowLeft') { prevTourStep(); e.preventDefault(); }
}

let _tourResizeTimer = null;
function _tourResizeHandler() {
  if (!_tourActive) return;
  clearTimeout(_tourResizeTimer);
  _tourResizeTimer = setTimeout(() => {
    goToTourStep(_tourStep);
  }, 200);
}

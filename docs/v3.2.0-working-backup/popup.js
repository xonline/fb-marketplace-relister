'use strict';

// ── Element refs ──────────────────────────────────────────────────────────────

const dot            = document.getElementById('dot');
const pillLabel      = document.getElementById('pill-label');
const pageIcon       = document.getElementById('page-icon');
const pageTitle      = document.getElementById('page-title');
const pageHint       = document.getElementById('page-hint');
const ctaWrap        = document.getElementById('cta-wrap');
const ctaBtn         = document.getElementById('cta-btn');
const opIcon         = document.getElementById('op-icon');
const opMsg          = document.getElementById('op-msg');
const opTime         = document.getElementById('op-time');
const newListingLink = document.getElementById('new-listing-link');
const statsBar       = document.getElementById('stats-bar');
const stepsWrap      = document.getElementById('steps-wrap');
const stepsBar       = document.getElementById('steps-bar');
const btnClear       = document.getElementById('btn-clear');
const cacheInfo      = document.getElementById('cache-info');

const STEP_IDS    = ['s0', 's1', 's2', 's3', 's4'];
const SELLING_URL = 'https://www.facebook.com/marketplace/you/selling?state=LIVE&status[0]=IN_STOCK';

// ── SVG icons ─────────────────────────────────────────────────────────────────

const ICONS = {
  check: `<svg width="13" height="13" viewBox="0 0 20 20" fill="none"><path d="M4 10.5l4.5 4.5 7.5-9" stroke="#22C55E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  x:     `<svg width="13" height="13" viewBox="0 0 20 20" fill="none"><path d="M5 5l10 10M15 5L5 15" stroke="#EF4444" stroke-width="2" stroke-linecap="round"/></svg>`,
  spin:  `<svg width="13" height="13" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="#F59E0B" stroke-width="1.5" stroke-dasharray="22 22" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" values="0 10 10;360 10 10" dur="1s" repeatCount="indefinite"/></circle></svg>`,
  idle:  `<svg width="13" height="13" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="#475569" stroke-width="1.5"/></svg>`,
  store: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M3 9.5V17h14V9.5M1 6.5l1.5-4h15L19 6.5" stroke="#22C55E" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 17v-5h6v5" stroke="#22C55E" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  globe: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="#64748B" stroke-width="1.5"/><path d="M10 2c0 0-3 3.5-3 8s3 8 3 8M10 2c0 0 3 3.5 3 8s-3 8-3 8M2 10h16" stroke="#64748B" stroke-width="1.5" stroke-linecap="round"/></svg>`,
};

// ── Status parsing ────────────────────────────────────────────────────────────

function classifyStatus(msg) {
  if (!msg) return 'idle';
  if (msg.startsWith('Error') || msg.startsWith('error')) return 'error';
  if (msg.startsWith('Relisted') || msg.startsWith('Done')) return 'success';
  return 'busy';
}

function detectStep(msg) {
  if (!msg) return -1;
  const lower = msg.toLowerCase();
  if (lower.includes('loading')) return 0;
  if (lower.includes('reading')) return 1;
  if (lower.includes('posting')) return 2;
  if (lower.includes('deleting')) return 3;
  if (lower.includes('done') || lower.includes('relisted')) return 4;
  return -1;
}

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Math.round((Date.now() - ts) / 1000);
  if (diff < 5)    return 'just now';
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function cacheTimeRemaining(expiry) {
  if (!expiry) return null;
  const ms   = expiry - Date.now();
  if (ms <= 0) return null;
  const mins = Math.ceil(ms / 60000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60 ? `${mins % 60}m` : ''}`.trim();
}

// ── Render operation status ───────────────────────────────────────────────────

let _lastNewId = null;

function renderStatus(status, statusTime) {
  const state = classifyStatus(status);
  const step  = detectStep(status);
  const msg   = status || 'No activity yet';

  // Header dot
  dot.className         = `dot ${state === 'idle' ? '' : state}`;
  pillLabel.textContent = state === 'busy' ? 'ACTIVE' : state === 'success' ? 'DONE' : state === 'error' ? 'ERROR' : 'IDLE';

  // Op icon
  opIcon.className  = `op-icon ${state}`;
  opIcon.innerHTML  = ICONS[state === 'success' ? 'check' : state === 'error' ? 'x' : state === 'busy' ? 'spin' : 'idle'];

  // Op message
  opMsg.className   = `msg ${state}`;
  opMsg.textContent = msg;
  opTime.textContent = statusTime ? relativeTime(statusTime) : '';

  // New listing link (shown on success if lastNewId available)
  if (_lastNewId && state === 'success') {
    newListingLink.href         = `https://www.facebook.com/marketplace/item/${_lastNewId}/`;
    newListingLink.style.display = '';
  } else {
    newListingLink.style.display = 'none';
  }

  // Progress steps
  if (state === 'busy' && step >= 0) {
    stepsWrap.style.display = '';
    stepsBar.style.width    = `${(step / 4) * 100}%`;
    stepsBar.className      = 'steps-bar-fill';
    STEP_IDS.forEach((id, i) => {
      document.getElementById(id).className = `step${i < step ? ' done' : i === step ? ' current' : ''}`;
    });
  } else if (state === 'success') {
    stepsWrap.style.display = '';
    stepsBar.style.width    = '100%';
    stepsBar.className      = 'steps-bar-fill success';
    STEP_IDS.forEach(id => { document.getElementById(id).className = 'step done'; });
  } else {
    stepsWrap.style.display = 'none';
    stepsBar.className      = 'steps-bar-fill';
  }
}

// ── Page detection ────────────────────────────────────────────────────────────

function renderPage(onSellingPage) {
  if (onSellingPage) {
    pageIcon.className    = 'page-icon on';
    pageIcon.innerHTML    = ICONS.store;
    pageTitle.textContent = 'Relist buttons are active';
    pageHint.textContent  = 'Click any Relist button on your listings below.';
    ctaWrap.style.display = 'none';
  } else {
    pageIcon.className    = 'page-icon off';
    pageIcon.innerHTML    = ICONS.globe;
    pageTitle.textContent = 'Not on listings page';
    pageHint.textContent  = 'Open your selling page to see Relist buttons.';
    ctaWrap.style.display = '';
  }
}

function detectPage() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const url = tabs[0]?.url || '';
    renderPage(url.includes('/marketplace/you/selling'));
  });
}

// ── Cache info ────────────────────────────────────────────────────────────────

function checkCacheStatus() {
  // v3.0.0: only token cache (doc IDs fetched on demand from the selling tab)
  chrome.storage.local.get(['fbr_tokens_v1'], data => {
    const tokExpiry = data.fbr_tokens_v1?.expiry;
    const tokOk     = tokExpiry && Date.now() < tokExpiry;
    const tokRemain = tokOk ? cacheTimeRemaining(tokExpiry) : null;

    // Build via DOM — no innerHTML with external data
    cacheInfo.textContent = '';
    const label = document.createTextNode('Tokens: ');
    const span  = document.createElement('span');
    span.className   = tokOk ? 'cached' : 'uncached';
    span.textContent = tokOk ? ('● ' + tokRemain) : '○ expired';
    cacheInfo.appendChild(label);
    cacheInfo.appendChild(span);
  });
}

// ── Session stats ─────────────────────────────────────────────────────────────

function loadStats() {
  chrome.storage.local.get(['relistCount', 'relistCountDate'], data => {
    const today = new Date().toISOString().slice(0, 10);
    const count = data.relistCountDate === today ? (data.relistCount || 0) : 0;
    if (count > 0) {
      statsBar.textContent   = `${count} relisted today`;
      statsBar.style.display = '';
    } else {
      statsBar.style.display = 'none';
    }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init() {
  chrome.storage.local.get(['status', 'statusTime', 'lastNewId'], data => {
    _lastNewId = data.lastNewId || null;
    renderStatus(data.status, data.statusTime);
  });

  detectPage();
  checkCacheStatus();
  loadStats();

  // Refresh relative timestamps every 20s while popup is open
  setInterval(() => {
    chrome.storage.local.get(['statusTime'], data => {
      if (data.statusTime) opTime.textContent = relativeTime(data.statusTime);
    });
  }, 20000);
}

// Live updates while popup is open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.status || changes.statusTime || changes.lastNewId) {
    if (changes.lastNewId) _lastNewId = changes.lastNewId.newValue || null;
    chrome.storage.local.get(['status', 'statusTime'], data => {
      renderStatus(data.status, data.statusTime);
    });
  }
  if (changes.fbr_tokens_v1 || changes.fbr_docids_v1) {
    checkCacheStatus();
  }
  if (changes.relistCount || changes.relistCountDate) {
    loadStats();
  }
});

// ── CTA button ────────────────────────────────────────────────────────────────

ctaBtn.addEventListener('click', e => {
  e.preventDefault();
  chrome.tabs.create({ url: SELLING_URL });
  window.close();
});

// ── Clear cache ───────────────────────────────────────────────────────────────

btnClear.addEventListener('click', () => {
  chrome.runtime.sendMessage({ kind: 'CLEAR_CACHE' }, () => {
    btnClear.textContent = 'Cleared ✓';
    btnClear.classList.add('done');
    checkCacheStatus();
    setTimeout(() => {
      btnClear.textContent = 'Clear Cache';
      btnClear.classList.remove('done');
    }, 2000);
  });
});

init();

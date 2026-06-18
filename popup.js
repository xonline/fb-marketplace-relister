'use strict';

const statusEl = document.getElementById('status-text');
const btnClear = document.getElementById('btn-clear-cache');

// ─── Status display ───────────────────────────────────────────────────────────

function loadStatus() {
  chrome.storage.local.get(['status', 'statusTime'], data => {
    if (data.status) {
      statusEl.textContent = data.status;
      const isError = data.status.startsWith('Error');
      statusEl.style.color = isError ? '#e53935' : '#e4e6ea';
    } else {
      statusEl.textContent = 'Ready';
      statusEl.style.color = '#e4e6ea';
    }
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.status || changes.statusTime)) loadStatus();
});

loadStatus();

// ─── Open listings page ───────────────────────────────────────────────────────

document.getElementById('link-open-listings').addEventListener('click', e => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://www.facebook.com/marketplace/you/selling' });
});

// ─── Clear cache ──────────────────────────────────────────────────────────────

btnClear.addEventListener('click', () => {
  chrome.runtime.sendMessage({ kind: 'CLEAR_CACHE' }, () => {
    btnClear.textContent = 'Cache Cleared ✓';
    btnClear.classList.add('done');
    setTimeout(() => {
      btnClear.textContent = 'Clear Token Cache';
      btnClear.classList.remove('done');
    }, 2000);
  });
});

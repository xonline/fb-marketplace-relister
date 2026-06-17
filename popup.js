// popup.js — Controls the popup UI and communicates with background.js

const listingCountEl      = document.getElementById('listing-count');
const statusTextEl        = document.getElementById('status-text');
const progressBarEl       = document.getElementById('progress-bar');
const progressLabelEl     = document.getElementById('progress-label');
const btnRelist           = document.getElementById('btn-relist');
const btnRelistSelected   = document.getElementById('btn-relist-selected');
const btnCancel           = document.getElementById('btn-cancel');
const btnScheduleToggle   = document.getElementById('btn-schedule-toggle');
const btnToggleAll        = document.getElementById('btn-toggle-all');
const scheduleTimeInput   = document.getElementById('schedule-time');
const scheduleStatusEl    = document.getElementById('schedule-status');
const listingsSection     = document.getElementById('listings-section');
const listingsCheckboxes  = document.getElementById('listings-checkboxes');

let scannedListings = [];

// ─── Checkbox list ────────────────────────────────────────────────────────────

function renderListings(listings) {
  scannedListings = listings;
  listingsCheckboxes.innerHTML = '';

  listings.forEach(l => {
    const label = document.createElement('label');
    label.className = 'listing-item';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.id = l.id;
    cb.addEventListener('change', updateSelectedBtn);

    const span = document.createElement('span');
    const price = l.price ? ` · ${l.price}` : '';
    span.textContent = (l.title || `Listing ${l.id}`) + price;
    span.title = span.textContent;

    label.appendChild(cb);
    label.appendChild(span);
    listingsCheckboxes.appendChild(label);
  });

  listingsSection.style.display = 'block';
  updateSelectedBtn();
}

function updateSelectedBtn() {
  const checked = listingsCheckboxes.querySelectorAll('input:checked').length;
  const total   = scannedListings.length;
  btnRelistSelected.textContent = `Relist Selected (${checked}/${total})`;
  btnRelistSelected.disabled = checked === 0;

  const allChecked = checked === total;
  btnToggleAll.textContent = allChecked ? 'None' : 'All';
}

function getSelectedIds() {
  return Array.from(listingsCheckboxes.querySelectorAll('input:checked'))
    .map(cb => cb.dataset.id);
}

btnToggleAll.addEventListener('click', () => {
  const allChecked = listingsCheckboxes.querySelectorAll('input:checked').length === scannedListings.length;
  listingsCheckboxes.querySelectorAll('input').forEach(cb => { cb.checked = !allChecked; });
  updateSelectedBtn();
});

// ─── Scan ─────────────────────────────────────────────────────────────────────

document.getElementById('btn-scan').addEventListener('click', () => {
  statusTextEl.textContent = 'Scanning...';
  listingsSection.style.display = 'none';
  scannedListings = [];

  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (!tabs[0]) { statusTextEl.textContent = 'No active tab'; return; }
    chrome.tabs.sendMessage(tabs[0].id, { action: 'scanOnly' }, response => {
      if (chrome.runtime.lastError) {
        statusTextEl.textContent = 'Content script not running — go to Marketplace → Your Listings first';
        return;
      }
      const r = response || {};
      const count = r.count || 0;

      if (count > 0) {
        statusTextEl.textContent = `Found ${count} listing(s). Select which to relist.`;
        renderListings(r.listings || r.titles.map((t, i) => ({ id: String(i), title: t })));
      } else {
        const btns = (r.sampleActionButtons || []).join(', ');
        statusTextEl.textContent = `0 found. Action btns: ${r.actionButtons} (${btns.slice(0, 60)}), numeric links: ${r.numericLinks}`;
      }
    });
  });
});

// ─── Relist Selected ──────────────────────────────────────────────────────────

btnRelistSelected.addEventListener('click', () => {
  const selectedIds = getSelectedIds();
  if (selectedIds.length === 0) return;

  btnRelistSelected.disabled = true;
  btnRelist.disabled = true;
  btnCancel.style.display = 'block';
  statusTextEl.textContent = `Starting relist for ${selectedIds.length} listing(s)...`;

  chrome.runtime.sendMessage({ action: 'startRelist', selectedIds }, response => {
    if (chrome.runtime.lastError) {
      statusTextEl.textContent = 'Error: ' + chrome.runtime.lastError.message;
      btnRelistSelected.disabled = false;
      btnRelist.disabled = false;
      btnCancel.style.display = 'none';
    }
  });
});

// ─── Relist All ───────────────────────────────────────────────────────────────

btnRelist.addEventListener('click', () => {
  btnRelist.disabled = true;
  btnRelistSelected.disabled = true;
  btnCancel.style.display = 'block';
  statusTextEl.textContent = 'Starting relist for all listings...';

  chrome.runtime.sendMessage({ action: 'startRelist' }, response => {
    if (chrome.runtime.lastError) {
      statusTextEl.textContent = 'Error: ' + chrome.runtime.lastError.message;
      btnRelist.disabled = false;
      btnRelistSelected.disabled = false;
      btnCancel.style.display = 'none';
    }
  });
});

// ─── Cancel ───────────────────────────────────────────────────────────────────

btnCancel.addEventListener('click', () => {
  chrome.storage.local.set({
    relistPending: false,
    relistState: null,
    status: 'Cancelled by user',
  }, () => {
    btnCancel.style.display = 'none';
    btnRelist.disabled = false;
    if (scannedListings.length > 0) updateSelectedBtn();
    loadState();
  });
});

// ─── Storage state polling ────────────────────────────────────────────────────

function loadState() {
  chrome.storage.local.get(
    ['listings', 'status', 'progressDone', 'progressTotal', 'relistPending',
     'scheduleEnabled', 'scheduleHour', 'scheduleMinute'],
    data => {
      const count = Array.isArray(data.listings) ? data.listings.length : 0;
      listingCountEl.textContent = count > 0 ? count : '—';

      statusTextEl.textContent = data.status || 'Ready';

      const done  = data.progressDone  || 0;
      const total = data.progressTotal || 0;
      if (total > 0) {
        const pct = Math.round((done / total) * 100);
        progressBarEl.style.width = pct + '%';
        progressLabelEl.textContent = `${done} / ${total}`;
      } else {
        progressBarEl.style.width = '0%';
        progressLabelEl.textContent = '';
      }

      const running = data.relistPending === true;
      btnRelist.disabled = running;
      if (scannedListings.length > 0) btnRelistSelected.disabled = running;
      btnCancel.style.display = running ? 'block' : 'none';

      if (data.scheduleEnabled) {
        const h = String(data.scheduleHour   ?? 9).padStart(2, '0');
        const m = String(data.scheduleMinute ?? 0).padStart(2, '0');
        scheduleTimeInput.value = `${h}:${m}`;
        btnScheduleToggle.textContent = 'Disable Schedule';
        btnScheduleToggle.style.background = '#b0292f';
        scheduleStatusEl.textContent = `Scheduled daily at ${h}:${m}`;
      } else {
        btnScheduleToggle.textContent = 'Enable Schedule';
        btnScheduleToggle.style.background = '';
        scheduleStatusEl.textContent = 'Not scheduled';
      }
    }
  );
}

// ─── Schedule ─────────────────────────────────────────────────────────────────

btnScheduleToggle.addEventListener('click', () => {
  chrome.storage.local.get(['scheduleEnabled'], data => {
    if (data.scheduleEnabled) {
      chrome.runtime.sendMessage({ action: 'cancelSchedule' }, () => {
        scheduleStatusEl.textContent = 'Schedule disabled';
        loadState();
      });
    } else {
      const [hourStr, minuteStr] = (scheduleTimeInput.value || '09:00').split(':');
      const hour   = parseInt(hourStr,   10) || 9;
      const minute = parseInt(minuteStr, 10) || 0;

      chrome.runtime.sendMessage(
        { action: 'scheduleDaily', hour, minute },
        () => {
          scheduleStatusEl.textContent = `Scheduling at ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}...`;
          loadState();
        }
      );
    }
  });
});

loadState();
setInterval(loadState, 2000);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') loadState();
});

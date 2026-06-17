// popup.js — Controls the popup UI and communicates with background.js

const listingCountEl      = document.getElementById('listing-count');
const statusTextEl        = document.getElementById('status-text');
const progressBarEl       = document.getElementById('progress-bar');
const progressLabelEl     = document.getElementById('progress-label');
const btnRelist           = document.getElementById('btn-relist');
const btnCancel           = document.getElementById('btn-cancel');
const btnScheduleToggle   = document.getElementById('btn-schedule-toggle');
const scheduleTimeInput   = document.getElementById('schedule-time');
const scheduleStatusEl    = document.getElementById('schedule-status');

function loadState() {
  chrome.storage.local.get(
    [
      'listings',
      'status',
      'progressDone',
      'progressTotal',
      'relistPending',
      'scheduleEnabled',
      'scheduleHour',
      'scheduleMinute',
    ],
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

document.getElementById('btn-scan').addEventListener('click', () => {
  statusTextEl.textContent = 'Scanning...';
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (!tabs[0]) { statusTextEl.textContent = 'No active tab'; return; }
    chrome.tabs.sendMessage(tabs[0].id, { action: 'scanOnly' }, response => {
      if (chrome.runtime.lastError) {
        statusTextEl.textContent = 'Content script not running on this page';
        return;
      }
      const count = response && response.count;
      const titles = response && response.titles ? response.titles.join(', ') : '';
      statusTextEl.textContent = count > 0
        ? `Found ${count}: ${titles.slice(0, 80)}`
        : `0 found. Links seen: ${response && response.linksChecked}`;
    });
  });
});

btnRelist.addEventListener('click', () => {
  btnRelist.disabled = true;
  btnCancel.style.display = 'block';
  statusTextEl.textContent = 'Starting...';

  chrome.runtime.sendMessage({ action: 'startRelist' }, response => {
    if (chrome.runtime.lastError) {
      statusTextEl.textContent = 'Error: ' + chrome.runtime.lastError.message;
      btnRelist.disabled = false;
      btnCancel.style.display = 'none';
    }
  });
});

btnCancel.addEventListener('click', () => {
  chrome.storage.local.set({
    relistPending: false,
    relistState: null,
    status: 'Cancelled by user',
  }, () => {
    btnCancel.style.display = 'none';
    btnRelist.disabled = false;
    loadState();
  });
});

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

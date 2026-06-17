// background.js — MV3 Service Worker
// Handles: CORS-free image downloads, alarm scheduling, tab management

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'downloadImage') {
    fetch(msg.url)
      .then(r => r.blob())
      .then(blob => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('FileReader error'));
        reader.readAsDataURL(blob);
      }))
      .then(dataUrl => sendResponse({ data: dataUrl }))
      .catch(err => {
        console.error('[Relister BG] Image download failed:', err);
        sendResponse({ data: null });
      });

    return true;
  }

  if (msg.action === 'startRelist') {
    startRelistFlow();
    sendResponse({ started: true });
    return false;
  }

  if (msg.action === 'scheduleDaily') {
    const hour   = msg.hour   ?? 9;
    const minute = msg.minute ?? 0;
    scheduleDaily(hour, minute);
    sendResponse({ scheduled: true });
    return false;
  }

  if (msg.action === 'cancelSchedule') {
    chrome.alarms.clear('dailyRelist', cleared => {
      chrome.storage.local.set({ scheduleEnabled: false });
      sendResponse({ cancelled: cleared });
    });
    return true;
  }
});

function scheduleDaily(hour, minute) {
  const now    = new Date();
  const target = new Date();
  target.setHours(hour, minute, 0, 0);
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }
  const delayMs = target.getTime() - now.getTime();

  chrome.alarms.clear('dailyRelist', () => {
    chrome.alarms.create('dailyRelist', {
      delayInMinutes: delayMs / 60000,
      periodInMinutes: 24 * 60,
    });
    chrome.storage.local.set({
      scheduleEnabled: true,
      scheduleHour:   hour,
      scheduleMinute: minute,
    });
    console.log(`[Relister BG] Daily relist scheduled for ${hour}:${String(minute).padStart(2,'0')}`);
  });
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'dailyRelist') {
    console.log('[Relister BG] Daily alarm fired — starting relist flow');
    startRelistFlow();
  }
});

async function startRelistFlow() {
  await chrome.storage.local.set({
    relistPending: true,
    relistState: 'scraping',
    relistStartedAt: Date.now(),
    progressDone: 0,
    progressTotal: 0,
    status: 'Starting relist flow...',
  });

  const tabs = await chrome.tabs.query({ url: '*://*.facebook.com/marketplace/*' });

  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, {
      active: true,
      url: 'https://www.facebook.com/marketplace/you/selling?state=LIVE&status[0]=IN_STOCK',
    });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({
      url: 'https://www.facebook.com/marketplace/you/selling?state=LIVE&status[0]=IN_STOCK',
      active: true,
    });
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== 'install') return;
  chrome.storage.local.set({
    relistPending:    false,
    relistState:      null,
    listings:         [],
    status:           'Ready',
    progressDone:     0,
    progressTotal:    0,
    scheduleEnabled:  false,
    scheduleHour:     9,
    scheduleMinute:   0,
  });
  console.log('[Relister BG] Extension installed and initialised.');
});

chrome.runtime.onStartup.addListener(async () => {
  const data = await chrome.storage.local.get(['scheduleEnabled', 'scheduleHour', 'scheduleMinute']);
  if (data.scheduleEnabled) {
    scheduleDaily(data.scheduleHour ?? 9, data.scheduleMinute ?? 0);
  }
});

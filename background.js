'use strict';

// ─── Cache keys ───────────────────────────────────────────────────────────────
const TOKEN_CACHE_KEY  = 'fbr_tokens_v1';
const DOCID_CACHE_KEY  = 'fbr_docids_v1';
const TOKEN_TTL  = 60 * 60 * 1000;        // 1 hour
const DOCID_TTL  = 24 * 60 * 60 * 1000;   // 24 hours

// Per-session read doc_id cache (service worker lifespan is fine)
let _readDocId = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout'));
    }, 30000);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(() => {});
  });
}

async function executeInMainWorld(tabId, keys) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [keys],
    func: (moduleKeys) => {
      const r = window.require;
      if (typeof r !== 'function') return {};
      const out = {};
      for (const k of moduleKeys) {
        try { out[k] = r(k); } catch { out[k] = null; }
      }
      return out;
    }
  });
  return results[0]?.result ?? {};
}

async function extractMarketplaceIdFromTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      function deepFind(obj, key, seen) {
        if (!obj || typeof obj !== 'object') return null;
        if (!seen) seen = new Set();
        if (seen.has(obj)) return null;
        seen.add(obj);
        if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
        for (const v of Object.values(obj)) {
          const found = deepFind(v, key, seen);
          if (found != null) return found;
        }
        return null;
      }
      const scripts = Array.from(document.getElementsByTagName('script'))
        .filter(s => s.type === 'application/json');
      for (const s of scripts) {
        try {
          const data = JSON.parse(s.textContent || '{}');
          const mp = deepFind(data, 'current_marketplace');
          if (mp && mp.id) return mp.id;
        } catch {}
      }
      return null;
    }
  });
  return results[0]?.result ?? null;
}

async function openTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  await waitForTabComplete(tab.id);
  return tab.id;
}

async function findExistingTab(urlPattern) {
  const tabs = await chrome.tabs.query({ url: urlPattern });
  return tabs[0]?.id ?? null;
}

// ─── Token extraction ─────────────────────────────────────────────────────────

async function getTokens(tabId) {
  const cached = (await chrome.storage.local.get(TOKEN_CACHE_KEY))[TOKEN_CACHE_KEY];
  if (cached && Date.now() < cached.expiry) return cached.data;

  const modules = await executeInMainWorld(tabId, ['CurrentUserInitialData', 'DTSGInitialData']);
  const userId  = modules.CurrentUserInitialData?.USER_ID;
  const fbDtsg  = modules.DTSGInitialData?.token;
  if (!userId || !fbDtsg) throw new Error('Could not extract FB tokens — are you logged in?');

  const marketplaceId = await extractMarketplaceIdFromTab(tabId);
  if (!marketplaceId) throw new Error('Could not find marketplace_id on selling page');

  const data = { user_id: userId, fb_dtsg: fbDtsg, marketplace_id: marketplaceId };
  await chrome.storage.local.set({ [TOKEN_CACHE_KEY]: { data, expiry: Date.now() + TOKEN_TTL } });
  return data;
}

// ─── Doc ID extraction ────────────────────────────────────────────────────────

async function getDocIds() {
  const cached = (await chrome.storage.local.get(DOCID_CACHE_KEY))[DOCID_CACHE_KEY];
  if (cached && Date.now() < cached.expiry) return cached.data;

  // Create page → create + possibly read doc IDs
  const createTabId = await openTab('https://www.facebook.com/marketplace/create/item');

  // Prefer existing selling-page tab for delete doc ID
  let deleteTabId = await findExistingTab('*://www.facebook.com/marketplace/you/selling*');
  let ownedDeleteTab = false;
  if (!deleteTabId) {
    deleteTabId = await openTab('https://www.facebook.com/marketplace/you/selling');
    ownedDeleteTab = true;
  }

  let data;
  try {
    const [createMods, deleteMods] = await Promise.all([
      executeInMainWorld(createTabId, [
        'useCometMarketplaceListingCreateMutation_facebookRelayOperation',
        'CometMarketplaceComposerRootComponentQuery_facebookRelayOperation'
      ]),
      executeInMainWorld(deleteTabId, [
        'useCometMarketplaceForSaleItemDeleteMutation_facebookRelayOperation'
      ])
    ]);

    const createId = createMods['useCometMarketplaceListingCreateMutation_facebookRelayOperation'];
    const readId   = createMods['CometMarketplaceComposerRootComponentQuery_facebookRelayOperation'];
    const deleteId = deleteMods['useCometMarketplaceForSaleItemDeleteMutation_facebookRelayOperation'];

    if (!createId) throw new Error('Could not extract create doc_id from create page');
    if (!deleteId) throw new Error('Could not extract delete doc_id from selling page');

    data = { create_id: createId, delete_id: deleteId, read_id: readId || null };
    await chrome.storage.local.set({ [DOCID_CACHE_KEY]: { data, expiry: Date.now() + DOCID_TTL } });
  } finally {
    chrome.tabs.remove(createTabId).catch(() => {});
    if (ownedDeleteTab) chrome.tabs.remove(deleteTabId).catch(() => {});
  }

  return data;
}

async function getReadDocId(listingId) {
  if (_readDocId) return _readDocId;

  const tabId = await openTab(`https://www.facebook.com/marketplace/edit/?listing_id=${listingId}`);
  try {
    const mods = await executeInMainWorld(tabId, [
      'CometMarketplaceComposerRootComponentQuery_facebookRelayOperation'
    ]);
    const id = mods['CometMarketplaceComposerRootComponentQuery_facebookRelayOperation'] || null;
    if (id) _readDocId = id;
    return id;
  } finally {
    chrome.tabs.remove(tabId).catch(() => {});
  }
}

// ─── Message handlers ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.kind === 'GET_TOKENS') {
    const tabId = sender.tab?.id ?? msg.tabId;
    getTokens(tabId)
      .then(sendResponse)
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.kind === 'GET_DOC_IDS') {
    getDocIds()
      .then(async (ids) => {
        if (!ids.read_id && msg.listingId) {
          const readId = await getReadDocId(msg.listingId).catch(() => null);
          sendResponse({ ...ids, read_id: readId });
        } else {
          sendResponse(ids);
        }
      })
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.kind === 'CLEAR_CACHE') {
    _readDocId = null;
    chrome.storage.local.remove([TOKEN_CACHE_KEY, DOCID_CACHE_KEY])
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});

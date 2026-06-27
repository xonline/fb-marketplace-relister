'use strict';

// background.js v3.7.6 — Direct API (GraphQL) relist + AI enhance + price drop + bulk + schedule
//                        + buyer-visible condition (create→edit→delete).
//                        + DIY license (free tier: top-4 listings; Pro: unlimited + bulk + schedule + AI + price-drop).
// Proven flow ported from relist-final.mjs + apply-attr-condition.mjs.
// Fetches run in the SW directly (credentials:'include'); tokens/doc_ids
// extracted via executeInMainWorld (world:'MAIN', window.require).

// ─── ai.js import ─────────────────────────────────────────────────────────────
try { importScripts('ai.js'); } catch (e) { console.warn('[Relister v3] ai.js not loaded:', e.message); }

// ─── Upgrade payment links ────────────────────────────────────────────────────
// Live Stripe Payment Links — FB Marketplace Relister account (acct_1TmV22IFVSNlTy9w).
const UPGRADE_URL_MONTHLY = 'https://buy.stripe.com/28E5kEaHkdGh3defFn5c400';
const UPGRADE_URL_YEARLY  = 'https://buy.stripe.com/dRm3cw5n045H8xyfFn5c401';

// Free tier: top 4 most-recent listings (0-indexed 0–3); Pro: all unlocked.
const FREE_LISTING_LIMIT = 4;

// ─── DIY license / pro-status ─────────────────────────────────────────────────
const LICENSE_KEY     = 'fbr_license';
const PRO_CACHE_KEY   = 'fbr_pro_cache';
const PRO_CACHE_TTL   = 5 * 60 * 1000; // 5 min
const LICENSE_API_URL = 'https://relist.nowoly.com/api/license';
const TELEMETRY_URL   = 'https://relist.nowoly.com/api/telemetry';
const EVENT_URL       = 'https://relist.nowoly.com/api/event';

// Get or generate the per-install UUID stored in chrome.storage.local.
// Defined as a function declaration so it is hoisted and available in ai.js
// (which is importScripts'd before this line is reached at runtime).
async function getLicenseUUID() {
  const data = await chrome.storage.local.get(LICENSE_KEY);
  if (data[LICENSE_KEY]) return data[LICENSE_KEY];
  const uuid = crypto.randomUUID();
  await chrome.storage.local.set({ [LICENSE_KEY]: uuid });
  return uuid;
}

// ─── Cache keys ───────────────────────────────────────────────────────────────
const TOKEN_CACHE_KEY = 'fbr_tokens_v1';
const TOKEN_TTL       = 60 * 60 * 1000;   // 1 hour

const SELLING_URL = 'https://www.facebook.com/marketplace/you/selling';

// ─── Settings helper ──────────────────────────────────────────────────────────

async function getSettings() {
  const data = await chrome.storage.local.get('fbr_settings');
  const s = data.fbr_settings || {};
  return {
    geminiApiKey:       s.geminiApiKey       || '',
    geminiModel:        s.geminiModel        || 'gemini-2.5-flash',
    aiSystemPrompt:     s.aiSystemPrompt     || '',
    aiEnhanceOnRelist:  s.aiEnhanceOnRelist  ?? false,
    priceDropEnabled:   s.priceDropEnabled   ?? false,
    priceDropType:      s.priceDropType      || 'percent',
    priceDropValue:     Number(s.priceDropValue  ?? 0),
    priceFloor:         Number(s.priceFloor      ?? 1),
    scheduleEnabled:    s.scheduleEnabled    ?? false,
    scheduleEveryHours: Number(s.scheduleEveryHours ?? 24),
    scheduleMode:       s.scheduleMode      || 'interval',
    scheduleDateTime:   s.scheduleDateTime  || '',
    scheduleWeekday:    Number(s.scheduleWeekday  ?? 1),
    bulkDelaySec:       Number(s.bulkDelaySec   ?? 12),
  };
}

// ─── Status helper ────────────────────────────────────────────────────────────

function status(text) {
  chrome.storage.local.set({ status: text, statusTime: Date.now() });
}

// ─── Pro status helpers (DIY license) ────────────────────────────────────────

// Returns true if the user has an active paid licence.
// Calls GET /api/license?id=<uuid>, caches result ~5 min in chrome.storage.
// On network failure uses stale cache if available; fails closed (free) otherwise.
async function getProStatus() {
  try {
    const cached = (await chrome.storage.local.get(PRO_CACHE_KEY))[PRO_CACHE_KEY];
    if (cached && (Date.now() - cached.ts) < PRO_CACHE_TTL) {
      return !!cached.isPro;
    }
    const uuid = await getLicenseUUID();
    const resp  = await fetch(`${LICENSE_API_URL}?id=${encodeURIComponent(uuid)}`);
    if (!resp.ok) throw new Error(`license API ${resp.status}`);
    const body  = await resp.json();
    const isPro = !!body.paid;
    await chrome.storage.local.set({ [PRO_CACHE_KEY]: { isPro, ts: Date.now() } });
    return isPro;
  } catch (e) {
    console.warn('[Relister v3] getProStatus() failed — using stale cache or free:', e.message);
    try {
      const stale = (await chrome.storage.local.get(PRO_CACHE_KEY))[PRO_CACHE_KEY];
      if (stale && stale.isPro != null) return !!stale.isPro;
    } catch (_) {}
    return false;
  }
}

// Best-effort telemetry: POST /api/telemetry {t:'relist', ok, code}
// Never blocks or breaks the relist flow.
async function postTelemetry(ok, code) {
  try {
    await fetch(TELEMETRY_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ t: 'relist', ok, code }),
    });
  } catch (_) { /* best-effort */ }
}

// Best-effort analytics: POST /api/event {name, params, cid}
// Never blocks or breaks anything.
async function postEvent(name, params) {
  try {
    const cid = await getLicenseUUID();
    await fetch(EVENT_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, params: params || {}, cid }),
    });
  } catch (_) { /* best-effort */ }
}

// ─── Live IDs cache (for free-tier position gating) ──────────────────────────
// Caches the ordered list of live listing IDs so index-gating doesn't open a
// new API call on every single relist. TTL is 5 min — short enough that a user
// adding a new listing will see it unlocked quickly.

let _liveIdsCache = null; // { ids: string[], ts: number } | null
const LIVE_IDS_CACHE_TTL = 5 * 60 * 1000; // 5 min

async function getLiveIdsForGating(sellingTabId) {
  if (_liveIdsCache && Date.now() - _liveIdsCache.ts < LIVE_IDS_CACHE_TTL) {
    return _liveIdsCache.ids;
  }
  const tokens = await getTokens(sellingTabId);
  const ids    = await fetchLiveListingIds(sellingTabId, tokens);
  _liveIdsCache = { ids, ts: Date.now() };
  return ids;
}

// ─── Harvest interceptor ──────────────────────────────────────────────────────
// Injects a MAIN-world fetch+XHR wrapper that collects listing data from FB's
// GraphQL responses as they arrive. window.__fbrHarvested accumulates every
// active listing seen in ANY /api/graphql response (both Comet + Fast queries),
// so a single loadAllCards() scroll yields the complete ~20-listing set.

async function installHarvestInterceptor(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        if (window.__fbrInterceptorInstalled) return;
        window.__fbrInterceptorInstalled = true;
        if (!window.__fbrHarvested) window.__fbrHarvested = [];

        // Walk an object tree and push every active marketplace listing found.
        function collectFromObj(obj) {
          function walk(o, seen, depth) {
            if (!o || typeof o !== 'object' || depth > 50 || seen.has(o)) return;
            seen.add(o);
            const tn = o.__typename;
            if ((tn === 'MarketplaceForSaleItem' || tn === 'GroupCommerceProductItem') &&
                o.id && o.marketplace_listing_title &&
                !(o.is_sold || o.is_pending || o.is_draft)) {
              const id = String(o.id);
              if (!window.__fbrHarvested.some(x => x.id === id)) {
                const uri = (o.primary_listing_photo && o.primary_listing_photo.image && o.primary_listing_photo.image.uri)
                         || (o.listing_photos && o.listing_photos.edges && o.listing_photos.edges[0] && o.listing_photos.edges[0].node && o.listing_photos.edges[0].node.image && o.listing_photos.edges[0].node.image.uri)
                         || null;
                let photoFilename = null;
                if (uri) {
                  try { photoFilename = new URL(uri).pathname.split('/').pop() || null; }
                  catch { photoFilename = uri.split('/').pop().split('?')[0] || null; }
                }
                window.__fbrHarvested.push({ id, title: o.marketplace_listing_title, photoFilename });
              }
            }
            const vals = Array.isArray(o) ? o : Object.values(o);
            for (const v of vals) walk(v, seen, depth + 1);
          }
          walk(obj, new Set(), 0);
        }

        // Parse a raw GraphQL response body (may be newline-delimited multi-JSON).
        function processText(text) {
          if (!text || !text.includes('marketplace_listing_title')) return;
          for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try { collectFromObj(JSON.parse(line)); } catch (_) {}
          }
        }

        // Wrap window.fetch
        const _origFetch = window.fetch;
        window.fetch = function() {
          const args = Array.prototype.slice.call(arguments);
          const url = (typeof args[0] === 'string') ? args[0]
                    : (args[0] && typeof args[0].url === 'string') ? args[0].url : '';
          const p = _origFetch.apply(this, args);
          if (url.indexOf('/api/graphql') !== -1) {
            p.then(function(resp) {
              resp.clone().text().then(processText).catch(function(){});
            }).catch(function(){});
          }
          return p;
        };

        // Wrap XMLHttpRequest
        const _origOpen = XMLHttpRequest.prototype.open;
        const _origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url) {
          this.__fbrXhrUrl = String(url || '');
          return _origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function() {
          if (this.__fbrXhrUrl && this.__fbrXhrUrl.indexOf('/api/graphql') !== -1) {
            var self = this;
            self.addEventListener('load', function() {
              try { processText(self.responseText); } catch (_) {}
            });
          }
          return _origSend.apply(this, arguments);
        };
      }
    });
  } catch (e) {
    console.warn('[Relister v3] installHarvestInterceptor failed:', e.message);
  }
}

// Read the accumulated harvest from MAIN world.
// Returns [{id, title, photoFilename}, ...] in insertion order.
async function readHarvestedListings(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => window.__fbrHarvested || [],
    });
    return results[0]?.result || [];
  } catch (e) {
    console.warn('[Relister v3] readHarvestedListings failed:', e.message);
    return [];
  }
}

// ─── Condition normaliser ─────────────────────────────────────────────────────
// The create mutation's `condition` field accepts ONLY these enum values:
//   NEW_ITEM / PC_USED_LIKE_NEW / PC_USED_GOOD / PC_USED_FAIR
// (Proven live 2026-06-23: the composer-form value 'used_good' → noncoercible;
//  'PC_USED_GOOD' persists and reads back identically.)
// FB read surfaces give either the fine-grained enum (real UI listings) or a
// coarse NEW/USED (listings created without a condition). Coarse → safe default;
// unknown/empty → null so we OMIT the field rather than send a bad enum.
const VALID_CONDITIONS = new Set(['NEW_ITEM', 'PC_USED_LIKE_NEW', 'PC_USED_GOOD', 'PC_USED_FAIR']);
function normalizeCondition(raw) {
  if (!raw) return null;
  const c = String(raw).toUpperCase();
  if (VALID_CONDITIONS.has(c)) return c;
  if (c === 'NEW')           return 'NEW_ITEM';
  if (c === 'USED')          return 'PC_USED_GOOD';   // coarse fallback (no fine-grained stored)
  if (c === 'USED_LIKE_NEW') return 'PC_USED_LIKE_NEW';
  if (c === 'USED_GOOD')     return 'PC_USED_GOOD';
  if (c === 'USED_FAIR')     return 'PC_USED_FAIR';
  return null;
}

// ─── Condition → composer value ───────────────────────────────────────────────
// The BUYER-VISIBLE "Condition: …" row is driven by `attribute_data`, written via
// `attribute_data_json: JSON.stringify({ condition: "<composer value>" })`. The
// composer values are lowercased: new / used_like_new / used_good / used_fair.
// (Proven live 2026-06-24: the OBJECT form persists & renders to buyers; the array
//  form is silently dropped; and attribute_data_json works on EDIT but is rejected
//  by CREATE with field_exception — hence the create→edit→delete flow.)
// Accepts either the composer value itself (from edit-page attribute_data) or any
// renderable enum (NEW_ITEM / PC_USED_* / coarse NEW / USED) and returns the
// composer value, or null when there's no usable condition signal.
const COMPOSER_CONDITIONS = new Set(['new', 'used_like_new', 'used_good', 'used_fair']);
function conditionToComposer(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (COMPOSER_CONDITIONS.has(s)) return s;
  const c = String(raw).toUpperCase();
  if (c === 'NEW_ITEM' || c === 'NEW')                    return 'new';
  if (c === 'PC_USED_LIKE_NEW' || c === 'USED_LIKE_NEW')  return 'used_like_new';
  if (c === 'PC_USED_GOOD' || c === 'USED_GOOD' || c === 'USED') return 'used_good';
  if (c === 'PC_USED_FAIR' || c === 'USED_FAIR')          return 'used_fair';
  return null;
}

// ─── Tab helpers ──────────────────────────────────────────────────────────────

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    // Resolve (proceed) after a cap rather than reject/hang: FB SPA pages opened as
    // background tabs can be slow to reach 'complete', and each reader has its own
    // post-open settle delay. A hang here would stall the whole relist past the MV3
    // service-worker limit. 15s is ample for FB to render its inline JSON.
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);

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

async function openTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  await waitForTabComplete(tab.id);
  return tab.id;
}

// ─── MAIN-world execution helper ─────────────────────────────────────────────

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

// ─── marketplace_id extraction ────────────────────────────────────────────────

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
          if (mp && mp.id) return String(mp.id);
        } catch {}
      }
      return null;
    }
  });
  return results[0]?.result ?? null;
}

// ─── Token extraction ─────────────────────────────────────────────────────────

async function getTokens(tabId) {
  const cached = (await chrome.storage.local.get(TOKEN_CACHE_KEY))[TOKEN_CACHE_KEY];
  if (cached && Date.now() < cached.expiry) return cached.data;

  const modules = await executeInMainWorld(tabId, ['CurrentUserInitialData', 'DTSGInitialData']);
  const userId  = modules.CurrentUserInitialData?.USER_ID;
  const fbDtsg  = modules.DTSGInitialData?.token;
  if (!userId || !fbDtsg) throw new Error('Could not extract FB tokens — are you logged in?');

  // marketplace_id: the page's inline JSON may still be loading on a freshly-opened
  // bulk tab, so retry a few times, then fall back to a previously-seen value (it's
  // stable per user). This fixes the bulk "Could not find marketplace_id" failure.
  let marketplaceId = null;
  for (let i = 0; i < 3 && !marketplaceId; i++) {
    marketplaceId = await extractMarketplaceIdFromTab(tabId);
    if (!marketplaceId && i < 2) await new Promise(r => setTimeout(r, 1500));
  }
  if (!marketplaceId) {
    marketplaceId = (await chrome.storage.local.get('fbr_marketplace_id'))['fbr_marketplace_id'] || null;
    if (marketplaceId) console.log('[Relister v3] marketplace_id from persisted fallback:', marketplaceId);
  }
  if (!marketplaceId) throw new Error('Could not find marketplace_id on selling page');
  await chrome.storage.local.set({ fbr_marketplace_id: marketplaceId });

  const data = { user_id: userId, fb_dtsg: fbDtsg, marketplace_id: marketplaceId };
  await chrome.storage.local.set({ [TOKEN_CACHE_KEY]: { data, expiry: Date.now() + TOKEN_TTL } });
  return data;
}

// ─── Doc ID helpers ───────────────────────────────────────────────────────────

async function getDocId(tabId, key) {
  const mods = await executeInMainWorld(tabId, [key]);
  return mods[key] ?? null;
}

// ─── Cached doc_id ────────────────────────────────────────────────────────────
// FB GraphQL doc_ids are global per-deploy and rotate ~daily. Opening a tab to
// extract one on EVERY relist was the main source of slowness — and, by pushing the
// flow past Chrome's ~5-min MV3 service-worker limit, the cause of the "stuck on
// Reading…" hangs. Cache them so the create page is opened at most once per 6h.
const DOCID_CACHE_KEY = 'fbr_docids_cache';
const DOCID_TTL       = 6 * 60 * 60 * 1000; // 6h
async function getCachedDocId(key) {
  const all = (await chrome.storage.local.get(DOCID_CACHE_KEY))[DOCID_CACHE_KEY] || {};
  const e = all[key];
  return (e && Date.now() < e.expiry) ? e.id : null;
}
async function setCachedDocId(key, id) {
  if (!id) return;
  const all = (await chrome.storage.local.get(DOCID_CACHE_KEY))[DOCID_CACHE_KEY] || {};
  all[key] = { id, expiry: Date.now() + DOCID_TTL };
  await chrome.storage.local.set({ [DOCID_CACHE_KEY]: all });
}
// Return a doc_id from cache, else open `url` once to extract + cache it.
async function getOrFetchDocId(key, url) {
  const cached = await getCachedDocId(key);
  if (cached) { console.log('[Relister v3] doc_id cache HIT:', key); return cached; }
  const tabId = await openTab(url);
  try {
    const id = await getDocId(tabId, key);
    if (id) { await setCachedDocId(key, id); console.log('[Relister v3] doc_id cached:', key); }
    return id;
  } finally { chrome.tabs.remove(tabId).catch(() => {}); }
}

// ─── GraphQL POST helper ──────────────────────────────────────────────────────
// Runs the POST IN THE PAGE (facebook.com origin) via executeScript, NOT in the
// service worker. FB binds these mutations to the page session/origin — a bare SW
// fetch is rejected (no photoID / auth errors). This mirrors the proven page-context
// flow. `pageTabId` must be a loaded facebook.com tab (the selling tab).

async function fbGraphQL(tokens, docId, friendlyName, variables, referrer, pageTabId) {
  if (!docId)     throw new Error(`Cannot build GraphQL request (${friendlyName}): doc_id is missing`);
  if (!pageTabId) throw new Error(`Cannot run GraphQL (${friendlyName}): no facebook.com tab to run from`);

  const bodyParams = {
    av:                       String(tokens.user_id),
    __a:                      '1',
    __comet_req:              '1',
    fb_dtsg:                  tokens.fb_dtsg,
    fb_api_caller_class:      'RelayModern',
    fb_api_req_friendly_name: friendlyName,
    variables:                JSON.stringify(variables),
    doc_id:                   String(docId)
  };

  const results = await chrome.scripting.executeScript({
    target: { tabId: pageTabId },
    world:  'MAIN',
    args:   [bodyParams, referrer],
    func: async (bodyParams, referrer) => {
      try {
        const body = new URLSearchParams(bodyParams).toString();
        const res  = await fetch('https://www.facebook.com/api/graphql/', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          referrer,
          body,
          credentials: 'include'
        });
        return { ok: res.ok, status: res.status, text: await res.text() };
      } catch (e) {
        return { ok: false, status: 0, text: '', error: String((e && e.message) || e) };
      }
    }
  });

  const r = results[0]?.result;
  if (!r)       throw new Error(`GraphQL page-fetch returned nothing (${friendlyName})`);
  if (r.error)  throw new Error(`GraphQL page-fetch error (${friendlyName}): ${r.error}`);
  if (!r.ok)    throw new Error(`FB GraphQL HTTP ${r.status} (${friendlyName})`);

  const clean = String(r.text).replace(/^\s*for\s*\(;;\);\s*/, '').trim();
  // FB can return a multi-line JSON stream. Merge data + errors across ALL lines so
  // an error on a later line is never silently dropped behind a data-only first line.
  let merged = null;
  for (const line of clean.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    let parsed; try { parsed = JSON.parse(l); } catch { continue; }
    if (parsed.data === undefined && parsed.errors === undefined) continue;
    if (!merged) merged = {};
    if (parsed.data !== undefined && merged.data === undefined) merged.data = parsed.data;
    if (parsed.errors !== undefined) merged.errors = [...(merged.errors || []), ...parsed.errors];
  }
  if (merged) return merged;
  return JSON.parse(clean);
}

// ─── Delete listing ───────────────────────────────────────────────────────────

async function deleteListing(listingId, sellingTabId, tokens) {
  const deleteDocId = await getDocId(
    sellingTabId,
    'useCometMarketplaceForSaleItemDeleteMutation_facebookRelayOperation'
  );
  if (!deleteDocId) throw new Error('Could not extract delete doc_id from selling tab');

  console.log('[Relister v3] deleteListing:', listingId, 'doc_id:', deleteDocId);

  const json = await fbGraphQL(
    tokens,
    deleteDocId,
    'useCometMarketplaceForSaleItemDeleteMutation',
    {
      input: {
        client_mutation_id:    '-1',
        actor_id:              tokens.user_id,
        batch_delete_variants: true,
        for_sale_item_id:      listingId,
        referral_surface:      'MARKETPLACE_INSIGHTS',
        surface:               'MARKETPLACE_PAGE_SELLING'
      }
    },
    SELLING_URL,
    sellingTabId
  );

  if (json?.errors?.length) {
    console.error('[Relister v3] Delete errors:', JSON.stringify(json.errors, null, 2));
    throw new Error('Delete failed: ' + json.errors[0]?.message);
  }
  console.log('[Relister v3] deleteListing OK');
}

// ─── Edit-page read ───────────────────────────────────────────────────────────
// Opens /marketplace/edit/?listing_id=<id> and reads the page-embedded JSON.
// PROVEN: the CometMarketplaceComposerRootComponentQuery GraphQL call fails from a
// background fetch (missing __rev/__s/__hsi/__dyn/__csr browser context → data.listing
// null). Reading inline <script type="application/json"> is reliable instead.
// SOURCE OF TRUTH for: category_id (correct one — item page has a different/wrong id),
// title, redacted_description. Also grabs price/currency as a fallback.

async function readEditPage(listingId) {
  const editUrl = `https://www.facebook.com/marketplace/edit/?listing_id=${listingId}`;
  const tabId   = await openTab(editUrl);

  try {
    await new Promise(r => setTimeout(r, 3500)); // SPA settle

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world:  'MAIN',
      func: () => {
        function deepFind(obj, key, seen, depth) {
          if (!obj || typeof obj !== 'object' || (depth || 0) > 30) return null;
          if (!seen) seen = new Set();
          if (seen.has(obj)) return null;
          seen.add(obj);
          if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
          const vals = Array.isArray(obj) ? obj : Object.values(obj);
          for (const v of vals) { const f = deepFind(v, key, seen, (depth || 0) + 1); if (f != null) return f; }
          return null;
        }
        function deepFindAll(obj, key, collect, seen, depth) {
          if (!obj || typeof obj !== 'object' || (depth || 0) > 30) return;
          if (!seen) seen = new Set();
          if (seen.has(obj)) return;
          seen.add(obj);
          if (Object.prototype.hasOwnProperty.call(obj, key)) collect.push(obj[key]);
          const vals = Array.isArray(obj) ? obj : Object.values(obj);
          for (const v of vals) deepFindAll(v, key, collect, seen, (depth || 0) + 1);
        }
        const scripts = Array.from(document.getElementsByTagName('script')).filter(s => s.type === 'application/json');
        const out = { category_id: null, title: null, redacted_description: null, price: null, currency: null, condition_composer: null, edit_doc_id: null };
        // Edit-mutation doc_id (for the create→edit→delete condition step). The
        // operation id is global, not per-listing, so the source listing's edit
        // page yields the same doc_id the new listing's edit will need.
        try { out.edit_doc_id = window.require('useCometMarketplaceListingEditMutation_facebookRelayOperation'); } catch (e) {}
        for (const s of scripts) {
          let d; try { d = JSON.parse(s.textContent); } catch { continue; }
          if (!out.category_id) out.category_id = deepFind(d, 'marketplace_listing_category_id', new Set(), 0) || null;
          if (!out.title)       out.title       = deepFind(d, 'marketplace_listing_title', new Set(), 0) || null;
          if (!out.redacted_description) {
            for (const dk of ['redacted_description', 'description']) {
              const rd = deepFind(d, dk, new Set(), 0);
              const t = !rd ? '' : (typeof rd === 'string' ? rd : (rd && rd.text) || '');
              if (t.length > 5) { out.redacted_description = t; break; }
            }
          }
          if (out.price == null) {
            const lps = []; deepFindAll(d, 'listing_price', lps, new Set(), 0);
            // A page embeds several price nodes: a bare {amount} stub (no currency)
            // plus the hydrated {amount, currency} node. Take the amount from the best
            // node (prefer one carrying a currency); if the chosen node has no currency,
            // borrow it from ANY price node that does — so we never silently mislabel.
            // num() is comma-safe so locale-formatted amounts don't read as NaN.
            const num = v => parseFloat(String(v).replace(/,/g, ''));
            let chosen = null, anyCurrency = null;
            for (const lp of lps) {
              if (!lp || typeof lp !== 'object') continue;
              if (lp.currency && !anyCurrency) anyCurrency = lp.currency;
              if (lp.amount != null && num(lp.amount) > 0) {
                if (lp.currency) { chosen = lp; break; }
                if (!chosen) chosen = lp;
              }
            }
            if (chosen) { out.price = String(chosen.amount); out.currency = chosen.currency || anyCurrency || out.currency; }
          }
          if (!out.condition_composer) {
            // GOLD source for the buyer-visible condition: the composer attribute_data
            // node. Shape: [{ attribute_name:"Condition", attribute_type:"CONDITION",
            // value:"used_good", label:"Used - Good", … }]. `value` is the composer
            // value we feed straight back into attribute_data_json on the edit step.
            const ads = []; deepFindAll(d, 'attribute_data', ads, new Set(), 0);
            for (const ad of ads) {
              if (!Array.isArray(ad)) continue;
              const cond = ad.find(a => a && (a.attribute_type === 'CONDITION' ||
                (a.attribute_name && String(a.attribute_name).toLowerCase() === 'condition')));
              if (cond && cond.value) { out.condition_composer = String(cond.value); break; }
            }
          }
          if (out.category_id && out.title && out.redacted_description && out.price && out.condition_composer) break;
        }
        return out;
      }
    });

    const data = results[0]?.result ?? { category_id: null, title: null, redacted_description: null, price: null, currency: null, condition_composer: null, edit_doc_id: null };
    console.log('[Relister v3] readEditPage — category_id:', data.category_id, 'title:', (data.title || '').substring(0, 40), 'desc:', (data.redacted_description || '').length, 'chars', 'condition_composer:', data.condition_composer, 'edit_doc_id:', data.edit_doc_id ? 'yes' : 'no');
    return data;
  } finally {
    chrome.tabs.remove(tabId).catch(() => {});
  }
}

// ─── Item-page read ───────────────────────────────────────────────────────────
// Opens /marketplace/item/<id>/ and reads inline JSON for photos, location, and
// price/currency (from the hydrated listing_price node — NOT the category, which is
// wrong here; category comes from the edit page).

async function readItemPage(listingId) {
  const itemUrl = `https://www.facebook.com/marketplace/item/${listingId}/`;
  const tabId   = await openTab(itemUrl);

  try {
    await new Promise(r => setTimeout(r, 3000)); // SPA settle

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world:  'MAIN',
      func: () => {
        function deepFind(obj, key, seen, depth) {
          if (!obj || typeof obj !== 'object' || (depth || 0) > 40) return null;
          if (!seen) seen = new Set();
          if (seen.has(obj)) return null;
          seen.add(obj);
          if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
          const vals = Array.isArray(obj) ? obj : Object.values(obj);
          for (const v of vals) { const f = deepFind(v, key, seen, (depth || 0) + 1); if (f != null) return f; }
          return null;
        }
        function deepFindAll(obj, key, collect, seen, depth) {
          if (!obj || typeof obj !== 'object' || (depth || 0) > 40) return;
          if (!seen) seen = new Set();
          if (seen.has(obj)) return;
          seen.add(obj);
          if (Object.prototype.hasOwnProperty.call(obj, key)) collect.push(obj[key]);
          const vals = Array.isArray(obj) ? obj : Object.values(obj);
          for (const v of vals) deepFindAll(v, key, collect, seen, (depth || 0) + 1);
        }
        const out = { photo_uris: [], latitude: null, longitude: null, price: null, currency: null, redacted_description: null, condition: null };
        const scripts = Array.from(document.getElementsByTagName('script')).filter(s => s.type === 'application/json');
        for (const s of scripts) {
          let d; try { d = JSON.parse(s.textContent); } catch { continue; }
          if (out.latitude == null) {
            const loc = deepFind(d, 'location', new Set(), 0);
            if (loc && loc.latitude != null) { out.latitude = loc.latitude; out.longitude = loc.longitude; }
          }
          if (!out.redacted_description) {
            for (const dk of ['redacted_description', 'description']) {
              const rd = deepFind(d, dk, new Set(), 0);
              const t = !rd ? '' : (typeof rd === 'string' ? rd : (rd && rd.text) || '');
              if (t.length > 5) { out.redacted_description = t; break; }
            }
          }
          if (!out.photo_uris.length) {
            const arrs = []; deepFindAll(d, 'listing_photos', arrs, new Set(), 0);
            for (const arr of arrs) {
              if (Array.isArray(arr) && arr[0]?.image?.uri) { out.photo_uris = arr.map(p => p?.image?.uri).filter(Boolean); break; }
            }
          }
          if (out.price == null) {
            const lps = []; deepFindAll(d, 'listing_price', lps, new Set(), 0);
            // A page embeds several price nodes: a bare {amount} stub (no currency)
            // plus the hydrated {amount, currency} node. Take the amount from the best
            // node (prefer one carrying a currency); if the chosen node has no currency,
            // borrow it from ANY price node that does — so we never silently mislabel.
            // num() is comma-safe so locale-formatted amounts don't read as NaN.
            const num = v => parseFloat(String(v).replace(/,/g, ''));
            let chosen = null, anyCurrency = null;
            for (const lp of lps) {
              if (!lp || typeof lp !== 'object') continue;
              if (lp.currency && !anyCurrency) anyCurrency = lp.currency;
              if (lp.amount != null && num(lp.amount) > 0) {
                if (lp.currency) { chosen = lp; break; }
                if (!chosen) chosen = lp;
              }
            }
            if (chosen) { out.price = String(chosen.amount); out.currency = chosen.currency || anyCurrency || out.currency; }
          }
          // Condition — the item's OWN value lives on the renderable target node.
          // Fine-grained (PC_USED_GOOD / NEW_ITEM…) for real listings; coarse
          // (USED / NEW) when none was ever set. Normalised later in relist().
          if (!out.condition) {
            const rt = deepFind(d, 'marketplace_listing_renderable_target', new Set(), 0);
            const c = rt && rt.condition;
            if (c) out.condition = String(c);
          }
          if (out.latitude != null && out.photo_uris.length && out.price != null && out.condition) break;
        }
        return out;
      }
    });

    const data = results[0]?.result ?? { photo_uris: [], latitude: null, longitude: null, price: null, currency: null, condition: null };
    console.log('[Relister v3] readItemPage — photos:', data.photo_uris.length, 'lat:', data.latitude, 'price:', data.price, data.currency, 'condition:', data.condition);
    return data;
  } finally {
    chrome.tabs.remove(tabId).catch(() => {});
  }
}

// ─── Photo re-upload ──────────────────────────────────────────────────────────
// Runs IN THE PAGE (facebook.com origin) via executeScript. upload.facebook.com
// rejects uploads that don't originate from a facebook.com context, so a service-
// worker fetch returns no photoID. This mirrors the proven page-context flow.
// `pageTabId` must be a loaded facebook.com tab (the selling tab).

async function reuploadPhotos(uris, tokens, pageTabId) {
  if (!pageTabId) throw new Error('reuploadPhotos: no facebook.com tab to upload from');

  const results = await chrome.scripting.executeScript({
    target: { tabId: pageTabId },
    world:  'MAIN',
    args:   [uris, tokens],
    func: async (uris, tokens) => {
      const ids = [];
      for (const uri of uris) {
        try {
          const r = await fetch(uri); // signed CDN URL — no credentials needed
          if (!r.ok) continue;
          const blob = await r.blob();
          const form = new FormData();
          form.append('fb_dtsg',    tokens.fb_dtsg);
          form.append('target_id',  tokens.marketplace_id);
          form.append('source',     '8');
          form.append('profile_id', tokens.user_id);
          form.append('farr',       blob, 'photo.jpg');
          const up = await fetch(
            `https://upload.facebook.com/ajax/react_composer/attachments/photo/upload` +
            `?av=${tokens.user_id}&__user=${tokens.user_id}&__a=1&fb_dtsg=${encodeURIComponent(tokens.fb_dtsg)}`,
            { method: 'POST', body: form, credentials: 'include' }
          );
          const t = await up.text();
          let pid = null;
          try { pid = JSON.parse(t.replace(/^for\s*\(;;\);/, '').trim())?.payload?.photoID; } catch (e) {}
          if (pid) ids.push(pid);
        } catch (e) { /* skip this photo */ }
      }
      return ids;
    }
  });

  const ids = results[0]?.result ?? [];
  console.log('[Relister v3] reuploadPhotos (page-context):', ids.length, 'of', uris.length, 'uploaded');
  return ids;
}

// ─── Create listing ───────────────────────────────────────────────────────────
// MINIMAL common payload (extra fields cause noncoercible_variable_value).

async function apiCreate(common, tokens, createDocId, pageTabId) {
  console.log('[Relister v3] apiCreate — payload keys:', Object.keys(common));

  const json = await fbGraphQL(
    tokens,
    createDocId,
    'useCometMarketplaceListingCreateMutation',
    {
      input: {
        client_mutation_id: '-1',
        actor_id:           tokens.user_id,
        audience:           { marketplace: { marketplace_id: tokens.marketplace_id } },
        data:               { common }
      }
    },
    'https://www.facebook.com/marketplace/create/item',
    pageTabId
  );

  if (json?.errors?.length) {
    console.error('[Relister v3] apiCreate errors:', JSON.stringify(json.errors, null, 2));
    throw new Error('Create failed: ' + json.errors[0]?.message);
  }

  const newId = json?.data?.marketplace_listing_create?.listing?.id ?? null;
  if (!newId) throw new Error('Create mutation returned no listing ID');
  return newId;
}

// ─── Edit listing (write buyer-visible condition) ─────────────────────────────
// The CREATE mutation rejects `attribute_data_json` with field_exception, but the
// EDIT mutation accepts it. We create the listing (basic), then re-edit it in place
// to write the `attribute_data` that renders the "Condition: …" row to buyers.
// Edit keeps the SAME listing id (no new URL/age). Returns that id.

async function editListing(listingId, common, tokens, editDocId, pageTabId) {
  console.log('[Relister v3] editListing — listingId:', listingId, 'payload keys:', Object.keys(common));

  const json = await fbGraphQL(
    tokens,
    editDocId,
    'useCometMarketplaceListingEditMutation',
    {
      input: {
        client_mutation_id: '-1',
        actor_id:           tokens.user_id,
        data:               { common },
        listing_id:         listingId
      }
    },
    'https://www.facebook.com/marketplace/edit/',
    pageTabId
  );

  if (json?.errors?.length) {
    console.error('[Relister v3] editListing errors:', JSON.stringify(json.errors, null, 2));
    throw new Error('Edit failed: ' + json.errors[0]?.message);
  }

  const editedId = json?.data?.marketplace_listing_edit?.listing?.id ?? null;
  if (!editedId) throw new Error('Edit mutation returned no listing ID');
  return editedId;
}

// ─── Post-create description verification ─────────────────────────────────────
// Reads back the new listing's item page to confirm the description was saved.
// Retries up to 2 times with ~3s delays. Returns true if verified (or if we
// sent an empty description — nothing to verify). Returns false if mismatch.

async function verifyDescriptionSaved(newId, sentDescription) {
  if (!sentDescription || sentDescription.trim().length === 0) {
    console.log('[Relister v3] verifyDescriptionSaved: no description sent, skipping check');
    return true;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    console.log(`[Relister v3] verifyDescriptionSaved attempt ${attempt}/2 — newId:`, newId);
    await new Promise(r => setTimeout(r, attempt === 1 ? 1500 : 2500));

    try {
      const itemUrl = `https://www.facebook.com/marketplace/item/${newId}/`;
      const tabId   = await openTab(itemUrl);

      let readBack = null;
      try {
        await new Promise(r => setTimeout(r, 2500)); // SPA settle
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world:  'MAIN',
          func: () => {
            function deepFind(obj, key, seen, depth) {
              if (!obj || typeof obj !== 'object' || (depth || 0) > 40) return null;
              if (!seen) seen = new Set();
              if (seen.has(obj)) return null;
              seen.add(obj);
              if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
              const vals = Array.isArray(obj) ? obj : Object.values(obj);
              for (const v of vals) { const f = deepFind(v, key, seen, (depth || 0) + 1); if (f != null) return f; }
              return null;
            }
            const scripts = Array.from(document.getElementsByTagName('script')).filter(s => s.type === 'application/json');
            for (const s of scripts) {
              let d; try { d = JSON.parse(s.textContent); } catch { continue; }
              for (const dk of ['redacted_description', 'description']) {
                const rd = deepFind(d, dk, new Set(), 0);
                const t = !rd ? '' : (typeof rd === 'string' ? rd : (rd && rd.text) || '');
                if (t.length > 5) return t;
              }
            }
            return null;
          }
        });
        readBack = results[0]?.result ?? null;
      } finally {
        chrome.tabs.remove(tabId).catch(() => {});
      }

      if (readBack && readBack.trim().length > 0) {
        console.log('[Relister v3] verifyDescriptionSaved: confirmed, chars:', readBack.length);
        return true;
      }
      console.warn('[Relister v3] verifyDescriptionSaved: attempt', attempt, '— description not found on readback');
    } catch (e) {
      console.warn('[Relister v3] verifyDescriptionSaved: attempt', attempt, 'error:', e.message);
    }
  }

  console.error('[Relister v3] verifyDescriptionSaved: FAILED after 3 attempts');
  return false;
}

// ─── Relist orchestration ─────────────────────────────────────────────────────

async function relist(listingId, sellingTabId, isPro = false) {
  console.log('[Relister v3] relist START listingId:', listingId, 'sellingTabId:', sellingTabId, 'isPro:', isPro);

  // ── 0. Load settings ──────────────────────────────────────────────────────────
  const settings = await getSettings();

  // ── 1. Tokens (required before opening any tabs) ─────────────────────────────
  const tokens = await getTokens(sellingTabId);
  console.log('[Relister v3] tokens OK — user_id:', tokens.user_id, 'marketplace_id:', tokens.marketplace_id);

  // ── 2. Create doc_id (cached — opens /marketplace/create/item only on cache miss) ──
  status('Reading…');
  const createKey   = 'useCometMarketplaceListingCreateMutation_facebookRelayOperation';
  const createDocId = await getOrFetchDocId(createKey, 'https://www.facebook.com/marketplace/create/item');
  if (!createDocId) throw new Error('Could not extract create doc_id from create page');
  console.log('[Relister v3] createDocId:', createDocId);

  // ── 3. Read listing data (page-embedded JSON — composer GraphQL is unusable from SW) ──
  // Edit page = correct category_id + title + redacted_description (+ price fallback)
  // Item page = photos + location + price/currency
  const edit = await readEditPage(listingId);
  const item = await readItemPage(listingId);

  const categoryId  = String(edit.category_id ?? '');
  const title       = String(edit.title ?? '');
  let   description = String(edit.redacted_description ?? item.redacted_description ?? '');
  // FB's create mutation takes an integer-dollar price string. Round (don't truncate)
  // so "9.99" → "10" rather than "9"; comma-safe so locale-formatted amounts survive.
  const priceRaw    = (() => {
    const n = parseFloat(String(item.price ?? edit.price ?? '').replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? String(Math.round(n)) : '';
  })();
  const currency    = String(item.currency ?? edit.currency ?? 'AUD');
  const latitude    = Number(item.latitude  ?? 0);
  const longitude   = Number(item.longitude ?? 0);
  let   condition   = normalizeCondition(item.condition);
  // Composer value for the buyer-visible condition row. Prefer the edit page's
  // attribute_data (the exact value the seller picked); fall back to the item
  // page's renderable enum mapped down to a composer value.
  let   composerCondition = conditionToComposer(edit.condition_composer || item.condition);
  const uris        = item.photo_uris;

  if (!title)      throw new Error('Could not read title (edit page)');
  if (!categoryId) throw new Error('Could not read category_id (edit page)');
  if (!priceRaw)   throw new Error('Could not read price (item/edit page)');

  console.log('[Relister v3] read OK — title:', title.substring(0, 50),
    'category_id:', categoryId, 'price:', priceRaw, currency, 'desc:', description.length, 'chars',
    'condition:', condition, 'composerCondition:', composerCondition);

  // ── 3a. AI enhance (Feature 1) — Pro only ────────────────────────────────────
  // Route: BYO key (Advanced) → direct Gemini via ai.js
  //        No BYO key (default) → provided-AI proxy at relist.nowoly.com/api/ai
  let aiNote = null; // set when AI is skipped/unavailable — surfaced in final status
  if (isPro && settings.aiEnhanceOnRelist) {
    const hasBYOKey = !!(settings.geminiApiKey && settings.geminiApiKey.trim());
    const item = { title, photoUrls: uris, currentDescription: description, price: priceRaw, currency };

    if (hasBYOKey && typeof self.generateListingCopy === 'function') {
      // Advanced: use user's own Gemini key
      console.log('[Relister v3] AI enhance — BYO key path (generateListingCopy)');
      try {
        const ai = await self.generateListingCopy(item, settings);
        if (ai && ai.description && ai.description.trim().length > 0) {
          console.log('[Relister v3] AI (BYO) description applied, chars:', ai.description.length);
          description = ai.description;
        }
      } catch (aiErr) {
        console.warn('[Relister v3] AI (BYO) enhance failed — falling back:', aiErr.message);
        aiNote = 'AI temporarily unavailable';
      }
    } else if (!hasBYOKey && typeof self.generateListingCopyViaProxy === 'function') {
      // Default: provided AI via proxy (no user key required)
      console.log('[Relister v3] AI enhance — proxy path (relist.nowoly.com/api/ai)');
      try {
        const ai = await self.generateListingCopyViaProxy(item, settings);
        if (ai && ai.description && ai.description.trim().length > 0) {
          console.log('[Relister v3] AI (proxy) description applied, chars:', ai.description.length);
          description = ai.description;
        }
      } catch (aiErr) {
        console.warn('[Relister v3] AI (proxy) enhance failed — falling back:', aiErr.message);
        aiNote = 'AI temporarily unavailable';
      }
    }
  }

  // ── 3b. Price drop (Feature 2) — Pro only ────────────────────────────────────
  let finalPrice = priceRaw;
  if (isPro && settings.priceDropEnabled && priceRaw) {
    const numericPrice = Number(priceRaw);
    let newPrice;
    if (settings.priceDropType === 'percent') {
      newPrice = Math.round(numericPrice * (1 - settings.priceDropValue / 100));
    } else {
      newPrice = numericPrice - settings.priceDropValue;
    }
    // Clamp to floor and minimum of 1
    newPrice = Math.max(newPrice, settings.priceFloor, 1);
    finalPrice = String(newPrice);
    console.log('[Relister v3] Price drop applied:', priceRaw, '→', finalPrice,
      '(type:', settings.priceDropType, 'value:', settings.priceDropValue, 'floor:', settings.priceFloor, ')');
  }

  // ── 4. Photo URIs (from item page read) ───────────────────────────────────────
  status('Photos…');
  if (!uris.length) throw new Error('No photos found for listing — cannot relist');

  // ── 5. Re-upload photos ───────────────────────────────────────────────────────
  const freshPhotoIds = await reuploadPhotos(uris, tokens, sellingTabId);
  if (!freshPhotoIds.length) throw new Error('Photo re-upload failed — no photoIDs obtained');
  console.log('[Relister v3] freshPhotoIds:', freshPhotoIds);

  // ── 6. Build payload ──────────────────────────────────────────────────────────
  // CRITICAL: description MUST be { text: "..." } (TextWithEntities object) — a bare
  // string causes noncoercible_variable_value, and `redacted_description` is silently
  // dropped (not saved). Keep the field set tight. Optional condition field
  // is added only when present — proven to persist live.
  //   • condition: PC_USED_* / NEW_ITEM enum ONLY (composer 'used_good' → noncoercible)
  const common = {
    title,
    description: { text: description },
    item_price:  { currency, price: finalPrice },
    category_id: categoryId,
    photo_ids:   freshPhotoIds,
    latitude,
    longitude,
    surface:     'composer',
    is_preview:  false,
    sku:         '1'
  };
  if (condition)   common.condition = condition;

  // ── 7. Create new listing ─────────────────────────────────────────────────────
  status('Posting…');
  const newId = await apiCreate(common, tokens, createDocId, sellingTabId);
  console.log('[Relister v3] Created new listing:', newId);

  // ── 7a. Post-create verification (Feature 5) ──────────────────────────────────
  // Verify description was saved before deleting old listing.
  status('Verifying…');
  const descVerified = await verifyDescriptionSaved(newId, description);
  if (!descVerified && description.trim().length > 0) {
    console.error('[Relister v3] Description verification failed — keeping old listing for safety');
    const warnMsg = 'Relisted ✓ — could not confirm description saved; OLD listing kept, please check' + (aiNote ? ` · ${aiNote}` : '');
    status(warnMsg);
    await chrome.storage.local.set({ lastNewId: newId });
    return { ok: true, newId, warning: 'desc-unverified' };
  }
  console.log('[Relister v3] Description verification passed');

  // ── 7b. Make condition BUYER-VISIBLE (Feature 6) ──────────────────────────────
  // CREATE rejects attribute_data_json (field_exception); EDIT accepts it. Re-edit
  // the freshly-created listing in place to write the `attribute_data` that renders
  // the "Condition: …" row to buyers. Same id (edit, not recreate). Non-fatal: the
  // listing is already live, so a failure here only forfeits the visible-condition
  // row — we still proceed to delete the old listing and report success.
  if (composerCondition) {
    status('Condition…');
    try {
      let editDocId = edit.edit_doc_id;
      if (!editDocId) {
        const t = await openTab(`https://www.facebook.com/marketplace/edit/?listing_id=${newId}`);
        try { editDocId = await getDocId(t, 'useCometMarketplaceListingEditMutation_facebookRelayOperation'); }
        finally { chrome.tabs.remove(t).catch(() => {}); }
      }
      if (!editDocId) throw new Error('No edit doc_id available');

      // Fresh photo IDs for the edit — upload IDs are single-use once attached to the
      // create, so re-upload rather than reusing the (now-spent) freshPhotoIds. If the
      // re-upload fails entirely, the spent create IDs would corrupt the listing's
      // photos, so skip the edit (non-fatal — the listing is already live).
      const editPhotoIds = await reuploadPhotos(uris, tokens, sellingTabId);
      if (!editPhotoIds.length) throw new Error('photo re-upload for edit returned no IDs — skipping condition edit');
      const editCommon = {
        ...common,
        photo_ids:           editPhotoIds,
        attribute_data_json: JSON.stringify({ condition: composerCondition })
      };
      const editedId = await editListing(newId, editCommon, tokens, editDocId, sellingTabId);
      if (editedId !== newId) throw new Error(`edit returned unexpected id ${editedId} (expected ${newId})`);
      console.log('[Relister v3] Condition applied (visible):', composerCondition, '— id', editedId);
    } catch (e) {
      console.warn('[Relister v3] Condition edit failed (listing still live without visible condition):', e.message);
    }
  }

  // ── 8. Delete old listing (only after successful create + verification) ────────
  status('Deleting…');
  try {
    await deleteListing(listingId, sellingTabId, tokens);
  } catch (e) {
    console.error('[Relister v3] Delete failed (new listing is live):', e.message);
    // Don't throw — new listing is live; surface warning via status
    const delFailMsg = 'Relisted ✓ (old listing delete failed — remove manually)' + (aiNote ? ` · ${aiNote}` : '');
    status(delFailMsg);
    await chrome.storage.local.set({ lastNewId: newId });
    return { ok: true, newId };
  }

  // ── 9. Done ───────────────────────────────────────────────────────────────────
  status(aiNote ? `Relisted ✓ (${aiNote})` : 'Relisted ✓');
  await chrome.storage.local.set({ lastNewId: newId });
  console.log('[Relister v3] relist COMPLETE. newId:', newId);
  return { ok: true, newId };
}

// ─── Fetch live listing IDs ───────────────────────────────────────────────────
// Returns an array of listing ID strings for all IN_STOCK (live) listings.
// Three-tier strategy:
//   TIER 0 — harvest interceptor (window.__fbrHarvested, populated during loadAllCards)
//   TIER 1 — Comet + Fast GraphQL queries (background, paginated)
//   TIER 2 — inline DOM JSON scan (initial server-rendered batch only)

async function fetchLiveListingIds(sellingTabId, tokens) {
  // ── TIER 0: harvest interceptor ──────────────────────────────────────────────
  // Populated by the MAIN-world interceptor injected at page load, capturing ALL
  // GraphQL responses as content.js scrolls through the listing feed.
  const harvested = await readHarvestedListings(sellingTabId);
  if (harvested.length > 0) {
    const arr = harvested.map(x => x.id);
    console.log('[Relister v3] fetchLiveListingIds (harvest) found', arr.length, 'active listings');
    return arr;
  }

  // ── TIER 1: dual GraphQL queries ─────────────────────────────────────────────
  // Walk any object for active marketplace-listing node IDs.
  function collectNodes(obj, ids, seen, depth) {
    if (!obj || typeof obj !== 'object' || (depth || 0) > 45 || seen.has(obj)) return;
    seen.add(obj);
    const tn = obj.__typename;
    if ((tn === 'MarketplaceForSaleItem' || tn === 'GroupCommerceProductItem') &&
        obj.id && obj.marketplace_listing_title) {
      if (!(obj.is_sold || obj.is_pending || obj.is_draft)) ids.add(String(obj.id));
    }
    const vals = Array.isArray(obj) ? obj : Object.values(obj);
    for (const v of vals) collectNodes(v, ids, seen, (depth || 0) + 1);
  }
  function findPageInfo(o, s, d) {
    if (!o || typeof o !== 'object' || (d || 0) > 30 || s.has(o)) return null; s.add(o);
    if (o.page_info && typeof o.page_info === 'object' && 'has_next_page' in o.page_info) return o.page_info;
    for (const v of (Array.isArray(o) ? o : Object.values(o))) { const r = findPageInfo(v, s, d + 1); if (r) return r; }
    return null;
  }

  try {
    const ids = new Set();

    // 1a — CometMarketplaceYourListingsPaginationQuery (returns the "featured" section)
    const dynDoc = await getDocId(sellingTabId, 'CometMarketplaceYourListingsPaginationQuery_facebookRelayOperation');
    const cometDocId = dynDoc || '6206851639350477';
    try {
      let cursor = null;
      for (let page = 0; page < 10; page++) {
        const json = await fbGraphQL(
          tokens, cometDocId, 'CometMarketplaceYourListingsPaginationQuery',
          { count: 50, cursor, data: { filter: { state: 'LIVE', status: ['IN_STOCK'] }, marketplaceType: 'MARKETPLACE' }, scale: 1 },
          SELLING_URL, sellingTabId
        );
        if (json?.errors?.length) throw new Error(json.errors[0]?.message || 'graphql error');
        const before = ids.size;
        collectNodes(json?.data, ids, new Set(), 0);
        const pi = findPageInfo(json?.data, new Set(), 0);
        if (!pi || !pi.has_next_page || !pi.end_cursor || pi.end_cursor === cursor) break;
        if (ids.size === before && page > 0) break;
        cursor = pi.end_cursor;
      }
    } catch (e) {
      console.warn('[Relister v3] Comet query failed:', e.message);
    }

    // 1b — MarketplaceYouSellingFastActiveSectionPaginationQuery (all listings incl. older renewals)
    // doc_id 28117464584521827 confirmed live (enumerate.mjs 2026-06-27).
    const fastDocId = '28117464584521827';
    try {
      let cursor = null;
      for (let page = 0; page < 15; page++) {
        const json = await fbGraphQL(
          tokens, fastDocId, 'MarketplaceYouSellingFastActiveSectionPaginationQuery',
          {
            count: 24, cursor,
            order: 'CREATION_TIMESTAMP_DESC',
            scale: 2,
            state: 'LIVE',
            status: ['IN_STOCK'],
            title_search: null,
            __relay_internal__pv__ShouldUpdateMarketplaceBoostListingBoostedStatusrelayprovider: false,
          },
          SELLING_URL, sellingTabId
        );
        if (json?.errors?.length) break; // non-fatal: Comet results still valid
        const before = ids.size;
        collectNodes(json?.data, ids, new Set(), 0);
        // The Fast query wraps listings in first_listing; collect those too.
        function collectFastEdges(o, seen, d) {
          if (!o || typeof o !== 'object' || d > 40 || seen.has(o)) return;
          seen.add(o);
          if (o.first_listing && o.first_listing.id && o.first_listing.marketplace_listing_title &&
              !(o.first_listing.is_sold || o.first_listing.is_pending || o.first_listing.is_draft)) {
            ids.add(String(o.first_listing.id));
          }
          for (const v of (Array.isArray(o) ? o : Object.values(o))) collectFastEdges(v, seen, d + 1);
        }
        collectFastEdges(json?.data, new Set(), 0);
        const pi = findPageInfo(json?.data, new Set(), 0);
        if (!pi || !pi.has_next_page || !pi.end_cursor || pi.end_cursor === cursor) break;
        if (ids.size === before && page > 0) break;
        cursor = pi.end_cursor;
      }
    } catch (e) {
      console.warn('[Relister v3] Fast query failed:', e.message);
    }

    if (ids.size) {
      const arr = [...ids];
      console.log('[Relister v3] fetchLiveListingIds (GraphQL dual) found', arr.length, 'active listings');
      return arr;
    }
  } catch (e) {
    console.warn('[Relister v3] fetchLiveListingIds GraphQL tier failed:', e.message);
  }

  // ── TIER 2: inline DOM JSON scan ─────────────────────────────────────────────
  // Last resort: scan server-rendered JSON blobs (initial batch only, ~5 listings).
  const results = await chrome.scripting.executeScript({
    target: { tabId: sellingTabId }, world: 'MAIN',
    func: () => {
      const out = []; const ids = new Set();
      function walk(o, seen, depth) {
        if (!o || typeof o !== 'object' || (depth || 0) > 45 || seen.has(o)) return; seen.add(o);
        const tn = o.__typename;
        if ((tn === 'MarketplaceForSaleItem' || tn === 'GroupCommerceProductItem') && o.id && o.marketplace_listing_title) {
          if (!(o.is_sold || o.is_pending || o.is_draft) && !ids.has(String(o.id))) { ids.add(String(o.id)); out.push(String(o.id)); }
        }
        for (const v of (Array.isArray(o) ? o : Object.values(o))) walk(v, seen, (depth || 0) + 1);
      }
      for (const s of Array.from(document.getElementsByTagName('script')).filter(s => s.type === 'application/json')) {
        let d; try { d = JSON.parse(s.textContent); } catch { continue; } walk(d, new Set(), 0);
      }
      return out;
    }
  });
  const ids = results[0]?.result ?? [];
  console.log('[Relister v3] fetchLiveListingIds (JSON-scan fallback) found', ids.length, 'active listings');
  return ids;
}

// ─── Bulk relist (Feature 3) ──────────────────────────────────────────────────

// Core loop: relist an explicit array of ids, one by one, with delay between.
// Shared by relistAll (all live ids) and RELIST_SELECTED (user-picked subset).
// isPro is always true for bulk paths (already gated at message-handler level).
async function relistMany(ids, sellingTabId, isPro = true) {
  console.log('[Relister v3] relistMany START — count:', ids.length, 'sellingTabId:', sellingTabId, 'isPro:', isPro);

  const settings = await getSettings();

  if (!ids.length) {
    status('Done: no live listings found');
    return { done: 0, failed: 0 };
  }

  let done = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    status(`Relisting ${i + 1}/${ids.length}…`);
    console.log(`[Relister v3] relistMany [${i + 1}/${ids.length}] listingId:`, id);

    try {
      await relist(id, sellingTabId, isPro);
      done++;
      console.log(`[Relister v3] relistMany [${i + 1}/${ids.length}] OK — id:`, id);
    } catch (e) {
      failed++;
      errors.push({ id, error: e.message });
      console.error(`[Relister v3] relistMany [${i + 1}/${ids.length}] FAILED — id:`, id, 'error:', e.message);
    }

    // Delay between listings (skip after last one)
    if (i < ids.length - 1) {
      const delaySec = settings.bulkDelaySec > 0 ? settings.bulkDelaySec : 12;
      console.log('[Relister v3] relistMany — waiting', delaySec, 's before next listing');
      await new Promise(r => setTimeout(r, delaySec * 1000));
    }
  }

  const summary = `Done: Bulk relisted ${done}/${ids.length}${failed > 0 ? ` (${failed} failed)` : ''}`;
  status(summary);
  console.log('[Relister v3] relistMany COMPLETE —', summary, 'errors:', errors);
  return { done, failed, errors };
}

async function relistAll(sellingTabId, isPro = true) {
  console.log('[Relister v3] relistAll START — sellingTabId:', sellingTabId, 'isPro:', isPro);

  const tokens = await getTokens(sellingTabId);

  status('Fetching listings…');
  const ids = await fetchLiveListingIds(sellingTabId, tokens);
  console.log('[Relister v3] relistAll — found', ids.length, 'live listings:', ids);

  return relistMany(ids, sellingTabId, isPro);
}

// ─── Schedule: alarm management (Feature 4) ──────────────────────────────────

const ALARM_NAME = 'fbr_autorelist';

// Bulk-relist lock. MV3 service workers are killed after ~5 min, which would reset an
// in-memory flag and let a second bulk run start concurrently (double-posting every
// listing). Persist the lock to chrome.storage.session instead, with a 30-min stale
// guard so a crashed run can never lock the feature permanently.
const BULK_LOCK_KEY = 'fbr_bulk_running';
const BULK_LOCK_TTL = 30 * 60 * 1000;
async function isBulkRunning() {
  try {
    const v = (await chrome.storage.session.get(BULK_LOCK_KEY))[BULK_LOCK_KEY];
    return !!(v && v.ts && Date.now() - v.ts < BULK_LOCK_TTL);
  } catch { return false; }
}
async function setBulkRunning(on) {
  try {
    if (on) await chrome.storage.session.set({ [BULK_LOCK_KEY]: { ts: Date.now() } });
    else    await chrome.storage.session.remove(BULK_LOCK_KEY);
  } catch {}
}

async function syncAlarm() {
  const settings = await getSettings();

  if (!settings.scheduleEnabled) {
    chrome.alarms.clear(ALARM_NAME, cleared => {
      if (cleared) console.log('[Relister v3] Alarm cleared (schedule disabled)');
    });
    return;
  }

  const mode = settings.scheduleMode || 'interval';

  if (mode === 'interval' && settings.scheduleEveryHours > 0) {
    // Recurring interval — existing behaviour
    const periodInMinutes = settings.scheduleEveryHours * 60;
    chrome.alarms.get(ALARM_NAME, existing => {
      if (!existing || Math.abs((existing.periodInMinutes || 0) - periodInMinutes) > 1) {
        chrome.alarms.create(ALARM_NAME, { periodInMinutes, delayInMinutes: periodInMinutes });
        console.log('[Relister v3] Alarm (interval) created/updated — period:', periodInMinutes, 'min');
      }
    });

  } else if (mode === 'onetime' && settings.scheduleDateTime) {
    // Fire once at the chosen datetime
    const when = new Date(settings.scheduleDateTime).getTime();
    if (when > Date.now()) {
      const delayInMinutes = (when - Date.now()) / 60000;
      chrome.alarms.create(ALARM_NAME, { delayInMinutes });
      console.log('[Relister v3] Alarm (onetime) set — delay:', delayInMinutes.toFixed(1), 'min');
    } else {
      console.warn('[Relister v3] Onetime schedule datetime is in the past — alarm not set');
    }

  } else if (mode === 'daily' && settings.scheduleDateTime) {
    // Fire daily at HH:MM
    const [h, m] = settings.scheduleDateTime.split(':').map(Number);
    const next = new Date();
    next.setHours(h, m, 0, 0);
    if (next <= new Date()) next.setDate(next.getDate() + 1);
    const delayInMinutes = (next.getTime() - Date.now()) / 60000;
    chrome.alarms.create(ALARM_NAME, { delayInMinutes, periodInMinutes: 24 * 60 });
    console.log('[Relister v3] Alarm (daily) set — first fire in:', delayInMinutes.toFixed(1), 'min');

  } else if (mode === 'weekly' && settings.scheduleDateTime) {
    // Fire weekly on scheduleWeekday at HH:MM
    const [h, m] = settings.scheduleDateTime.split(':').map(Number);
    const targetDay = settings.scheduleWeekday ?? 1; // 0=Sun
    const next = new Date();
    next.setHours(h, m, 0, 0);
    const daysUntil = ((targetDay - next.getDay()) + 7) % 7 || 7;
    next.setDate(next.getDate() + daysUntil);
    const delayInMinutes = (next.getTime() - Date.now()) / 60000;
    chrome.alarms.create(ALARM_NAME, { delayInMinutes, periodInMinutes: 7 * 24 * 60 });
    console.log('[Relister v3] Alarm (weekly) set — first fire in:', delayInMinutes.toFixed(1), 'min');

  } else {
    chrome.alarms.clear(ALARM_NAME, () => {});
  }
}

// Find or open a selling tab, return its tabId
async function getOrOpenSellingTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.facebook.com/marketplace/you/selling*' });
  if (tabs.length > 0) {
    console.log('[Relister v3] getOrOpenSellingTab — found existing tab:', tabs[0].id);
    return { tabId: tabs[0].id, opened: false };
  }
  console.log('[Relister v3] getOrOpenSellingTab — opening new tab');
  const newTabId = await openTab(SELLING_URL);
  await new Promise(r => setTimeout(r, 2000)); // extra settle
  return { tabId: newTabId, opened: true };
}

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM_NAME) return;
  console.log('[Relister v3] Alarm fired:', ALARM_NAME);

  // Schedule is a Pro feature — verify before running
  const isProForAlarm = await getProStatus();
  if (!isProForAlarm) {
    console.warn('[Relister v3] Schedule alarm fired but user is not Pro — skipping. Upgrade to Pro to enable auto-relist.');
    status('Auto-relist paused — upgrade to Pro to enable scheduled relisting.');
    return;
  }

  if (await isBulkRunning()) {
    console.warn('[Relister v3] relistAll already in progress — skipping alarm');
    return;
  }

  await setBulkRunning(true);
  let openedTab = null;
  try {
    const { tabId, opened } = await getOrOpenSellingTab();
    if (opened) openedTab = tabId;
    await relistAll(tabId, true); // always Pro here (checked above)
  } catch (e) {
    console.error('[Relister v3] Alarm-triggered relistAll failed:', e.message);
    status('Error: schedule — ' + e.message);
  } finally {
    if (openedTab != null) chrome.tabs.remove(openedTab).catch(() => {});
    await setBulkRunning(false);
  }
});

// ─── Lifecycle hooks ──────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[Relister v3] onInstalled — syncing alarm, reason:', details.reason);
  syncAlarm();
  getLicenseUUID().catch(() => {}); // ensure UUID is generated on first install
  if (details.reason === 'install') {
    postEvent('install', { version: chrome.runtime.getManifest().version }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[Relister v3] onStartup — syncing alarm');
  syncAlarm();
});

// Re-create/clear alarm when settings change
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.fbr_settings) {
    console.log('[Relister v3] Settings changed — re-syncing alarm');
    syncAlarm();
  }
});

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // GET_TOKENS — used by content.js for the photo-map
  if (msg.kind === 'GET_TOKENS') {
    const tabId = sender.tab?.id ?? msg.tabId;
    getTokens(tabId)
      .then(sendResponse)
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  // INSTALL_HARVEST_INTERCEPTOR — content.js asks background to inject fetch+XHR
  // interceptor into MAIN world so all subsequent GraphQL responses are harvested.
  if (msg.kind === 'INSTALL_HARVEST_INTERCEPTOR') {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false, error: 'No tab ID' }); return false; }
    installHarvestInterceptor(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // INVALIDATE_LIVE_IDS_CACHE — content.js calls after loadAllCards so the post-harvest
  // applyFreeGating() call re-fetches all ~20 IDs rather than the cached pre-scroll count.
  if (msg.kind === 'INVALIDATE_LIVE_IDS_CACHE') {
    _liveIdsCache = null;
    sendResponse({ ok: true });
    return false;
  }

  // GET_PHOTO_MAP — content.js requests photo-filename → listing-id map.
  // TIER 0: harvest interceptor data (populated after loadAllCards scroll, complete ~20).
  // TIER 1: CometMarketplaceYourListingsPaginationQuery GraphQL fallback.
  if (msg.kind === 'GET_PHOTO_MAP') {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false, error: 'No tab ID' }); return false; }

    (async () => {
      // TIER 0: harvest interceptor — complete set after loadAllCards.
      const harvested = await readHarvestedListings(tabId);
      if (harvested.length > 0) {
        const photoMap = {};
        for (const item of harvested) {
          if (item.photoFilename) photoMap[item.photoFilename] = item.id;
        }
        console.log('[Relister v3] GET_PHOTO_MAP (harvest) returning', Object.keys(photoMap).length, 'entries from', harvested.length, 'listings');
        return photoMap;
      }

      // TIER 1: Comet GraphQL (initial batch only, ~5-10 listings — pre-scroll fallback).
      function photoUri(listing) {
        return listing.primary_listing_photo?.image?.uri
            ?? listing.listing_photos?.edges?.[0]?.node?.image?.uri
            ?? null;
      }
      function filenameFromUri(uri) {
        if (!uri) return null;
        try { return new URL(uri).pathname.split('/').pop() || null; }
        catch { return uri.split('/').pop()?.split('?')[0] || null; }
      }
      function collectPhotos(obj, map, seen, depth) {
        if (!obj || typeof obj !== 'object' || (depth || 0) > 45 || seen.has(obj)) return;
        seen.add(obj);
        const tn = obj.__typename;
        if ((tn === 'MarketplaceForSaleItem' || tn === 'GroupCommerceProductItem') &&
            obj.id && obj.marketplace_listing_title) {
          if (!(obj.is_sold || obj.is_pending || obj.is_draft)) {
            const uri = photoUri(obj);
            const fn  = filenameFromUri(uri);
            if (fn) map[fn] = String(obj.id);
          }
        }
        const vals = Array.isArray(obj) ? obj : Object.values(obj);
        for (const v of vals) collectPhotos(v, map, seen, (depth || 0) + 1);
      }
      function findPageInfoPM(o, s, d) {
        if (!o || typeof o !== 'object' || (d || 0) > 30 || s.has(o)) return null; s.add(o);
        if (o.page_info && typeof o.page_info === 'object' && 'has_next_page' in o.page_info) return o.page_info;
        for (const v of (Array.isArray(o) ? o : Object.values(o))) { const r = findPageInfoPM(v, s, d + 1); if (r) return r; }
        return null;
      }

      const tokens = await getTokens(tabId);
      const dynDoc = await getDocId(tabId, 'CometMarketplaceYourListingsPaginationQuery_facebookRelayOperation');
      const docId  = dynDoc || '6206851639350477';
      const photoMap = {};
      let cursor = null;
      for (let page = 0; page < 10; page++) {
        const json = await fbGraphQL(
          tokens, docId, 'CometMarketplaceYourListingsPaginationQuery',
          { count: 50, cursor, data: { filter: { state: 'LIVE', status: ['IN_STOCK'] }, marketplaceType: 'MARKETPLACE' }, scale: 1 },
          SELLING_URL,
          tabId
        );
        if (json?.errors?.length) throw new Error(json.errors[0]?.message || 'graphql error');
        collectPhotos(json?.data, photoMap, new Set(), 0);
        const pi = findPageInfoPM(json?.data, new Set(), 0);
        if (!pi || !pi.has_next_page || !pi.end_cursor || pi.end_cursor === cursor) break;
        cursor = pi.end_cursor;
      }
      return photoMap;
    })()
      .then(photoMap => sendResponse({ ok: true, photoMap }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // RELIST — main orchestration (free tier: 5/day limit; Pro: unlimited)
  if (msg.kind === 'RELIST') {
    const { listingId } = msg;
    const sellingTabId  = sender.tab?.id;

    if (!listingId) {
      sendResponse({ ok: false, error: 'Missing listingId' });
      return false;
    }
    if (!sellingTabId) {
      sendResponse({ ok: false, error: 'Could not determine selling tab ID' });
      return false;
    }

    (async () => {
      // Check paid status and enforce position-based free-tier limit (top 4 only)
      const isPro = await getProStatus();
      if (!isPro) {
        try {
          const liveIds = await getLiveIdsForGating(sellingTabId);
          const idx = liveIds.indexOf(String(listingId));
          if (idx >= FREE_LISTING_LIMIT) {
            postEvent('relist_blocked_free', { listingId }).catch(() => {});
            sendResponse({
              ok: false,
              error: 'Free plan: only your 4 most-recent listings can be relisted. Upgrade to Pro for unlimited relists.',
              proRequired: true,
            });
            return;
          }
        } catch (gatingErr) {
          console.warn('[Relister v3] Free-tier gating check failed (allowing relist):', gatingErr.message);
        }
      }

      try {
        const result = await relist(listingId, sellingTabId, isPro);
        if (result.ok) {
          postTelemetry(true, 'ok').catch(() => {});
          postEvent('relist_success', { listingId }).catch(() => {});
        }
        sendResponse(result);
      } catch (e) {
        console.error('[Relister v3] relist() threw:', e.message);
        status('Error: ' + e.message);
        postTelemetry(false, String(e.message).slice(0, 40)).catch(() => {});
        sendResponse({ ok: false, error: e.message });
      }
    })();

    return true; // keep channel open for async response
  }

  // RELIST_ALL — bulk relist from popup (Pro only)
  if (msg.kind === 'RELIST_ALL') {
    (async () => {
      // Bulk relist is a Pro feature
      const isProForBulk = await getProStatus();
      if (!isProForBulk) {
        sendResponse({
          ok: false,
          error: 'Bulk "Relist all" requires Pro. Upgrade for unlimited relists + bulk.',
          proRequired: true,
        });
        return;
      }

      if (await isBulkRunning()) {
        sendResponse({ ok: false, error: 'Bulk relist already in progress' });
        return;
      }
      await setBulkRunning(true);
      let openedTab = null;
      try {
        const { tabId, opened } = await getOrOpenSellingTab();
        if (opened) openedTab = tabId;
        const result = await relistAll(tabId, true);
        sendResponse({ ok: true, ...result });
      } catch (e) {
        console.error('[Relister v3] relistAll() threw:', e.message);
        status('Error: bulk relist — ' + e.message);
        sendResponse({ ok: false, error: e.message });
      } finally {
        if (openedTab != null) chrome.tabs.remove(openedTab).catch(() => {});
        await setBulkRunning(false);
      }
    })();
    return true; // keep channel open for async response
  }

  // RELIST_SELECTED — relist a user-chosen subset of listing ids (Pro only)
  if (msg.kind === 'RELIST_SELECTED') {
    if (!Array.isArray(msg.ids) || !msg.ids.length) {
      sendResponse({ ok: false, error: 'RELIST_SELECTED: ids must be a non-empty array' });
      return false;
    }
    (async () => {
      // Multi-select relist is a Pro feature
      const isProForSelected = await getProStatus();
      if (!isProForSelected) {
        sendResponse({
          ok: false,
          error: 'Multi-select relist requires Pro. Upgrade to unlock bulk and multi-select.',
          proRequired: true,
        });
        return;
      }

      if (await isBulkRunning()) {
        sendResponse({ ok: false, error: 'Bulk relist already in progress' });
        return;
      }
      await setBulkRunning(true);
      let openedTab = null;
      try {
        const { tabId, opened } = await getOrOpenSellingTab();
        if (opened) openedTab = tabId;
        const result = await relistMany(msg.ids, tabId, true);
        sendResponse({ ok: true, ...result });
      } catch (e) {
        console.error('[Relister v3] relistMany() (selected) threw:', e.message);
        status('Error: relist selected — ' + e.message);
        sendResponse({ ok: false, error: e.message });
      } finally {
        if (openedTab != null) chrome.tabs.remove(openedTab).catch(() => {});
        await setBulkRunning(false);
      }
    })();
    return true; // keep channel open for async response
  }

  // GET_LIVE_IDS — returns all live listing ids (for Select All in content.js)
  if (msg.kind === 'GET_LIVE_IDS') {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false, error: 'No tab ID' }); return false; }
    (async () => {
      try {
        const tokens = await getTokens(tabId);
        const ids = await fetchLiveListingIds(tabId, tokens);
        sendResponse({ ok: true, ids });
      } catch (e) {
        console.error('[Relister v3] GET_LIVE_IDS failed:', e.message);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // keep channel open for async response
  }

  // SYNC_ALARM — popup/options saved new schedule settings
  if (msg.kind === 'SYNC_ALARM') {
    syncAlarm().catch(e => console.warn('[Relister v3] SYNC_ALARM error:', e.message));
    sendResponse({ ok: true });
    return false;
  }

  // CHECK_PRO — popup/options asks for paid status
  if (msg.kind === 'CHECK_PRO') {
    (async () => {
      const isPro = await getProStatus();
      sendResponse({ isPro });
    })();
    return true;
  }

  // OPEN_PAYMENT_PAGE — open the Stripe upgrade page and fire analytics
  if (msg.kind === 'OPEN_PAYMENT_PAGE') {
    (async () => {
      try {
        const uuid = await getLicenseUUID();
        const url  = UPGRADE_URL_MONTHLY + '?client_reference_id=' + encodeURIComponent(uuid);
        await chrome.tabs.create({ url, active: true });
        postEvent('upgrade_click', {}).catch(() => {});
      } catch (e) {
        console.warn('[Relister v3] Could not open payment page:', e.message);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  // CLEAR_CACHE
  if (msg.kind === 'CLEAR_CACHE') {
    chrome.storage.local.remove([TOKEN_CACHE_KEY])
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});

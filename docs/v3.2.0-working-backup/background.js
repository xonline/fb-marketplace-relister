'use strict';

// background.js v3.1.0 — Direct API (GraphQL) relist
// Proven flow ported from relist-final.mjs.
// Fetches run in the SW directly (credentials:'include'); tokens/doc_ids
// extracted via executeInMainWorld (world:'MAIN', window.require).

// ─── Cache keys ───────────────────────────────────────────────────────────────
const TOKEN_CACHE_KEY = 'fbr_tokens_v1';
const TOKEN_TTL       = 60 * 60 * 1000;   // 1 hour

const SELLING_URL = 'https://www.facebook.com/marketplace/you/selling';

// ─── Status helper ────────────────────────────────────────────────────────────

function status(text) {
  chrome.storage.local.set({ status: text, statusTime: Date.now() });
}

// ─── Tab helpers ──────────────────────────────────────────────────────────────

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

  const marketplaceId = await extractMarketplaceIdFromTab(tabId);
  if (!marketplaceId) throw new Error('Could not find marketplace_id on selling page');

  const data = { user_id: userId, fb_dtsg: fbDtsg, marketplace_id: marketplaceId };
  await chrome.storage.local.set({ [TOKEN_CACHE_KEY]: { data, expiry: Date.now() + TOKEN_TTL } });
  return data;
}

// ─── Doc ID helpers ───────────────────────────────────────────────────────────

async function getDocId(tabId, key) {
  const mods = await executeInMainWorld(tabId, [key]);
  return mods[key] ?? null;
}

// ─── GraphQL POST helper ──────────────────────────────────────────────────────
// All fetches run in the SW (credentials:'include').

async function fbGraphQL(tokens, docId, friendlyName, variables, referrer) {
  const body = new URLSearchParams({
    av:                       tokens.user_id,
    __a:                      '1',
    __comet_req:              '1',
    fb_dtsg:                  tokens.fb_dtsg,
    fb_api_caller_class:      'RelayModern',
    fb_api_req_friendly_name: friendlyName,
    variables:                JSON.stringify(variables),
    doc_id:                   docId
  }).toString();

  const res = await fetch('https://www.facebook.com/api/graphql/', {
    method: 'POST',
    headers: {
      accept: '*/*',
      'accept-language': 'en-US,en;q=0.8',
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'sec-gpc': '1'
    },
    referrer,
    referrerPolicy: 'strict-origin-when-cross-origin',
    body,
    mode: 'cors',
    credentials: 'include'
  });

  const text  = await res.text();
  const clean = text.replace(/^for\s*\(;;\);/, '').trim();
  for (const line of clean.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try {
      const parsed = JSON.parse(l);
      if (parsed.data !== undefined || parsed.errors !== undefined) return parsed;
    } catch {}
  }
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
    SELLING_URL
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
        const out = { category_id: null, title: null, redacted_description: null, price: null, currency: null, tags: [] };
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
            for (const lp of lps) {
              if (lp && lp.amount != null && String(lp.amount) !== '0' && String(lp.amount) !== '') {
                out.price = String(lp.amount); out.currency = lp.currency || out.currency; break;
              }
            }
          }
          if (!out.tags.length) {
            const h = deepFind(d, 'marketplace_hashtags', new Set(), 0);
            if (h) {
              const arr = h.edges || h.nodes || [];
              const names = arr.map(e => (e && (e.tag_name || (e.node && e.node.tag_name)))).filter(Boolean);
              if (names.length) out.tags = names;
            }
          }
          if (out.category_id && out.title && out.redacted_description && out.price) break;
        }
        return out;
      }
    });

    const data = results[0]?.result ?? { category_id: null, title: null, redacted_description: null, price: null, currency: null, tags: [] };
    console.log('[Relister v3] readEditPage — category_id:', data.category_id, 'title:', (data.title || '').substring(0, 40), 'desc:', (data.redacted_description || '').length, 'chars');
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
        const out = { photo_uris: [], latitude: null, longitude: null, price: null, currency: null, redacted_description: null };
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
            for (const lp of lps) {
              if (lp && lp.amount != null && String(lp.amount) !== '0' && String(lp.amount) !== '') {
                out.price = String(lp.amount); out.currency = lp.currency || out.currency; break;
              }
            }
          }
          if (out.latitude != null && out.photo_uris.length && out.price != null) break;
        }
        return out;
      }
    });

    const data = results[0]?.result ?? { photo_uris: [], latitude: null, longitude: null, price: null, currency: null };
    console.log('[Relister v3] readItemPage — photos:', data.photo_uris.length, 'lat:', data.latitude, 'price:', data.price, data.currency);
    return data;
  } finally {
    chrome.tabs.remove(tabId).catch(() => {});
  }
}

// ─── Photo re-upload ──────────────────────────────────────────────────────────
// SW fetches each photo URL, posts it to upload.facebook.com, returns fresh photoIDs.

async function reuploadPhotos(uris, tokens) {
  const photoIds = [];

  for (let i = 0; i < uris.length; i++) {
    const uri = uris[i];
    console.log(`[Relister v3] reuploadPhotos [${i + 1}/${uris.length}]:`, uri.substring(0, 70));

    try {
      const imgRes = await fetch(uri, { credentials: 'include' });
      if (!imgRes.ok) throw new Error('Fetch failed: HTTP ' + imgRes.status);
      const blob = await imgRes.blob();

      const form = new FormData();
      form.append('fb_dtsg',     tokens.fb_dtsg);
      form.append('target_id',   tokens.marketplace_id);
      form.append('source',      '8');
      form.append('profile_id',  tokens.user_id);
      form.append('farr',        blob, 'photo.jpg');

      const uploadUrl = `https://upload.facebook.com/ajax/react_composer/attachments/photo/upload` +
        `?av=${tokens.user_id}&__user=${tokens.user_id}&__a=1&fb_dtsg=${encodeURIComponent(tokens.fb_dtsg)}`;

      const upRes = await fetch(uploadUrl, {
        method:      'POST',
        body:        form,
        credentials: 'include'
      });

      const text  = await upRes.text();
      const clean = text.replace(/^for\s*\(;;\);/, '').trim();
      const json  = JSON.parse(clean);
      const photoID = json?.payload?.photoID;

      if (!photoID) {
        console.warn('[Relister v3] reuploadPhotos: no photoID in response for', uri.substring(0, 60));
        continue;
      }

      console.log('[Relister v3] reuploadPhotos: photoID', photoID);
      photoIds.push(photoID);
    } catch (e) {
      console.warn('[Relister v3] reuploadPhotos: skipping photo', i + 1, '—', e.message);
    }
  }

  return photoIds;
}

// ─── Create listing ───────────────────────────────────────────────────────────
// MINIMAL common payload (extra fields cause noncoercible_variable_value).

async function apiCreate(common, tokens, createDocId) {
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
    'https://www.facebook.com/marketplace/create/item'
  );

  if (json?.errors?.length) {
    console.error('[Relister v3] apiCreate errors:', JSON.stringify(json.errors, null, 2));
    throw new Error('Create failed: ' + json.errors[0]?.message);
  }

  const newId = json?.data?.marketplace_listing_create?.listing?.id ?? null;
  if (!newId) throw new Error('Create mutation returned no listing ID');
  return newId;
}

// ─── Daily session counter ────────────────────────────────────────────────────

async function incrementRelistCount() {
  const today = new Date().toISOString().slice(0, 10);
  const data  = await chrome.storage.local.get(['relistCount', 'relistCountDate']);
  const count = (data.relistCountDate === today ? (data.relistCount || 0) : 0) + 1;
  await chrome.storage.local.set({ relistCount: count, relistCountDate: today });
}

// ─── Relist orchestration ─────────────────────────────────────────────────────

async function relist(listingId, sellingTabId) {
  console.log('[Relister v3] relist START listingId:', listingId, 'sellingTabId:', sellingTabId);

  // ── 1. Tokens (required before opening any tabs) ─────────────────────────────
  const tokens = await getTokens(sellingTabId);
  console.log('[Relister v3] tokens OK — user_id:', tokens.user_id, 'marketplace_id:', tokens.marketplace_id);

  // ── 2. Create doc_id (open /marketplace/create/item) ─────────────────────────
  status('Reading…');
  const createKey    = 'useCometMarketplaceListingCreateMutation_facebookRelayOperation';
  const createTabId  = await openTab('https://www.facebook.com/marketplace/create/item');
  let createDocId;
  try {
    createDocId = await getDocId(createTabId, createKey);
    if (!createDocId) throw new Error('Could not extract create doc_id from create page');
    console.log('[Relister v3] createDocId:', createDocId);
  } finally {
    chrome.tabs.remove(createTabId).catch(() => {});
  }

  // ── 3. Read listing data (page-embedded JSON — composer GraphQL is unusable from SW) ──
  // Edit page = correct category_id + title + redacted_description (+ price fallback)
  // Item page = photos + location + price/currency
  const edit = await readEditPage(listingId);
  const item = await readItemPage(listingId);

  const categoryId  = String(edit.category_id ?? '');
  const title       = String(edit.title ?? '');
  const description = String(edit.redacted_description ?? item.redacted_description ?? '');
  const priceRaw    = String(item.price ?? edit.price ?? '').replace(/,/g, '').replace(/\.\d+$/, '');
  const currency    = String(item.currency ?? edit.currency ?? 'AUD');
  const latitude    = Number(item.latitude  ?? 0);
  const longitude   = Number(item.longitude ?? 0);
  const tags        = Array.isArray(edit.tags) ? edit.tags : [];

  if (!title)      throw new Error('Could not read title (edit page)');
  if (!categoryId) throw new Error('Could not read category_id (edit page)');
  if (!priceRaw)   throw new Error('Could not read price (item/edit page)');

  console.log('[Relister v3] read OK — title:', title.substring(0, 50),
    'category_id:', categoryId, 'price:', priceRaw, currency, 'desc:', description.length, 'chars');

  // ── 4. Photo URIs (from item page read) ───────────────────────────────────────
  status('Photos…');
  const uris = item.photo_uris;
  if (!uris.length) throw new Error('No photos found for listing — cannot relist');

  // ── 5. Re-upload photos ───────────────────────────────────────────────────────
  const freshPhotoIds = await reuploadPhotos(uris, tokens);
  if (!freshPhotoIds.length) throw new Error('Photo re-upload failed — no photoIDs obtained');
  console.log('[Relister v3] freshPhotoIds:', freshPhotoIds);

  // ── 6. Build payload ──────────────────────────────────────────────────────────
  // CRITICAL: description MUST be { text: "..." } (TextWithEntities object) — a bare
  // string causes noncoercible_variable_value, and `redacted_description` is silently
  // dropped (not saved). Keep the field set tight; product_hashtag_names is safe.
  const common = {
    title,
    description: { text: description },
    item_price:  { currency, price: priceRaw },
    category_id: categoryId,
    photo_ids:   freshPhotoIds,
    latitude,
    longitude,
    product_hashtag_names: tags,
    surface:     'composer',
    is_preview:  false,
    sku:         '1'
  };

  // ── 7. Create new listing ─────────────────────────────────────────────────────
  status('Posting…');
  const newId = await apiCreate(common, tokens, createDocId);
  console.log('[Relister v3] Created new listing:', newId);

  // ── 8. Delete old listing (only after successful create) ──────────────────────
  status('Deleting…');
  try {
    await deleteListing(listingId, sellingTabId, tokens);
  } catch (e) {
    console.error('[Relister v3] Delete failed (new listing is live):', e.message);
    // Don't throw — new listing is live; surface warning via status
    status('Relisted ✓ (old listing delete failed — remove manually)');
    await incrementRelistCount();
    await chrome.storage.local.set({ lastNewId: newId });
    return { ok: true, newId };
  }

  // ── 9. Done ───────────────────────────────────────────────────────────────────
  status('Relisted ✓');
  await incrementRelistCount();
  await chrome.storage.local.set({ lastNewId: newId });
  console.log('[Relister v3] relist COMPLETE. newId:', newId);
  return { ok: true, newId };
}

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

  // RELIST — main orchestration
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

    relist(listingId, sellingTabId)
      .then(result => {
        sendResponse(result);
      })
      .catch(e => {
        console.error('[Relister v3] relist() threw:', e.message);
        status('Error: ' + e.message);
        sendResponse({ ok: false, error: e.message });
      });

    return true; // keep channel open for async response
  }

  // CLEAR_CACHE
  if (msg.kind === 'CLEAR_CACHE') {
    chrome.storage.local.remove([TOKEN_CACHE_KEY])
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});

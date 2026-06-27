'use strict';

// content.js v3.1.0 — API relist (background does all API calls)
// Runs only on: /marketplace/you/selling*
// Injects Relist buttons per listing card, sends RELIST message to background,
// reflects progress from chrome.storage.local.status onto the button.

const RELIST_CLASS = 'fbr-relist-btn';

// ─── listingId detection ──────────────────────────────────────────────────────

/**
 * PRIMARY: walk up from a card element to find the nearest <a> with a
 * /marketplace/item/<id>/ href and extract the numeric id.
 */
function extractIdFromCardDOM(card) {
  // Search within the card itself first
  const anchor = card.querySelector('a[href*="/marketplace/item/"]');
  if (anchor) {
    const m = anchor.href.match(/\/marketplace\/item\/(\d+)/);
    if (m) return m[1];
  }
  // Walk up to nearest ancestor that might wrap the link
  let el = card.parentElement;
  for (let i = 0; i < 5 && el; i++, el = el.parentElement) {
    const a = el.querySelector('a[href*="/marketplace/item/"]');
    if (a) {
      const m = a.href.match(/\/marketplace\/item\/(\d+)/);
      if (m) return m[1];
    }
  }
  return null;
}

// ─── Photo-map fallback (GraphQL) ─────────────────────────────────────────────
// Mirrors the v2.3.6 approach: paginated selling query → map photo filename → listingId

const LISTINGS_DOC_ID = '6206851639350477';
let _listingPhotoMap = null; // Map<photoFilename, listingId>

function getPhotoFilename(uri) {
  if (!uri) return null;
  try { return new URL(uri).pathname.split('/').pop() || null; }
  catch { return uri.split('/').pop()?.split('?')[0] || null; }
}

function deepFindPhotoMap(obj, key, seen) {
  if (!obj || typeof obj !== 'object') return null;
  if (!seen) seen = new Set();
  if (seen.has(obj)) return null;
  seen.add(obj);
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const found = deepFindPhotoMap(v, key, seen);
    if (found != null) return found;
  }
  return null;
}

async function fetchListingsPage(tokens, cursor) {
  const body = new URLSearchParams({
    av: tokens.user_id,
    __a: '1',
    __comet_req: '1',
    fb_dtsg: tokens.fb_dtsg,
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: 'MarketplaceYouSellingFastActiveSectionPaginationQuery',
    variables: JSON.stringify({
      count: 24,
      ...(cursor ? { cursor } : {}),
      order: 'CREATION_TIMESTAMP_DESC',
      scale: 2,
      state: 'LIVE',
      status: ['IN_STOCK'],
      title_search: null
    }),
    doc_id: LISTINGS_DOC_ID
  });

  const res = await fetch('https://www.facebook.com/api/graphql/', {
    method: 'POST',
    headers: { accept: '*/*', 'content-type': 'application/x-www-form-urlencoded' },
    referrer: 'https://www.facebook.com/marketplace/you/selling',
    referrerPolicy: 'strict-origin-when-cross-origin',
    body: body.toString(),
    mode: 'cors',
    credentials: 'include'
  });

  const text = await res.text();
  const objects = text.split('\n')
    .map(l => l.replace(/^for\s*\(;;\);/, '').trim())
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  let listingSets = null;
  let pageInfo = null;
  for (const obj of objects) {
    if (!listingSets) listingSets = deepFindPhotoMap(obj, 'marketplace_listing_sets');
    if (!pageInfo) {
      const pi = deepFindPhotoMap(obj, 'page_info');
      if (pi?.has_next_page !== undefined) pageInfo = pi;
    }
  }
  return { listingSets, pageInfo };
}

async function buildPhotoMap() {
  if (_listingPhotoMap) return _listingPhotoMap;

  // Get tokens via background
  const tokens = await chrome.runtime.sendMessage({ kind: 'GET_TOKENS' });
  if (tokens?.error) {
    console.warn('[Relister v3] Could not get tokens for photo map:', tokens.error);
    return null;
  }

  const map = new Map();
  let cursor = null;

  chrome.storage.local.set({ status: 'Loading your listings…', statusTime: Date.now() });

  try {
    for (let page = 0; page < 20; page++) {
      const { listingSets, pageInfo } = await fetchListingsPage(tokens, cursor);
      if (!listingSets) break;

      const edges = listingSets.edges ?? [];
      for (const edge of edges) {
        const listing = edge?.node?.first_listing;
        if (!listing?.id) continue;
        const filename = getPhotoFilename(listing.primary_listing_photo?.image?.uri);
        if (filename && !map.has(filename)) map.set(filename, String(listing.id));
      }

      if (!pageInfo?.has_next_page || !pageInfo?.end_cursor || pageInfo.end_cursor === cursor) break;
      cursor = pageInfo.end_cursor;
    }
  } catch (e) {
    console.warn('[Relister v3] Listing fetch failed:', e.message);
    return null;
  }

  _listingPhotoMap = map;
  const msg = map.size > 0
    ? 'Found ' + map.size + ' listings — scan in progress…'
    : 'API returned 0 listings';
  chrome.storage.local.set({ status: msg, statusTime: Date.now() });
  return map;
}

// ─── Button state helpers ─────────────────────────────────────────────────────

function setButtonState(btn, text, state) {
  btn.textContent = text;
  btn.dataset.state = state || '';
  btn.disabled = (state === 'busy' || state === 'done');
  btn.style.background =
    state === 'error' ? '#c62828' :
    state === 'done'  ? '#2e7d32' :
    '#1877f2';
  btn.style.opacity = (state === 'busy') ? '0.75' : '1';
}

// ─── Status polling ───────────────────────────────────────────────────────────

/**
 * While a relist is in progress, poll storage.local.status and reflect
 * the current phase text onto the button. Stops when state leaves 'busy'.
 */
function pollStatusOntoButton(btn) {
  const iv = setInterval(() => {
    chrome.storage.local.get(['status'], data => {
      const s = data.status || '';
      if (s.startsWith('Reading')) {
        setButtonState(btn, 'Reading…', 'busy');
      } else if (s.startsWith('Posting')) {
        setButtonState(btn, 'Posting…', 'busy');
      } else if (s.startsWith('Deleting')) {
        setButtonState(btn, 'Deleting…', 'busy');
      } else if (s.startsWith('Relisted') || s.startsWith('Done')) {
        clearInterval(iv);
        setButtonState(btn, 'Relisted ✓', 'done');
        setTimeout(() => location.reload(), 2500);
      } else if (s.startsWith('Error') || s.startsWith('error')) {
        clearInterval(iv);
        setButtonState(btn, 'Error ✗', 'error');
        setTimeout(() => setButtonState(btn, 'Relist', ''), 4000);
      }
    });
  }, 600);
  return iv;
}

// ─── Relist handler ───────────────────────────────────────────────────────────

let _relistInProgress = false;

async function relistItem(listingId, btn) {
  if (_relistInProgress) {
    btn.textContent = 'Please wait…';
    setTimeout(() => {
      if (btn.dataset.state !== 'busy' && btn.dataset.state !== 'done') {
        btn.textContent = 'Relist';
      }
    }, 2000);
    return;
  }
  _relistInProgress = true;
  setButtonState(btn, 'Starting…', 'busy');

  // Start polling status from storage onto button
  const pollIv = pollStatusOntoButton(btn);

  try {
    const res = await chrome.runtime.sendMessage({ kind: 'RELIST', listingId });

    // Clear poll — status should already be at a terminal state
    clearInterval(pollIv);

    if (res && res.ok) {
      if (res.newId) {
        chrome.storage.local.set({ lastNewId: res.newId });
      }
      setButtonState(btn, 'Relisted ✓', 'done');
      setTimeout(() => location.reload(), 2500);
    } else {
      const errMsg = (res && res.error) ? res.error : 'Unknown error';
      console.error('[Relister v3] Relist failed:', errMsg);
      setButtonState(btn, 'Error ✗', 'error');
      setTimeout(() => setButtonState(btn, 'Relist', ''), 4000);
    }
  } catch (e) {
    clearInterval(pollIv);
    console.error('[Relister v3] Message send failed:', e);
    setButtonState(btn, 'Error ✗', 'error');
    setTimeout(() => setButtonState(btn, 'Relist', ''), 4000);
  } finally {
    _relistInProgress = false;
  }
}

// ─── Button injection ─────────────────────────────────────────────────────────

function injectButton(card, listingId) {
  if (!listingId || !card) return;
  if (card.querySelector('.' + RELIST_CLASS)) return;

  const btn = document.createElement('button');
  btn.className = RELIST_CLASS;
  btn.textContent = 'Relist';
  btn.title = 'Re-post this listing as new (UI automation)';
  btn.setAttribute('aria-label', 'Relist this item on Marketplace');
  btn.style.cssText = [
    'position:absolute',
    'bottom:8px',
    'right:8px',
    'z-index:9999',
    'background:#1877f2',
    'color:#fff',
    'border:none',
    'border-radius:6px',
    'padding:7px 13px',
    'font-size:12px',
    'font-weight:700',
    'cursor:pointer',
    'box-shadow:0 2px 8px rgba(0,0,0,.45)',
    'line-height:1.5',
    'opacity:0.85',
    'transition:opacity .18s, background .15s'
  ].join(';');

  card.addEventListener('mouseenter', () => {
    if (btn.dataset.state !== 'busy' && btn.dataset.state !== 'done') {
      btn.style.opacity = '1';
    }
  });
  card.addEventListener('mouseleave', () => {
    if (!btn.dataset.state && btn.dataset.confirm !== '1') {
      btn.style.opacity = '0.85';
    }
  });

  btn.addEventListener('mouseenter', () => {
    if (!btn.dataset.state && btn.dataset.confirm !== '1') btn.style.background = '#166fe5';
  });
  btn.addEventListener('mouseleave', () => {
    if (!btn.dataset.state && btn.dataset.confirm !== '1') btn.style.background = '#1877f2';
  });

  // Two-click confirm: first click -> amber "Confirm?", second -> execute, auto-cancel after 3s
  let confirmTimer = null;

  btn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();

    if (btn.dataset.state === 'busy' || btn.dataset.state === 'done') return;

    if (btn.dataset.confirm === '1') {
      clearTimeout(confirmTimer);
      btn.dataset.confirm  = '';
      btn.style.background = '#1877f2';
      relistItem(listingId, btn);
      return;
    }

    btn.dataset.confirm  = '1';
    btn.textContent      = 'Confirm?';
    btn.style.background = '#d97706';
    btn.style.opacity    = '1';

    confirmTimer = setTimeout(() => {
      if (btn.dataset.confirm === '1') {
        btn.dataset.confirm  = '';
        btn.textContent      = 'Relist';
        btn.style.background = '#1877f2';
        btn.style.opacity    = '0.85';
      }
    }, 3000);
  });

  if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
  card.appendChild(btn);
}

// ─── Card scanning ────────────────────────────────────────────────────────────

/**
 * PRIMARY scan: look for all anchors with /marketplace/item/<id>/ in their href,
 * find the containing card element, and inject.
 */
function scanByDOMLinks() {
  const anchors = document.querySelectorAll('a[href*="/marketplace/item/"]');
  for (const anchor of anchors) {
    const m = anchor.href.match(/\/marketplace\/item\/(\d+)/);
    if (!m) continue;
    const listingId = m[1];

    // Card = closest element with role="button" or an img ancestor that's a reasonable card
    let card = anchor.closest('[aria-label][role="button"]')?.parentElement
      ?? anchor.closest('[data-visualcompletion]')
      ?? anchor.parentElement?.parentElement;
    if (!card) continue;

    // Prefer a parent that has a positioning context
    if (getComputedStyle(card).position === 'static') {
      const posParent = card.closest('[style*="position"]');
      if (posParent && posParent !== document.body) card = posParent;
    }

    injectButton(card, listingId);
  }
}

/**
 * FALLBACK scan: match img src filenames against the photo map (v2.3.6 approach).
 */
function scanByPhotoMap() {
  if (!_listingPhotoMap || _listingPhotoMap.size === 0) return;

  const remaining = new Map(_listingPhotoMap);

  for (const img of document.getElementsByTagName('img')) {
    if (remaining.size === 0) break;
    let matchId = null;
    for (const [filename, listingId] of remaining) {
      if (img.src.includes(filename)) {
        matchId = listingId;
        remaining.delete(filename);
        break;
      }
    }
    if (!matchId) continue;
    const card = img.closest('[aria-label][role="button"]')?.parentElement;
    if (card) injectButton(card, matchId);
  }
}

function scanListings() {
  scanByDOMLinks();
  scanByPhotoMap();
}

// ─── Init ─────────────────────────────────────────────────────────────────────

let _debounceTimer = null;
const _observer = new MutationObserver(() => {
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(scanListings, 250);
});
_observer.observe(document.body, { childList: true, subtree: true });

async function init() {
  console.log('[Relister v3] content.js loaded — UI Automation mode');

  // Run primary DOM scan immediately (works if links are already in the DOM)
  scanByDOMLinks();

  // Build photo map in background for the fallback path, then scan again
  try {
    await buildPhotoMap();
  } catch (e) {
    console.warn('[Relister v3] Photo map build failed (fallback unavailable):', e.message);
  }

  // Retry scan every 1s for 5s — React may not have rendered cards yet
  for (let i = 0; i < 5; i++) {
    scanListings();
    await new Promise(r => setTimeout(r, 1000));
  }
}

init();

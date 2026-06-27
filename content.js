'use strict';

// content.js v3.7.3 — three-tier photo-map: DOM JSON scan → BG bridge → legacy API
// Runs only on: /marketplace/you/selling*
// Injects Relist buttons + multi-select checkboxes per listing card.
// Floating action bar: Select All / Relist Selected (N) / Clear.
// Sends RELIST / RELIST_SELECTED / GET_LIVE_IDS messages to background.
// Reflects progress from chrome.storage.local.status onto buttons.

const RELIST_CLASS    = 'fbr-relist-btn';
const CHECKBOX_CLASS  = 'fbr-select-cb';
const ACTION_BAR_ID   = 'fbr-action-bar';

// ─── Selection state ──────────────────────────────────────────────────────────

const selected = new Set(); // listingId strings currently checked

// Free-tier gating: Set of listingIds at position ≥ 4 (locked for free users).
// null = not yet loaded / Pro user (no lock applied).
let _lockedIds = null;
let _isPro = null;                 // null = unknown until CHECK_PRO resolves
const FREE_LISTING_LIMIT = 4;      // free tier: only the first 4 listings are relistable

// ─── listingId detection ──────────────────────────────────────────────────────

/**
 * PRIMARY: walk up from a card element to find the nearest <a> with a
 * /marketplace/item/<id>/ href and extract the numeric id.
 */
function extractIdFromCardDOM(card) {
  const sel = 'a[href*="/marketplace/item/"], a[href*="/item/"]';
  const re  = /\/(?:marketplace\/)?item\/(\d+)/;
  const anchor = card.querySelector(sel);
  if (anchor) {
    const m = anchor.href.match(re);
    if (m) return m[1];
  }
  let el = card.parentElement;
  for (let i = 0; i < 5 && el; i++, el = el.parentElement) {
    const a = el.querySelector(sel);
    if (a) {
      const m = a.href.match(re);
      if (m) return m[1];
    }
  }
  return null;
}

// ─── Photo-map building ────────────────────────────────────────────────────────
// Three-tier approach: 1) inline DOM JSON scan, 2) background GraphQL bridge,
// 3) legacy stale API as last-ditch fallback.

let _listingPhotoMap = null; // Map<photoFilename, listingId>

function getPhotoFilename(uri) {
  if (!uri) return null;
  try { return new URL(uri).pathname.split('/').pop() || null; }
  catch { return uri.split('/').pop()?.split('?')[0] || null; }
}

// Tier 1: parse FB's server-rendered JSON blobs already in the DOM — no API calls.
function buildPhotoMapFromDOM() {
  const map = new Map();
  function walk(obj, seen, depth) {
    if (!obj || typeof obj !== 'object' || (depth || 0) > 45 || seen.has(obj)) return;
    seen.add(obj);
    const tn = obj.__typename;
    if ((tn === 'MarketplaceForSaleItem' || tn === 'GroupCommerceProductItem') &&
        obj.id && obj.marketplace_listing_title) {
      if (!(obj.is_sold || obj.is_pending || obj.is_draft)) {
        const uri = obj.primary_listing_photo?.image?.uri
                 ?? obj.listing_photos?.edges?.[0]?.node?.image?.uri;
        const fn  = getPhotoFilename(uri);
        if (fn && !map.has(fn)) map.set(fn, String(obj.id));
      }
    }
    const vals = Array.isArray(obj) ? obj : Object.values(obj);
    for (const v of vals) walk(v, seen, (depth || 0) + 1);
  }
  for (const s of document.querySelectorAll('script[type="application/json"]')) {
    let data;
    try { data = JSON.parse(s.textContent); } catch { continue; }
    walk(data, new Set(), 0);
  }
  return map;
}

// Tier 2: background bridge using proven CometMarketplaceYourListingsPaginationQuery.
async function buildPhotoMapFromBackground() {
  const res = await chrome.runtime.sendMessage({ kind: 'GET_PHOTO_MAP' });
  if (!res?.ok) {
    console.warn('[Relister v3] GET_PHOTO_MAP failed:', res?.error);
    return null;
  }
  const map = new Map(Object.entries(res.photoMap || {}));
  console.log('[Relister v3] GET_PHOTO_MAP returned', map.size, 'entries');
  return map;
}

async function buildPhotoMap() {
  if (_listingPhotoMap) return _listingPhotoMap;

  chrome.storage.local.set({ status: 'Loading your listings…', statusTime: Date.now() });

  // Tier 1: inline JSON — fast, no auth needed
  try {
    const domMap = buildPhotoMapFromDOM();
    if (domMap.size > 0) {
      console.log('[Relister v3] Photo map built from DOM JSON:', domMap.size, 'listings');
      _listingPhotoMap = domMap;
      chrome.storage.local.set({ status: 'Found ' + domMap.size + ' listings — scan in progress…', statusTime: Date.now() });
      return domMap;
    }
  } catch (e) {
    console.warn('[Relister v3] DOM JSON scan failed:', e.message);
  }

  // Tier 2: background GraphQL bridge (correct query + dynamic doc_id)
  try {
    const bgMap = await buildPhotoMapFromBackground();
    if (bgMap && bgMap.size > 0) {
      _listingPhotoMap = bgMap;
      chrome.storage.local.set({ status: 'Found ' + bgMap.size + ' listings — scan in progress…', statusTime: Date.now() });
      return bgMap;
    }
  } catch (e) {
    console.warn('[Relister v3] Background photo map failed:', e.message);
  }

  chrome.storage.local.set({ status: 'API returned 0 listings', statusTime: Date.now() });
  return null;
}

// ─── Button state helpers ─────────────────────────────────────────────────────

function setButtonState(btn, text, state) {
  btn.textContent = text;
  btn.dataset.state = state || '';
  btn.disabled = (state === 'busy' || state === 'done');
  btn.style.background =
    state === 'error' ? '#DC2626' :
    state === 'done'  ? '#16A34A' :
    '#1877F2';
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
      } else if (s.startsWith('Photos')) {
        setButtonState(btn, 'Photos…', 'busy');
      } else if (s.startsWith('Verifying')) {
        setButtonState(btn, 'Verifying…', 'busy');
      } else if (s.startsWith('Condition')) {
        setButtonState(btn, 'Condition…', 'busy');
      } else if (s.startsWith('Fetching listings')) {
        setButtonState(btn, 'Fetching…', 'busy');
      } else if (s.startsWith('Posting')) {
        setButtonState(btn, 'Posting…', 'busy');
      } else if (s.startsWith('Deleting')) {
        setButtonState(btn, 'Deleting…', 'busy');
      } else if (s.startsWith('Relisted') || s.startsWith('Done')) {
        clearInterval(iv);
        setButtonState(btn, 'Relisted ✓', 'done');
        if (!_reloadScheduled) { _reloadScheduled = true; setTimeout(() => location.reload(), 2500); }
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
let _reloadScheduled  = false;

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
      if (!_reloadScheduled) { _reloadScheduled = true; setTimeout(() => location.reload(), 2500); }
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

/**
 * Replace an already-injected (or newly created) button with a locked "Pro"
 * state for free-tier users whose listing is outside the top-4 window.
 */
// ─── Upgrade toast (free-tier prompt) ────────────────────────────────────────

// Show at most once per session. Subsequent locked-button clicks go straight to upgrade.
let _upgradePromptShown = false;

function showUpgradeToast() {
  if (_upgradePromptShown) return;
  _upgradePromptShown = true;

  const old = document.getElementById('fbr-upgrade-toast');
  if (old) old.remove();

  const toast = document.createElement('div');
  toast.id = 'fbr-upgrade-toast';
  toast.style.cssText = [
    'position:fixed',
    'bottom:80px',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:99999',
    'display:flex',
    'align-items:center',
    'gap:12px',
    'background:#1e293b',
    'color:#f1f5f9',
    'border:1.5px solid #3b82f6',
    'border-radius:10px',
    'padding:12px 16px',
    'box-shadow:0 6px 24px rgba(0,0,0,.35)',
    'font-family:system-ui,sans-serif',
    'font-size:13px',
    'max-width:460px',
    'white-space:normal',
    'line-height:1.4'
  ].join(';');

  const msg = document.createElement('span');
  msg.textContent = 'Free covers your 4 most-recent listings — go Pro for unlimited + AI + auto-relist';
  msg.style.flex = '1';

  const btnUpgrade = document.createElement('button');
  btnUpgrade.textContent = 'Upgrade';
  btnUpgrade.style.cssText = [
    'background:#3b82f6',
    'color:#fff',
    'border:none',
    'border-radius:6px',
    'padding:6px 14px',
    'font-size:13px',
    'font-weight:700',
    'cursor:pointer',
    'white-space:nowrap',
    'flex-shrink:0'
  ].join(';');
  btnUpgrade.addEventListener('click', () => {
    chrome.runtime.sendMessage({ kind: 'OPEN_PAYMENT_PAGE' });
    toast.remove();
  });

  const btnClose = document.createElement('button');
  btnClose.textContent = '✕';
  btnClose.style.cssText = [
    'background:none',
    'border:none',
    'color:#94a3b8',
    'cursor:pointer',
    'font-size:14px',
    'padding:0 2px',
    'flex-shrink:0'
  ].join(';');
  btnClose.addEventListener('click', () => toast.remove());

  toast.appendChild(msg);
  toast.appendChild(btnUpgrade);
  toast.appendChild(btnClose);
  document.body.appendChild(toast);

  // Auto-dismiss after 8s
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 8000);
}

function lockRelistButton(btn) {
  btn.textContent        = '🔒 Pro';
  btn.disabled           = false; // keep clickable so we can open the payment page
  btn.dataset.state      = 'locked';
  btn.style.background   = '#94A3B8';
  btn.style.cursor       = 'pointer';
  btn.style.opacity      = '1';
  // Replace all previous event listeners by cloning the node
  const locked = btn.cloneNode(true);
  locked.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    if (!_upgradePromptShown) {
      // First click this session: show the toast instead of jumping straight to checkout
      showUpgradeToast();
    } else {
      // Already shown: go directly to the upgrade page
      chrome.runtime.sendMessage({ kind: 'OPEN_PAYMENT_PAGE' });
    }
  });
  btn.replaceWith(locked);
}

function injectButton(card, listingId) {
  if (!listingId || !card) return;
  if (card.querySelector('.' + RELIST_CLASS)) return;

  const btn = document.createElement('button');
  btn.className = RELIST_CLASS;
  btn.dataset.listingId = listingId; // used by applyFreeGating()
  btn.textContent = 'Relist';
  btn.title = 'Re-post this listing as new (UI automation)';
  btn.setAttribute('aria-label', 'Relist this item on Marketplace');
  btn.style.cssText = [
    'position:absolute',
    'bottom:8px',
    'right:8px',
    'z-index:9999',
    'background:#1877F2',
    'color:#FFFFFF',
    'border:none',
    'border-radius:6px',
    'padding:7px 13px',
    'font-size:12px',
    'font-weight:700',
    'cursor:pointer',
    'box-shadow:0 2px 8px rgba(0,0,0,.28),0 0 0 1px rgba(255,255,255,.15)',
    'line-height:1.5',
    'opacity:0.9',
    'transition:opacity .18s, background .15s'
  ].join(';');

  card.addEventListener('mouseenter', () => {
    if (btn.dataset.state !== 'busy' && btn.dataset.state !== 'done') {
      btn.style.opacity = '1';
    }
  });
  card.addEventListener('mouseleave', () => {
    if (!btn.dataset.state && btn.dataset.confirm !== '1') {
      btn.style.opacity = '0.9';
    }
  });

  btn.addEventListener('mouseenter', () => {
    if (!btn.dataset.state && btn.dataset.confirm !== '1') btn.style.background = '#1668D6';
  });
  btn.addEventListener('mouseleave', () => {
    if (!btn.dataset.state && btn.dataset.confirm !== '1') btn.style.background = '#1877F2';
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
      btn.style.background = '#1877F2';
      relistItem(listingId, btn);
      return;
    }

    btn.dataset.confirm  = '1';
    btn.textContent      = 'Confirm?';
    btn.style.background = '#D97706';
    btn.style.opacity    = '1';

    confirmTimer = setTimeout(() => {
      if (btn.dataset.confirm === '1') {
        btn.dataset.confirm  = '';
        btn.textContent      = 'Relist';
        btn.style.background = '#1877F2';
        btn.style.opacity    = '0.9';
      }
    }, 3000);
  });

  if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
  card.appendChild(btn);
  // Gate at injection time so EVERY (re)rendered card gets the right treatment despite
  // FB's list virtualization (cards below the fold mount/unmount as you scroll).
  if (_isPro === false && _lockedIds && _lockedIds.has(listingId)) lockRelistButton(btn);
}

// ─── Checkbox injection ───────────────────────────────────────────────────────

function injectCheckbox(card, listingId) {
  if (!listingId || !card) return;
  if (card.querySelector('.' + CHECKBOX_CLASS)) return; // guard against double-inject

  const wrapper = document.createElement('label');
  wrapper.className = CHECKBOX_CLASS;
  wrapper.title = 'Select for batch relist';
  wrapper.style.cssText = [
    'position:absolute',
    'top:8px',
    'left:8px',
    'z-index:9999',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'width:22px',
    'height:22px',
    'background:rgba(255,255,255,0.92)',
    'border-radius:4px',
    'box-shadow:0 1px 4px rgba(0,0,0,.35)',
    'cursor:pointer',
    'opacity:0.85',
    'transition:opacity .18s'
  ].join(';');

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.style.cssText = 'width:16px;height:16px;cursor:pointer;margin:0;accent-color:#1877f2';
  cb.checked = selected.has(listingId);
  cb.dataset.listingId = listingId;

  cb.addEventListener('change', e => {
    e.stopPropagation();
    if (cb.checked) {
      selected.add(listingId);
    } else {
      selected.delete(listingId);
    }
    updateBar();
  });

  // Don't propagate clicks to FB's card (which would navigate away)
  wrapper.addEventListener('click', e => e.stopPropagation());

  wrapper.appendChild(cb);
  if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
  card.appendChild(wrapper);

  wrapper.addEventListener('mouseenter', () => { wrapper.style.opacity = '1'; });
  wrapper.addEventListener('mouseleave', () => { wrapper.style.opacity = '0.85'; });
}

// ─── Floating action bar ──────────────────────────────────────────────────────

let _barRelistInProgress = false;
let _barPollIv = null;

function getOrCreateBar() {
  let bar = document.getElementById(ACTION_BAR_ID);
  if (bar) return bar;

  bar = document.createElement('div');
  bar.id = ACTION_BAR_ID;
  bar.style.cssText = [
    'position:fixed',
    'bottom:24px',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:99999',
    'display:none',       // hidden until selections exist
    'align-items:center',
    'gap:10px',
    'background:#fff',
    'border:1.5px solid #1877f2',
    'border-radius:10px',
    'padding:10px 18px',
    'box-shadow:0 4px 18px rgba(0,0,0,.22)',
    'font-family:system-ui,sans-serif',
    'font-size:13px',
    'white-space:nowrap'
  ].join(';');

  // ── Select all button ──
  const btnSelectAll = document.createElement('button');
  btnSelectAll.id = 'fbr-select-all';
  btnSelectAll.textContent = 'Select all';
  btnSelectAll.style.cssText = [
    'background:#EFF6FF',
    'color:#1877F2',
    'border:1px solid #BFDBFE',
    'border-radius:6px',
    'padding:6px 12px',
    'font-size:13px',
    'font-weight:600',
    'cursor:pointer'
  ].join(';');

  btnSelectAll.addEventListener('click', async () => {
    btnSelectAll.disabled = true;
    btnSelectAll.textContent = 'Loading…';
    try {
      const res = await chrome.runtime.sendMessage({ kind: 'GET_LIVE_IDS' });
      if (res && res.ok && Array.isArray(res.ids)) {
        for (const id of res.ids) selected.add(id);
        // Re-sync all visible checkboxes
        syncAllCheckboxes();
        updateBar();
      } else {
        console.warn('[Relister v3] GET_LIVE_IDS failed:', res && res.error);
      }
    } catch (e) {
      console.warn('[Relister v3] GET_LIVE_IDS error:', e.message);
    } finally {
      btnSelectAll.disabled = false;
      btnSelectAll.textContent = 'Select all';
    }
  });

  // ── Relist selected button ──
  const btnRelist = document.createElement('button');
  btnRelist.id = 'fbr-relist-selected';
  btnRelist.textContent = 'Relist selected (0)';
  btnRelist.disabled = true;
  btnRelist.style.cssText = [
    'background:#1877F2',
    'color:#FFFFFF',
    'border:none',
    'border-radius:6px',
    'padding:6px 14px',
    'font-size:13px',
    'font-weight:700',
    'cursor:pointer',
    'opacity:0.5',
    'transition:opacity .15s, background .15s'
  ].join(';');

  btnRelist.addEventListener('click', async () => {
    if (_barRelistInProgress || !selected.size) return;
    _barRelistInProgress = true;
    btnRelist.disabled = true;
    btnRelist.style.opacity = '0.75';
    btnRelist.textContent = 'Starting…';

    const ids = [...selected];

    // Poll status storage onto the bar button
    _barPollIv = setInterval(() => {
      chrome.storage.local.get(['status'], data => {
        const s = data.status || '';
        if (s.startsWith('Reading'))        { btnRelist.textContent = 'Reading…'; }
        else if (s.startsWith('Photos'))    { btnRelist.textContent = 'Photos…'; }
        else if (s.startsWith('Verifying')) { btnRelist.textContent = 'Verifying…'; }
        else if (s.startsWith('Condition')) { btnRelist.textContent = 'Condition…'; }
        else if (s.startsWith('Fetching'))  { btnRelist.textContent = 'Fetching…'; }
        else if (s.startsWith('Posting'))   { btnRelist.textContent = 'Posting…'; }
        else if (s.startsWith('Deleting'))  { btnRelist.textContent = 'Deleting…'; }
        else if (s.startsWith('Relisting')) { btnRelist.textContent = s; }
        else if (s.startsWith('Done') || s.startsWith('Relisted')) {
          clearInterval(_barPollIv); _barPollIv = null;
          btnRelist.style.background = '#16A34A';
          btnRelist.textContent = 'Done ✓';
          btnRelist.style.opacity = '1';
          _barRelistInProgress = false;
          selected.clear();
          syncAllCheckboxes();
          updateBar();
          if (!_reloadScheduled) { _reloadScheduled = true; setTimeout(() => location.reload(), 2500); }
        } else if (s.startsWith('Error') || s.startsWith('error')) {
          clearInterval(_barPollIv); _barPollIv = null;
          btnRelist.style.background = '#DC2626';
          btnRelist.textContent = 'Error ✗';
          btnRelist.style.opacity = '1';
          _barRelistInProgress = false;
          setTimeout(() => {
            btnRelist.style.background = '#1877F2';
            updateBar();
          }, 4000);
        }
      });
    }, 600);

    try {
      await chrome.runtime.sendMessage({ kind: 'RELIST_SELECTED', ids });
    } catch (e) {
      clearInterval(_barPollIv); _barPollIv = null;
      console.error('[Relister v3] RELIST_SELECTED send failed:', e);
      btnRelist.style.background = '#DC2626';
      btnRelist.textContent = 'Error ✗';
      btnRelist.style.opacity = '1';
      _barRelistInProgress = false;
      setTimeout(() => {
        btnRelist.style.background = '#1877F2';
        updateBar();
      }, 4000);
    }
  });

  // ── Clear button ──
  const btnClear = document.createElement('button');
  btnClear.id = 'fbr-clear-selection';
  btnClear.textContent = 'Clear';
  btnClear.style.cssText = [
    'background:#F1F5F9',
    'color:#475569',
    'border:1px solid #E2E8F0',
    'border-radius:6px',
    'padding:6px 12px',
    'font-size:13px',
    'font-weight:600',
    'cursor:pointer'
  ].join(';');

  btnClear.addEventListener('click', () => {
    selected.clear();
    syncAllCheckboxes();
    updateBar();
  });

  bar.appendChild(btnSelectAll);
  bar.appendChild(btnRelist);
  bar.appendChild(btnClear);
  document.body.appendChild(bar);
  return bar;
}

/**
 * Refresh the action bar count + disabled state.
 * Creates the bar if it doesn't exist yet.
 */
function updateBar() {
  const bar = getOrCreateBar();
  const n = selected.size;

  bar.style.display = n > 0 ? 'flex' : 'none';

  const btnRelist = document.getElementById('fbr-relist-selected');
  if (btnRelist && !_barRelistInProgress) {
    btnRelist.textContent = `Relist selected (${n})`;
    btnRelist.disabled = (n === 0);
    btnRelist.style.opacity = n > 0 ? '1' : '0.5';
    btnRelist.style.background = '#1877F2';
  }
}

/**
 * Re-sync every rendered checkbox to the current `selected` Set.
 * Called after select-all, clear, or virtualized re-render.
 */
function syncAllCheckboxes() {
  for (const cb of document.querySelectorAll('.' + CHECKBOX_CLASS + ' input[type="checkbox"]')) {
    cb.checked = selected.has(cb.dataset.listingId || '');
  }
}

// ─── Free-tier gating ────────────────────────────────────────────────────────

/**
 * After all cards are rendered, ask background for the ordered live-listing
 * IDs and lock any button whose listing sits at index ≥ 4 (free tier only).
 * Pro users: no-op (returns early after CHECK_PRO confirms isPro).
 */
async function applyFreeGating() {
  try {
    const proRes = await chrome.runtime.sendMessage({ kind: 'CHECK_PRO' });
    _isPro = !!(proRes && proRes.isPro);
    if (_isPro) { _lockedIds = new Set(); return; } // Pro — nothing locked

    const liveRes = await chrome.runtime.sendMessage({ kind: 'GET_LIVE_IDS' });
    if (!liveRes || !liveRes.ok || !Array.isArray(liveRes.ids)) return;

    _lockedIds = new Set(liveRes.ids.slice(FREE_LISTING_LIMIT)); // positions 4+ locked
    // Re-gate any already-injected buttons (catch-up for cards injected before state was known)
    for (const btn of document.querySelectorAll('.' + RELIST_CLASS)) {
      const lid = btn.dataset.listingId;
      if (lid && _lockedIds.has(lid) && btn.dataset.state !== 'locked') lockRelistButton(btn);
    }
    console.log('[Relister v3] Free gating —', _lockedIds.size, 'listing(s) locked');
  } catch (e) {
    console.warn('[Relister v3] applyFreeGating failed (no lock applied):', e.message);
  }
}

// ─── Card scanning ────────────────────────────────────────────────────────────

/**
 * PRIMARY scan: look for all anchors with /marketplace/item/<id>/ in their href,
 * find the containing card element, and inject.
 */
function scanByDOMLinks() {
  // FB may omit '/marketplace' prefix in the seller view hrefs
  const anchors = document.querySelectorAll('a[href*="/marketplace/item/"], a[href*="/item/"]');
  for (const anchor of anchors) {
    const m = anchor.href.match(/\/(?:marketplace\/)?item\/(\d+)/);
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
    injectCheckbox(card, listingId);

    // Re-sync checkbox checked state to survive FB's virtualized re-render
    const cb = card.querySelector('.' + CHECKBOX_CLASS + ' input[type="checkbox"]');
    if (cb) cb.checked = selected.has(listingId);
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
    if (card) {
      injectButton(card, matchId);
      injectCheckbox(card, matchId);
      const cb = card.querySelector('.' + CHECKBOX_CLASS + ' input[type="checkbox"]');
      if (cb) cb.checked = selected.has(matchId);
    }
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

// Force-render FB's lazy-loaded listing list by scrolling top→bottom, injecting
// buttons/checkboxes on each batch as it renders (FB only mounts a handful of cards
// at a time). This is what made buttons appear "all the way down" in earlier versions.
async function loadAllCards() {
  let lastH = 0, stable = 0;
  for (let i = 0; i < 40 && stable < 3; i++) {
    scanListings();
    window.scrollBy(0, Math.round(window.innerHeight * 0.85));
    await new Promise(r => setTimeout(r, 450));
    const h = document.body.scrollHeight;
    if (h === lastH) stable++; else { stable = 0; lastH = h; }
  }
  window.scrollTo(0, 0);
  await new Promise(r => setTimeout(r, 400));
  scanListings();
  console.log('[Relister v3] loadAllCards done —', document.querySelectorAll('.' + RELIST_CLASS).length, 'buttons');
}

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

  // Re-scan as the user scrolls — FB virtualizes the list (only ~5 cards are rendered
  // at a time), so buttons attach to newly-rendered cards on scroll. Capture:true so
  // we also catch FB's nested scroll containers (scroll events don't bubble).
  let _scrollTimer = null;
  window.addEventListener('scroll', () => {
    clearTimeout(_scrollTimer);
    _scrollTimer = setTimeout(scanListings, 200);
  }, { passive: true, capture: true });

  // A couple of quick scans for the initially-visible cards, then auto-scroll the
  // whole list so EVERY listing renders and gets a button/checkbox (the behaviour
  // that showed buttons "all the way down" before).
  scanListings();
  await applyFreeGating();   // set _isPro/_lockedIds EARLY so injectButton gates each card on (re)mount
  await new Promise(r => setTimeout(r, 800));
  scanListings();
  await loadAllCards();
  await applyFreeGating();   // catch-up for cards injected before gating state was known

  // Clear the "scan in progress…" status so the popup doesn't spin forever. Only if a
  // relist isn't currently mid-flight (don't clobber live progress).
  const cur = (await chrome.storage.local.get('status')).status || '';
  if (!/^(Reading|Photos|Posting|Verifying|Condition|Deleting|Relisting|Fetching)/.test(cur)) {
    const n = document.querySelectorAll('.' + RELIST_CLASS).length;
    chrome.storage.local.set({ status: `Done: ${n} relist button${n === 1 ? '' : 's'} ready`, statusTime: Date.now() });
  }
}

init();

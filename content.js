// content.js — Core automation for FB Marketplace Relister
// State machine: state persisted in chrome.storage.local survives page navigations.
// States: 'scraping' (selling page) → 'deleting' (selling page) → 'creating' (create page)
// Depends on: utils.js, drop_img.js
// NOTE: fetch/XHR interception is done by hook.js running in MAIN world (not isolated world).
//       hook.js relays intercepted GraphQL responses via window.postMessage({ __fbRelister: 'graphql', text }).

const SELLING_URL = 'https://www.facebook.com/marketplace/you/selling?state=LIVE&status[0]=IN_STOCK';

// ─── Inbound message handler ──────────────────────────────────────────────────
// hook.js (MAIN world) posts { __fbRelister: 'graphql', text } for every /api/graphql
// response that contains marketplace/listing data. We parse and store it.
window.addEventListener('message', event => {
  if (!event.data || event.data.__fbRelister !== 'graphql') return;
  try { parseAndStoreListings(event.data.text); } catch (e) { console.warn('[Relister] parse error:', e); }
});

// Debug: respond to scan-only requests from the popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'scanOnly') {
    const listings = scrapeListingsFromDOM();
    // Diagnostic: count action buttons that indicate listing cards
    const LISTING_ACTIONS = ['Boost listing', 'Mark as sold', 'Mark as available', 'Relist'];
    const clickables = Array.from(document.querySelectorAll('[role="button"], button, a'));
    const actionBtns = clickables.filter(el => {
      const text = (el.textContent || '').trim();
      const label = el.getAttribute('aria-label') || '';
      return LISTING_ACTIONS.some(t => text === t || label.includes(t));
    });
    const allLinks = Array.from(document.querySelectorAll('a[href]'));
    const numericLinks = allLinks.filter(l => /\/marketplace\/item\/\d+/.test(l.pathname || l.href));
    const msgLinks = allLinks.filter(l => (l.pathname || '').startsWith('/messages/'));
    const sampleBtns = actionBtns.slice(0, 5).map(el => (el.textContent || '').trim());
    sendResponse({
      count: listings.length,
      listings: listings.map(l => ({ id: l.id, title: l.title, price: l.price })),
      titles: listings.map(l => l.title),
      actionButtons: actionBtns.length,
      sampleActionButtons: sampleBtns,
      totalLinks: allLinks.length,
      numericLinks: numericLinks.length,
      messengerLinks: msgLinks.length,
      sampleHrefs: numericLinks.slice(0, 5).map(l => l.href),
    });
    return true;
  }
});

;(async function main() {
  'use strict';

  // Wait for DOM before touching any elements
  if (document.readyState === 'loading') {
    await new Promise(r => document.addEventListener('DOMContentLoaded', r));
  }

  const stored = await chrome.storage.local.get(['relistPending', 'relistState']);
  if (!stored.relistPending) return;

  const url = window.location.href;
  const state = stored.relistState || 'scraping';

  if (state === 'scraping' && url.includes('/you/selling')) {
    await runScraping();
  } else if (state === 'deleting' && url.includes('/you/selling')) {
    await runDeleting();
  } else if (state === 'creating' && url.includes('/create/item')) {
    await runCreating();
  } else {
    // State/URL mismatch — navigate to selling page to recover
    setStatus('Recovering...');
    await sleep(1000);
    window.location.href = SELLING_URL;
  }
})();

// ─── State Handlers ───────────────────────────────────────────────────────────

async function runScraping() {
  await chrome.storage.local.set({ listings: [] });
  setStatus('Scanning your listings...');

  // Scroll to trigger FB's lazy-loaded cards — this causes FB's React app to fire
  // its own GraphQL requests, which hook.js intercepts and stores via parseAndStoreListings.
  for (let i = 0; i < 3; i++) {
    window.scrollBy(0, window.innerHeight);
    await sleep(800);
  }
  await sleep(500);
  window.scrollTo(0, 0);

  let listings = null;

  // 1. Wait for hook.js to relay FB's own GraphQL selling-feed response.
  //    hook.js intercepts FB's real GraphQL calls which have auth baked in.
  setStatus('Waiting for listing data...');
  listings = await waitForListings(10000);

  // 2. DOM scraping fallback — if GraphQL intercept missed or returned nothing.
  if (!listings || listings.length === 0) {
    setStatus('Trying DOM scan...');
    await sleep(1000);
    listings = scrapeListingsFromDOM();
    if (listings && listings.length > 0) {
      await chrome.storage.local.set({ listings });
    }
  }

  if (!listings || listings.length === 0) {
    setStatus('No listings found. Make sure you are on Marketplace → Your Listings.');
    await chrome.storage.local.set({ relistPending: false, relistState: null });
    return;
  }

  // Filter to selected listings if user chose "Relist Selected"
  const { selectedIds } = await chrome.storage.local.get(['selectedIds']);
  if (selectedIds && selectedIds.length > 0) {
    const idSet = new Set(selectedIds.map(String));
    listings = listings.filter(l => idSet.has(String(l.id)));
    console.log(`[Relister] Filtered to ${listings.length} selected listing(s)`);
  }

  if (!listings || listings.length === 0) {
    setStatus('None of the selected listings were found on this page.');
    await chrome.storage.local.set({ relistPending: false, relistState: null });
    return;
  }

  setStatus(`Relisting ${listings.length} listing(s)...`);
  setProgress(0, listings.length);
  await chrome.storage.local.set({ listings, currentIndex: 0, relistState: 'deleting' });
  await runDeleting();
}

function scrapeListingsFromDOM() {
  const seen = new Set();
  const listings = [];

  // Strategy A: Find listing cards via their unique action buttons.
  // "Boost listing", "Mark as sold", "Mark as available" ONLY appear on listing cards —
  // never in Messenger threads, profile pages, or navigation. This prevents us from
  // accidentally targeting chat contacts or friend names like previous versions did.
  const LISTING_ACTIONS = ['Boost listing', 'Mark as sold', 'Mark as available', 'Relist'];
  const cardRoots = new Set();

  const clickables = Array.from(document.querySelectorAll('[role="button"], button, a'));
  for (const el of clickables) {
    const text = (el.textContent || '').trim();
    const label = el.getAttribute('aria-label') || '';
    if (!LISTING_ACTIONS.some(t => text === t || label.includes(t))) continue;

    // Walk up to find a semantic listing card container
    let node = el.parentElement;
    let found = false;
    for (let depth = 0; depth < 12 && node; depth++) {
      const role = node.getAttribute('role');
      if (role === 'listitem' || role === 'article') {
        cardRoots.add(node);
        found = true;
        break;
      }
      if (depth > 0 && node.hasAttribute('data-testid')) {
        cardRoots.add(node);
        found = true;
        break;
      }
      if (role === 'feed' || role === 'list' || role === 'main' || role === 'navigation') break;
      node = node.parentElement;
    }
    // Fallback: 8 levels up if no semantic container found
    if (!found) {
      let n = el;
      for (let i = 0; i < 8 && n.parentElement; i++) n = n.parentElement;
      cardRoots.add(n);
    }
  }

  console.log(`[Relister] DOM strategy A — listing card candidates via buttons: ${cardRoots.size}`);

  const SKIP_WORDS = new Set([
    'Active', 'Sold', 'Available', 'Pending', 'In stock',
    'Boost listing', 'Mark as sold', 'Mark as available', 'Relist',
    'Share', 'Edit', 'Delete', 'More', 'See more',
  ]);

  for (const card of cardRoots) {
    const allText = [];
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      const t = (n.textContent || '').trim();
      if (t && t.length > 1) allText.push(t);
    }

    const price = allText.find(t => /^A?\$[\d,]+$|^\$[\d,]+$/.test(t)) || '';
    const skip = new Set([...SKIP_WORDS, price]);

    const title = allText
      .filter(t => t.length > 3 && !skip.has(t) && !/^[\d,\.\$]+$/.test(t))
      .sort((a, b) => b.length - a.length)[0] || '';

    if (!title || seen.has(title)) continue;
    seen.add(title);

    // Try to extract a numeric listing ID from links inside the card.
    // Exclude /messages/ and /groups/ paths (those are NOT listing IDs).
    let id = '';
    for (const link of card.querySelectorAll('a[href]')) {
      const path = link.pathname || '';
      if (path.startsWith('/messages/') || path.startsWith('/groups/')) continue;
      const m = path.match(/\/(\d{13,})/);
      if (m) { id = m[1]; break; }
    }
    if (!id) id = title; // use title as dedup key if no numeric ID found

    const photoUrls = Array.from(card.querySelectorAll('img[src]'))
      .map(img => img.src)
      .filter(src => src && src.startsWith('http') && !src.includes('static.xx'));

    listings.push({ id, title, price, description: '', photoUrls, categoryName: '', condition: '' });
  }

  // Strategy B: link-based scan — same approach as before but with Messenger excluded.
  // Used as a fallback if no action buttons are found (e.g. on a cached/partial page load).
  if (listings.length === 0) {
    console.log('[Relister] Strategy A found nothing — trying marketplace item link scan...');
    const candidateLinks = new Set();
    document.querySelectorAll('a[href]').forEach(l => {
      const path = l.pathname || '';
      // Only match /marketplace/item/<id> — the canonical URL for any listing
      if (/\/marketplace\/item\/\d+/.test(path)) {
        candidateLinks.add(l);
      }
    });

    console.log(`[Relister] Strategy B — marketplace item links: ${candidateLinks.size}`);

    for (const link of candidateLinks) {
      const path = link.pathname || link.href;
      const match = path.match(/\/marketplace\/item\/(\d+)/);
      if (!match) continue;
      const id = match[1];
      if (seen.has(id)) continue;

      const allText = [];
      const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT, null);
      let n;
      while ((n = walker.nextNode())) {
        const t = (n.textContent || '').trim();
        if (t) allText.push(t);
      }

      const price = allText.find(t => /^A?\$[\d,]+$|^\$[\d,]+$/.test(t)) || '';
      const skip = new Set([...SKIP_WORDS, price]);
      const title = allText
        .filter(t => t.length > 2 && !skip.has(t))
        .sort((a, b) => b.length - a.length)[0] || '';

      if (!title) continue;
      if (seen.has(title)) continue;
      seen.add(id);
      seen.add(title);

      const img = link.querySelector('img');
      const photoUrls = img && img.src ? [img.src] : [];

      listings.push({ id, title, price, description: '', photoUrls, categoryName: '', condition: '' });
    }
  }

  // Strategy C: Parse embedded <script> JSON blocks (unchanged).
  if (listings.length === 0) {
    document.querySelectorAll('script[type="application/json"], script:not([src])').forEach(s => {
      const t = s.textContent;
      if (t && (t.includes('"marketplace"') || t.includes('"listing"')) && t.length > 500) {
        try { parseAndStoreListings(t); } catch { /* skip */ }
      }
    });
    console.log('[Relister] Strategy C — script-tag extraction attempted');
  }

  console.log(`[Relister] DOM scan found ${listings.length} listings`);
  return listings;
}

async function runDeleting() {
  const data = await chrome.storage.local.get(['listings', 'currentIndex']);
  const listings = data.listings || [];
  const i = data.currentIndex || 0;

  if (i >= listings.length) {
    await chrome.storage.local.set({ relistPending: false, relistState: null });
    setStatus(`Done! Relisted ${listings.length} listing(s).`);
    return;
  }

  const listing = listings[i];
  setStatus(`Processing ${i + 1}/${listings.length}: "${listing.title}"`);

  const deleted = await deleteListing(listing);
  if (!deleted) {
    console.warn(`[Relister] Could not delete: ${listing.title} — skipping`);
    setProgress(i + 1, listings.length);
    await chrome.storage.local.set({ currentIndex: i + 1, relistState: 'deleting' });
    window.location.href = SELLING_URL;
    return;
  }

  setProgress(i + 1, listings.length);
  await chrome.storage.local.set({ currentIndex: i, relistState: 'creating' });
  await sleep(2000);
  window.location.href = 'https://www.facebook.com/marketplace/create/item';
}

async function runCreating() {
  const data = await chrome.storage.local.get(['listings', 'currentIndex']);
  const listings = data.listings || [];
  const i = data.currentIndex || 0;

  if (i >= listings.length) {
    await chrome.storage.local.set({ relistPending: false, relistState: null });
    setStatus('Done!');
    return;
  }

  const listing = listings[i];

  // Wait for the Title input — specific enough to confirm the form is ready
  const titleInput = await waitForElement('input[aria-label="Title"]', 12000);
  if (!titleInput) {
    console.error('[Relister] Create page did not load in time');
    setProgress(i + 1, listings.length);
    await chrome.storage.local.set({ currentIndex: i + 1, relistState: 'deleting' });
    window.location.href = SELLING_URL;
    return;
  }

  await sleep(MEDIUM());

  const filled = await fillCreateForm(listing);
  if (!filled) {
    console.error(`[Relister] Form fill failed for: ${listing.title}`);
    setProgress(i + 1, listings.length);
    await chrome.storage.local.set({ currentIndex: i + 1, relistState: 'deleting' });
    window.location.href = SELLING_URL;
    return;
  }

  const published = await publishListing();
  if (published) {
    console.log(`[Relister] Published: ${listing.title}`);
  } else {
    console.error(`[Relister] Publish failed for: ${listing.title}`);
  }

  const next = i + 1;
  setProgress(next, listings.length);

  if (next >= listings.length) {
    await chrome.storage.local.set({ relistPending: false, relistState: null });
    setStatus(`Done! Relisted ${listings.length} listing(s).`);
    await sleep(2000);
    window.location.href = SELLING_URL;
    return;
  }

  const delayMs = 3000 + Math.random() * 5000;
  setStatus(`Waiting ${Math.round(delayMs / 1000)}s before next listing...`);
  await sleep(delayMs);

  await chrome.storage.local.set({ currentIndex: next, relistState: 'deleting' });
  window.location.href = 'https://www.facebook.com/marketplace/you/selling';
}

// ─── GraphQL Parsing ──────────────────────────────────────────────────────────
// Data arrives here via window.postMessage from hook.js (main world) or from
// script-tag extraction in scrapeListingsFromDOM().

function parseAndStoreListings(text) {
  // Facebook uses NDJSON (newline-delimited) or single-object JSON
  const candidates = [];
  // Try each line as JSON
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{')) {
      try { candidates.push(JSON.parse(trimmed)); } catch { /* skip */ }
    }
  }
  // Also try the whole response as JSON
  try { candidates.push(JSON.parse(text)); } catch { /* skip */ }

  for (const json of candidates) {
    const edges = deepGet(json, ['data', 'viewer', 'selling_feed_one_page', 'edges'])
               || deepGet(json, ['data', 'marketplace_selling_feed', 'edges'])
               || deepGet(json, ['data', 'selling_feed_one_page', 'edges']);

    if (!Array.isArray(edges) || edges.length === 0) {
      // Log top-level keys to help diagnose the JSON structure when edges aren't found
      if (json && json.data) {
        console.log('[Relister] GraphQL data keys:', Object.keys(json.data).slice(0, 10).join(', '));
      }
      continue;
    }

    const listings = edges.map(edge => {
      const node = edge.node || {};

      let price = '';
      if (node.marketplace_listing_price_with_currency) {
        price = node.marketplace_listing_price_with_currency.amount || '';
      } else if (node.listing_price) {
        price = node.listing_price.amount || '';
      }

      const photoUrls = [];
      if (Array.isArray(node.photos)) {
        node.photos.forEach(p => {
          if (p && p.uri) photoUrls.push(p.uri);
          else if (p && p.image && p.image.uri) photoUrls.push(p.image.uri);
        });
      } else if (Array.isArray(node.listing_photos)) {
        node.listing_photos.forEach(p => {
          if (p && p.image && p.image.uri) photoUrls.push(p.image.uri);
        });
      }

      let description = '';
      if (node.redacted_description && node.redacted_description.text) {
        description = node.redacted_description.text;
      } else if (node.description) {
        description = node.description;
      }

      let condition = '';
      if (Array.isArray(node.listing_attributes)) {
        const condAttr = node.listing_attributes.find(
          a => a && a.attribute_name && a.attribute_name.toLowerCase() === 'condition'
        );
        if (condAttr) condition = condAttr.attribute_value || '';
      }

      return {
        id:           node.id || '',
        title:        node.group_commerce_item_title || node.name || '',
        price,
        description,
        photoUrls,
        categoryName: node.category_name || '',
        condition,
      };
    }).filter(l => l.id && l.title);

    if (listings.length > 0) {
      chrome.storage.local.get(['listings'], data => {
        const existing = data.listings || [];
        const merged = [...existing];
        for (const l of listings) {
          if (!merged.find(e => e.id === l.id)) merged.push(l);
        }
        chrome.storage.local.set({ listings: merged });
        console.log(`[Relister] Stored ${merged.length} listings total (${listings.length} new)`);
      });
    }
  }
}

function deepGet(obj, keys) {
  return keys.reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
}

// ─── Active GraphQL API helpers ───────────────────────────────────────────────
// These run in the isolated content-script world but relay requests through hook.js
// in MAIN world (which has page cookies + page context).

function waitForListings(timeoutMs) {
  return new Promise(resolve => {
    const start = Date.now();

    function check() {
      chrome.storage.local.get(['listings'], data => {
        if (Array.isArray(data.listings) && data.listings.length > 0) {
          resolve(data.listings);
        } else if (Date.now() - start > timeoutMs) {
          resolve(null);
        } else {
          setTimeout(check, 300);
        }
      });
    }

    setTimeout(check, 1500);
  });
}

// ─── Delete Flow ──────────────────────────────────────────────────────────────

async function deleteListing(listing) {
  setStatus(`Deleting: "${listing.title}"`);

  const card = findListingCard(listing.title);
  if (!card) {
    console.warn(`[Relister] Card not found for: ${listing.title}`);
    return false;
  }

  let moreBtn = card.querySelector('[aria-label="More options"]')
             || card.querySelector('[aria-label="Actions for this listing"]');

  if (!moreBtn) {
    const buttons = Array.from(card.querySelectorAll('[role="button"]'));
    moreBtn = buttons.find(b => b.textContent.trim() === '' || b.textContent.trim() === '...')
           || buttons[buttons.length - 1];
  }

  if (!moreBtn) {
    console.warn('[Relister] More options button not found on card');
    return false;
  }

  await scrollAndClick(moreBtn);
  await sleep(MEDIUM());

  // Try multiple selector patterns — Facebook varies tabindex and role usage
  const deleteBtn = await waitForElement(
    'div[aria-label="Delete"][tabindex="0"], div[aria-label="Delete"][role="menuitem"], li[role="menuitem"] div[aria-label="Delete"]',
    5000
  );
  if (!deleteBtn) {
    console.warn('[Relister] Delete button not found in dropdown');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return false;
  }

  await scrollAndClick(deleteBtn);
  await sleep(MEDIUM());

  // Confirm dialog — try multiple label variants used across regions
  const confirmBtn = await waitForElement(
    'div[role="dialog"] div[aria-label="Delete"], div[role="dialog"] div[aria-label="Remove"], div[role="alertdialog"] div[aria-label="Delete"], div[role="alertdialog"] div[aria-label="Remove listing"]',
    5000
  );
  if (!confirmBtn) {
    console.warn('[Relister] Delete confirmation button not found');
    return false;
  }

  await scrollAndClick(confirmBtn);

  await sleep(1000);
  const gone = await waitForCardGone(listing.title, 8000);
  return gone;
}

function findListingCard(title) {
  const headings = Array.from(document.querySelectorAll('h2, h3, span[dir="auto"]'));
  const matchHeading = headings.find(h => h.textContent.trim() === title.trim());
  if (!matchHeading) return null;

  // Walk up looking for a semantic container
  let node = matchHeading;
  for (let i = 0; i < 8; i++) {
    node = node.parentElement;
    if (!node) break;
    if (node.getAttribute('role') === 'listitem' || node.getAttribute('role') === 'article') {
      return node;
    }
    if (node.hasAttribute('data-testid')) return node;
  }

  // Fallback: 5 levels up — stay close to the heading to avoid overly broad containers
  node = matchHeading;
  for (let i = 0; i < 5; i++) {
    if (!node.parentElement) break;
    // Stop early if we hit a known broad container
    const role = node.parentElement.getAttribute('role');
    if (role === 'feed' || role === 'list' || role === 'main') break;
    node = node.parentElement;
  }
  return node;
}

async function waitForCardGone(title, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const card = findListingCard(title);
    if (!card) return true;
    await sleep(300);
  }
  return false;
}

// ─── Create / Fill Flow ───────────────────────────────────────────────────────

async function fillCreateForm(listing) {
  setStatus('Filling: Title');
  const titleInput = spanTextFinder('Title', 'input');
  if (!titleInput) {
    console.error('[Relister] Title input not found');
    return false;
  }
  titleInput.focus();
  nativeSetInput(titleInput, listing.title);
  await sleep(SHORT());

  setStatus('Filling: Price');
  const priceInput = spanTextFinder('Price', 'input');
  if (!priceInput) {
    console.error('[Relister] Price input not found');
    return false;
  }
  const priceDigits = listing.price.replace(/[^0-9.]/g, '');
  priceInput.focus();
  nativeSetInput(priceInput, priceDigits);
  await sleep(SHORT());

  if (listing.categoryName) {
    setStatus('Filling: Category');
    const categorySuccess = await selectDropdownOption('Category', listing.categoryName);
    if (!categorySuccess) {
      console.warn('[Relister] Category selection failed — continuing without it');
    }
    await sleep(SHORT());
  }

  if (listing.condition) {
    setStatus('Filling: Condition');
    const conditionSuccess = await selectDropdownOption('Condition', listing.condition);
    if (!conditionSuccess) {
      console.warn('[Relister] Condition selection failed — continuing without it');
    }
    await sleep(SHORT());
  }

  if (listing.description) {
    setStatus('Filling: Description');
    const descTextarea = spanTextFinder('Description', 'textarea');
    if (descTextarea) {
      descTextarea.focus();
      nativeSetTextarea(descTextarea, listing.description);
      await sleep(SHORT());
    } else {
      console.warn('[Relister] Description textarea not found');
    }
  }

  // Location: not in GraphQL data, but clicking the field may trigger
  // auto-suggestions from Facebook's IP geolocation or browser history
  setStatus('Filling: Location');
  const locationInput = document.querySelector('input[aria-label*="Location"]')
                     || document.querySelector('input[placeholder*="ocation"]');
  if (locationInput) {
    if (listing.location) {
      locationInput.focus();
      nativeSetInput(locationInput, listing.location);
    } else {
      locationInput.focus();
      locationInput.click();
    }
    await sleep(800);
    const firstOption = await waitForElement('div[role="option"]', 3000);
    if (firstOption) {
      await scrollAndClick(firstOption);
      await sleep(SHORT());
    }
  }

  if (listing.photoUrls && listing.photoUrls.length > 0) {
    setStatus(`Uploading ${listing.photoUrls.length} photo(s)`);
    await uploadAllPhotos(listing.photoUrls);
    await sleep(MEDIUM());
  }

  return true;
}

async function selectDropdownOption(fieldLabel, optionValue) {
  const spans = Array.from(document.querySelectorAll('span'));
  const labelSpan = spans.find(s => s.textContent.trim() === fieldLabel);
  if (!labelSpan) {
    console.warn(`[Relister] "${fieldLabel}" span not found`);
    return false;
  }

  // Walk up from label to find the dropdown trigger (combobox/button), not the label itself
  let trigger = null;
  let node = labelSpan;
  for (let i = 0; i < 8; i++) {
    node = node.parentElement;
    if (!node) break;
    const combobox = node.querySelector('[role="combobox"], [role="button"][aria-haspopup], select');
    if (combobox) {
      trigger = combobox;
      break;
    }
  }

  await scrollAndClick(trigger || labelSpan);
  await sleep(MEDIUM());

  const firstOption = await waitForElement('div[role="option"]', 5000);
  if (!firstOption) {
    console.warn(`[Relister] No options appeared for "${fieldLabel}"`);
    return false;
  }

  const matchingOption = findRoleOption(optionValue);
  if (!matchingOption) {
    console.warn(`[Relister] Option "${optionValue}" not found for "${fieldLabel}"`);
    await scrollAndClick(firstOption);
    return false;
  }

  await scrollAndClick(matchingOption);
  return true;
}

async function publishListing() {
  setStatus('Publishing...');

  const publishBtn = await waitForElement('div[aria-label="Publish"]:not([aria-disabled])', 8000);
  if (!publishBtn) {
    console.error('[Relister] Publish button not found or disabled');
    return false;
  }

  await scrollAndClick(publishBtn);
  await sleep(3000);

  const stillOnCreatePage = window.location.href.includes('/create/item');
  return !stillOnCreatePage;
}

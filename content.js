'use strict';

// content.js v2.1.0 — Direct Facebook GraphQL API (no UI form interaction)
// Runs only on: /marketplace/you/selling

const SELLING_URL = 'https://www.facebook.com/marketplace/you/selling';
const RELIST_CLASS = 'fbr-relist-btn';

// ─── State ────────────────────────────────────────────────────────────────────
let _tokens = null;
let _docIds = null;

// ─── Tokens / DocIDs (via background) ────────────────────────────────────────

async function getTokens() {
  if (_tokens) return _tokens;
  const result = await chrome.runtime.sendMessage({ kind: 'GET_TOKENS' });
  if (result?.error) throw new Error(result.error);
  _tokens = result;
  return _tokens;
}

async function getDocIds(listingId) {
  if (_docIds) return _docIds;
  const result = await chrome.runtime.sendMessage({ kind: 'GET_DOC_IDS', listingId });
  if (result?.error) throw new Error(result.error);
  _docIds = result;
  return _docIds;
}

// ─── GraphQL ──────────────────────────────────────────────────────────────────

function isAuthError(text) {
  return text.includes('"error_code":1357004') ||
         text.includes('"error_code":190')     ||
         text.includes('OAuthException')        ||
         text.includes('Session has expired');
}

async function fbGraphQL(referrer, docId, mutationName, variables) {
  const t = await getTokens();
  const body = [
    ['av',                       t.user_id],
    ['__a',                      '1'],
    ['__comet_req',              '1'],
    ['fb_dtsg',                  t.fb_dtsg],
    ['fb_api_caller_class',      'RelayModern'],
    ['fb_api_req_friendly_name', mutationName],
    ['variables',                encodeURIComponent(JSON.stringify(variables))],
    ['doc_id',                   docId]
  ].map(([k, v]) => `${k}=${v}`).join('&');

  const res = await fetch('https://www.facebook.com/api/graphql/', {
    method: 'POST',
    headers: { accept: '*/*', 'content-type': 'application/x-www-form-urlencoded' },
    referrer,
    referrerPolicy: 'strict-origin-when-cross-origin',
    body,
    mode: 'cors',
    credentials: 'include'
  });

  const text = await res.text();

  if (isAuthError(text)) {
    _tokens = null;
    _docIds = null;
    chrome.runtime.sendMessage({ kind: 'CLEAR_CACHE' });
    throw new Error('Facebook session expired — please refresh and try again');
  }

  // Strip FB's anti-CSRF prefix "for (;;);" if present
  const clean = text.replace(/^for\s*\(;;\);/, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    throw new Error('Could not parse GraphQL response');
  }
}

// ─── Deep JSON search ─────────────────────────────────────────────────────────

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

// ─── Read listing data ────────────────────────────────────────────────────────

async function readDetailPage(listingId) {
  const res = await fetch(`https://www.facebook.com/marketplace/item/${listingId}/`, {
    method: 'GET',
    credentials: 'include',
    referrerPolicy: 'strict-origin-when-cross-origin'
  });
  const html = await res.text();
  const doc  = new DOMParser().parseFromString(html, 'text/html');
  const scripts = Array.from(doc.getElementsByTagName('script'))
    .filter(s => s.type === 'application/json');

  for (const s of scripts) {
    try {
      const data  = JSON.parse(s.textContent || '{}');
      const found = deepFind(data, 'marketplace_product_details_page');
      if (found) return found;
    } catch {}
  }
  return null;
}

async function readComposerData(listingId, ids) {
  if (!ids.read_id) return null;
  try {
    const json = await fbGraphQL(
      SELLING_URL,
      ids.read_id,
      'CometMarketplaceComposerRootComponentQuery',
      {
        listingId,
        is_edit: true,
        composer_mode: 'EDIT_LISTING',
        scale: 1,
        prefill_id: '0',
        category_id: '0',
        has_prefill_data: false,
        has_prefetched_category: false,
        delivery_types: ['in_person']
      }
    );
    return json?.data?.listing ?? null;
  } catch (e) {
    console.warn('[Relister] Composer query failed — using detail page only:', e.message);
    return null;
  }
}

// ─── Build create-mutation payload ───────────────────────────────────────────

function parsePrice(amount) {
  return String(amount ?? '0').replace(/\.\d+$/, '');
}

function buildListingData(detail, composer) {
  const target = detail?.target ?? {};
  const c      = composer ?? {};

  const categoryId = String(
    c.marketplace_listing_virtual_taxonomy_category?.id ??
    c.marketplace_listing_category_id ??
    target.marketplace_listing_category_id ??
    ''
  );

  const title       = String(c.marketplace_listing_title ?? target.marketplace_listing_title ?? '');
  const description = String(c.redacted_description ?? target.redacted_description ?? target.description ?? '');
  const price       = parsePrice(target.listing_price?.amount);
  const currency    = String(target.listing_price?.currency ?? 'USD');
  const latitude    = Number(target.location?.latitude  ?? 0);
  const longitude   = Number(target.location?.longitude ?? 0);

  const photoSources = c.listing_photos ?? target.listing_photos ?? [];
  const photoIds     = photoSources.map(p => String(p.id)).filter(Boolean);

  const deliveryTypes     = c.delivery_types ?? target.delivery_types ?? ['in_person'];
  const hiddenFromFriends = String(c.hidden_from_friends ?? target.hidden_from_friends_visibility ?? 'HIDDEN_FROM_FRIENDS');

  const hashtagSource = c.marketplace_hashtags ?? target.marketplace_hashtags ?? {};
  const hashtags = (hashtagSource.edges ?? hashtagSource.nodes ?? [])
    .map(h => h.tag_name).filter(Boolean);

  const attrArray = c.attribute_data ?? target.attribute_data ?? [];
  const vtAttrs   = { vt_attributes_free_form: {}, vt_attributes_normalized: {} };
  for (const attr of attrArray) {
    if (attr.attribute_type === 'DYNAMIC' && attr.attribute_id && attr.attribute_value_id) {
      vtAttrs.vt_attributes_normalized[attr.attribute_id] = attr.attribute_value_id;
    } else if (attr.attribute_name) {
      vtAttrs.vt_attributes_free_form[attr.attribute_name] = attr.value ?? attr.attribute_value ?? '';
    }
  }

  const sku = String(c.sku ?? target.sku ?? '1');

  return {
    title,
    description,
    category_id: categoryId,
    item_price: { currency, price },
    latitude,
    longitude,
    attribute_data_json: JSON.stringify(vtAttrs),
    delivery_types: deliveryTypes,
    hidden_from_friends_visibility: hiddenFromFriends,
    product_hashtag_names: hashtags,
    photo_ids: photoIds,
    video_ids: [],
    sku,
    // Composer surface constants required by FB API
    surface: 'composer',
    is_preview: false,
    is_personalization_required: null,
    personalization_info: null,
    draft_type: null,
    quantity: null,
    cost_per_additional_item: null,
    comparable_price: 'null',
    min_acceptable_checkout_offer_price: 'null',
    suggested_hashtag_names: [],
    variants: [],
    xpost_target_ids: [],
    // Shipping constants (in_person only — all disabled)
    shipping_offered: false,
    shipping_cost_option: 'BUYER_PAID_SHIPPING',
    shipping_price: 'null',
    shipping_label_price: '0',
    shipping_label_rate_code: null,
    shipping_label_rate_type: null,
    shipping_service_type: null,
    shipping_package_weight: null,
    shipping_options_data: [],
    shipping_calculation_logic_version: null,
    shipping_cost_range_lower_cost: null,
    shipping_cost_range_upper_cost: null,
    commerce_shipping_carrier: null,
    commerce_shipping_carriers: []
  };
}

// ─── Mutations ────────────────────────────────────────────────────────────────

async function deleteListing(listingId, ids) {
  const t    = await getTokens();
  const json = await fbGraphQL(
    SELLING_URL,
    ids.delete_id,
    'useCometMarketplaceForSaleItemDeleteMutation',
    {
      input: {
        client_mutation_id: '-1',
        actor_id: t.user_id,
        batch_delete_variants: true,
        for_sale_item_id: listingId,
        referral_surface: 'MARKETPLACE_INSIGHTS',
        surface: 'MARKETPLACE_PAGE_SELLING'
      }
    }
  );
  if (json?.errors?.length) throw new Error('Delete failed: ' + json.errors[0]?.message);
}

async function createListing(listingData, ids) {
  const t    = await getTokens();
  const json = await fbGraphQL(
    'https://www.facebook.com/marketplace/create/item',
    ids.create_id,
    'useCometMarketplaceListingCreateMutation',
    {
      input: {
        client_mutation_id: '-1',
        actor_id: t.user_id,
        audience: { marketplace: { marketplace_id: t.marketplace_id } },
        data: { common: listingData }
      }
    }
  );
  if (json?.errors?.length) throw new Error('Create failed: ' + json.errors[0]?.message);
  return json?.data?.marketplace_listing_create?.listing?.id ?? null;
}

// ─── Relist orchestration ─────────────────────────────────────────────────────

async function relistItem(listingId, btn) {
  const setState = (text, bg) => {
    btn.textContent = text;
    btn.style.background = bg || '#1877f2';
    btn.disabled = (bg === '#888');
  };

  try {
    setState('Loading…', '#888');

    const ids = await getDocIds(listingId);

    setState('Reading…', '#888');
    const [detail, composer] = await Promise.all([
      readDetailPage(listingId),
      readComposerData(listingId, ids)
    ]);

    if (!detail) throw new Error('Could not read listing data');

    const listingData = buildListingData(detail, composer);
    if (!listingData.title)                  throw new Error('Listing has no title');
    if (!listingData.category_id)            throw new Error('Listing has no category');
    if (listingData.photo_ids.length === 0)  throw new Error('No photos found — cannot relist');

    setState('Deleting…', '#888');
    await deleteListing(listingId, ids);

    setState('Posting…', '#888');
    const newId = await createListing(listingData, ids);

    setState('Done ✓', '#2e7d32');
    chrome.storage.local.set({ status: `Relisted ✓ new ID: ${newId}`, statusTime: Date.now() });

    setTimeout(() => location.reload(), 2000);

  } catch (e) {
    setState('Error ✗', '#c62828');
    btn.disabled = false;
    chrome.storage.local.set({ status: `Error: ${e.message}`, statusTime: Date.now() });
    console.error('[Relister v2.1.0]', e);
    setTimeout(() => setState('Relist', '#1877f2'), 4000);
  }
}

// ─── UI injection ─────────────────────────────────────────────────────────────

function getListingId(href) {
  const m = (href || '').match(/\/marketplace\/item\/(\d+)/);
  return m ? m[1] : null;
}

function injectButton(anchor) {
  const listingId = getListingId(anchor.href);
  if (!listingId) return;

  // Walk up to find a good container (listing card)
  let card = anchor.parentElement || anchor;
  for (let i = 0; i < 5; i++) {
    const p = card.parentElement;
    if (!p || p === document.body) break;
    const style = getComputedStyle(p);
    if (style.position !== 'static') break;
    card = p;
  }

  if (card.querySelector('.' + RELIST_CLASS)) return;

  const btn = document.createElement('button');
  btn.className   = RELIST_CLASS;
  btn.textContent = 'Relist';
  btn.title       = 'Delete & re-post this listing';
  btn.style.cssText = [
    'position:absolute',
    'bottom:8px',
    'right:8px',
    'z-index:9999',
    'background:#1877f2',
    'color:#fff',
    'border:none',
    'border-radius:6px',
    'padding:5px 12px',
    'font-size:12px',
    'font-weight:700',
    'cursor:pointer',
    'box-shadow:0 2px 6px rgba(0,0,0,.4)',
    'line-height:1.5'
  ].join(';');

  btn.addEventListener('mouseenter', () => { if (!btn.disabled) btn.style.background = '#166fe5'; });
  btn.addEventListener('mouseleave', () => { if (btn.style.background === 'rgb(22, 111, 229)') btn.style.background = '#1877f2'; });

  btn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    relistItem(listingId, btn);
  });

  if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
  card.appendChild(btn);
}

function scanListings() {
  document.querySelectorAll('a[href*="/marketplace/item/"]:not([data-fbr-scanned])').forEach(a => {
    a.setAttribute('data-fbr-scanned', '1');
    injectButton(a);
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

const _observer = new MutationObserver(scanListings);
_observer.observe(document.body, { childList: true, subtree: true });
scanListings();

// Pre-warm tokens so first click is instant
chrome.runtime.sendMessage({ kind: 'GET_TOKENS' }).catch(() => {});

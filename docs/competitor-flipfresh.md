# FlipFresh v7.0.76 — Full Reverse-Engineer Analysis

**Extension:** FlipFresh — Facebook Marketplace Reposter & AI Assistant  
**Version:** 7.0.76  
**Date analyzed:** 2026-06-20  
**Purpose:** Understand exact repost mechanism to build our own extension  
**Source files analyzed:** `background.js` (97KB), `netcap.js` (6.7KB), `content.js` (63KB)

---

## TL;DR — The Repost Mechanism

FlipFresh reposts a listing via **DELETE then CREATE** (not a "renew" or "repost" mutation). It:

1. Reads the source listing from two FB pages in parallel
2. Re-downloads every photo and re-uploads to get new photo IDs
3. Deletes the original listing via GraphQL mutation
4. Creates a brand-new listing with the same data via GraphQL mutation

There is no magic "relist" API endpoint. FB doesn't expose one. FlipFresh emulates what a user does in the browser, but programmatically via direct `/api/graphql/` calls — all run **inside the FB page context** via `chrome.scripting.executeScript({ world: "MAIN" })`.

---

## Architecture Overview

```
background.js (service worker)
  └─ ie()          → harvest live doc_ids from open FB tabs (cached 6h)
  └─ N(fn, args)   → execute any function in FB page context (MAIN world)
  └─ le()          → POST to /api/graphql/ (runs inside FB tab)
  └─ $e(listingId) → full repost flow
       ├─ se(id)   → read /marketplace/item/{id}/
       ├─ ue(id)   → read /marketplace/edit/?listing_id={id}
       ├─ he()     → merge both reads
       ├─ upload photos (re-download URL → re-upload)
       ├─ delete mutation
       └─ create mutation

netcap.js (injected into /marketplace/you/selling)
  └─ XHR intercept → captures MarketplaceYouSellingFastActiveSectionPaginationQuery responses
  └─ DOM observer  → captures <script type="application/json"> tags
  └─ stores results in window.__rp_captured[listingId] + #__fb_mc_root DOM element

content.js (injected on all FB marketplace pages)
  └─ captures CometMarketplaceComposerRootComponentQuery XHR responses
  └─ chrome.runtime.sendMessage("COMPOSER_CAPTURED") → background.js
```

---

## 1. GraphQL API Call — `le()` Function

All GraphQL calls go to `https://www.facebook.com/api/graphql/` as `application/x-www-form-urlencoded` POST, executed inside the FB tab's page context via `chrome.scripting.executeScript({ world: "MAIN" })`.

**Request body (URL-encoded form fields):**
```
av=<user_id>
&__a=1
&__comet_req=1
&fb_dtsg=<encoded_fb_dtsg>
&fb_api_caller_class=RelayModern
&fb_api_req_friendly_name=<friendly_name>
&variables=<URL-encoded JSON string>
&doc_id=<doc_id>
```

**Request headers:**
```
content-type: application/x-www-form-urlencoded
x-fb-friendly-name: <friendly_name>
```

**Fetch options:**
```javascript
{ credentials: "include", mode: "cors" }
```

**Response parsing:**
```javascript
// FB prefixes responses with "for(;;);" — strip it
let text = await response.text();
text = text.replace(/^for\(;;\);/, "");
// FB may return multiple newline-separated JSON chunks — parse only first
let firstChunk = text.split("\n")[0];
let data = JSON.parse(firstChunk);
```

---

## 2. Auth Token Extraction

All tokens extracted from `document.documentElement.innerHTML` via regex. Applied inside the FB tab via `chrome.scripting.executeScript`.

```javascript
// User ID
const user_id = html.match(/"USER_ID":"(\d+)"/)?.[1];

// DTSG token (two patterns, first wins)
const fb_dtsg = 
  html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"}/)?.[1] ||
  html.match(/"token":"(DAD[^"]+)"/)?.[1];

// Marketplace ID (four fallback patterns)
const marketplace_id =
  html.match(/"current_marketplace":\{"[^}]*?"id":"(\d+)"}/)?.[1] ||
  html.match(/"current_marketplace"[^{}]*\{[^}]*"id":"(\d+)"}/)?.[1] ||
  html.match(/"current_marketplace_id":"(\d+)"/)?.[1] ||
  html.match(/"marketplace_id":"(\d+)"/)?.[1];
```

If tokens not found on current page, FlipFresh fetches `/marketplace/you/selling` page with `credentials: include` and parses the HTML response.

---

## 3. Doc ID Strategy — `ie()` Function

doc_ids are **not permanently hardcoded**. FlipFresh harvests them live from open FB tabs and caches them for 6 hours.

### Hardcoded Fallbacks (top of background.js)
```javascript
var r = {
  CometMarketplaceComposerRootComponentQuery_facebookRelayOperation: "27736074505998825",
  MarketplacePDPC2CMediaViewerWithImagesQuery_facebookRelayOperation: "10059604367394414",
  useCometMarketplaceListingCreateMutation_facebookRelayOperation: "9551550371629242",
  useCometMarketplaceForSaleItemDeleteMutation_facebookRelayOperation: "30073389588942699"
};
```
These go stale when FB deploys. FlipFresh only uses them as last resort.

### Live Harvest Strategy
1. Check `ff_docid_cache_v1` in `chrome.storage` — valid for `216e5` ms (6 hours)
2. Probe currently-open `*://*.facebook.com/marketplace*` tabs — each URL type exposes different doc_ids:
   - `/marketplace/edit/*` → `CometMarketplaceComposerRootComponentQuery`
   - `/marketplace/item/*` or `/marketplace/create/*` → `MarketplacePDPC2CMediaViewerWithImagesQuery` + ListingCreate
   - `/marketplace/you/selling` → `ForSaleItemDelete`
3. For missing doc_ids, open a fresh tab to the needed URL, wait 9 seconds, then 1.4–3.2s extra, probe, close the tab
4. Fall back to hardcoded `r` object if probe fails

### How doc_ids are extracted from a tab
`chrome.scripting.executeScript({ world: "MAIN" })` runs inside the FB tab and probes `window.__relay_store__` or `window.relayData` or parses `<script type="application/json">` tags looking for `_facebookRelayOperation` keys.

---

## 4. Delete Mutation

```javascript
// friendly_name
"useCometMarketplaceForSaleItemDeleteMutation"

// doc_id from:
r.useCometMarketplaceForSaleItemDeleteMutation_facebookRelayOperation
// = "30073389588942699"

// referrer header
"https://www.facebook.com/marketplace/you/selling"

// variables
{
  input: {
    client_mutation_id: "-1",
    actor_id: String(user_id),
    batch_delete_variants: true,
    for_sale_item_id: String(listingId),
    referral_surface: "MARKETPLACE_INSIGHTS",
    surface: "MARKETPLACE_PAGE_SELLING"
  }
}
```

---

## 5. Create Mutation

```javascript
// friendly_name
"useCometMarketplaceListingCreateMutation"

// doc_id from:
r.useCometMarketplaceListingCreateMutation_facebookRelayOperation
// = "9551550371629242"

// referrer header
"https://www.facebook.com/marketplace/create/item"

// variables (outer wrapper — same for all listing types)
{
  input: {
    client_mutation_id: "-1",
    actor_id: String(user_id),
    audience: {
      marketplace: {
        marketplace_id: String(marketplace_id)
      }
    },
    data: {
      common: <PAYLOAD — see below by listing type>
    }
  }
}

// Response — extract new listing ID:
response?.data?.marketplace_listing_create?.listing?.id
```

Up to 4 retries on create if it fails.

### 5a. General Item Payload (`data.common`)

```javascript
{
  attribute_data_json: JSON.stringify(attribute_data_obj),  // see Section 6
  category_id: String(category_id),
  delivery_types: delivery_types,           // array, e.g. ["LOCAL_PICKUP"]
  description: description_text,
  hidden_from_friends_visibility: "HIDDEN_FROM_FRIENDS",
  item_price: {
    currency: "USD",                        // from source listing currency
    price: String(priceAmount)
  },
  longitude: String(lon),
  latitude: String(lat),
  product_hashtag_names: [],                // from marketplace_hashtags edges/nodes
  title: title,
  video_ids: [],
  photo_ids: new_uploaded_photo_ids,        // array of newly uploaded IDs (NOT original)
  commerce_shipping_carrier: null,
  commerce_shipping_carriers: [],
  comparable_price: "null",
  cost_per_additional_item: null,
  draft_type: null,
  is_personalization_required: null,
  is_preview: false,
  min_acceptable_checkout_offer_price: "null",
  personalization_info: null,
  quantity: null,
  shipping_calculation_logic_version: null,
  shipping_cost_option: "BUYER_PAID_SHIPPING",
  shipping_cost_range_lower_cost: null,
  shipping_cost_range_upper_cost: null,
  shipping_label_price: "0",
  shipping_label_rate_code: null,
  shipping_label_rate_type: null,
  shipping_offered: false,
  shipping_options_data: [],
  shipping_package_weight: null,
  shipping_price: "null",
  shipping_service_type: null,
  sku: "1",
  suggested_hashtag_names: [],
  surface: "composer",
  variants: [],
  xpost_target_ids: []
}
```

### 5b. Vehicle Listing Payload

No `attribute_data_json`. Uses `serialized_verticals_data` verbatim from source.

```javascript
{
  category_id: String(category_id),
  description: description,
  item_price: { price: String(priceAmount) },
  latitude: String(lat),
  longitude: String(lon),
  title: title,
  serialized_verticals_data: original_svd_string,  // passed through unchanged
  video_ids: [],
  xpost_target_ids: [],
  photo_ids: new_uploaded_photo_ids
}
```

### 5c. Real Estate / Rental Payload

Uses `serialized_verticals_data` but merges in specific fields from the listing.

```javascript
{
  category_id: String(category_id),
  description: description,
  item_price: { price: String(priceAmount) },
  serialized_verticals_data: JSON.stringify({
    ...original_verticals_obj,
    availableDate: listing.availableDate,
    furnishingType: listing.furnishingType,
    parkingSpaces: listing.parkingSpaces
  }),
  title: title,
  video_ids: [],
  xpost_target_ids: [],
  photo_ids: new_uploaded_photo_ids
}
```

---

## 6. `attribute_data_json` Construction

Source listing has an `attribute_data` array with `{attribute_name, value}` objects (e.g. condition, make, model). FlipFresh flattens this to a single JSON object with lowercased keys:

```javascript
// Source: listing.attribute_data = [{attribute_name: "Condition", value: "Good"}, ...]
const obj = {};
listing.attribute_data.forEach(a => {
  obj[a.attribute_name.toLowerCase()] = a.value;
});
attribute_data_json = JSON.stringify(obj);
// Result: '{"condition":"Good","make":"Toyota",...}'
```

---

## 7. Photo Re-Upload

Photos **cannot** reuse existing IDs. FlipFresh re-downloads each photo and re-uploads to get new IDs.

### Step 1 — Re-download
```javascript
// Strip FB's STP tracking param to get the raw CDN URL
const cleanUrl = photoUrl.replace(/&stp=[^&]+/, "").replace(/\?stp=[^&]+&/, "?");
const response = await fetch(cleanUrl, { credentials: "include" });
const blob = await response.blob();
// Convert to base64 dataURL via FileReader
```

### Step 2 — Upload
```javascript
// Endpoint
POST https://upload.facebook.com/ajax/react_composer/attachments/photo/upload
  ?av={user_id}
  &__user={user_id}
  &__a=1
  &fb_dtsg={encodeURIComponent(fb_dtsg)}

// Form fields (multipart/form-data)
fb_dtsg: <token>
target_id: <marketplace_id>
source: "8"
profile_id: <user_id>
farr: <Blob from base64 dataURL>
```

### Step 3 — Extract new photo ID
```javascript
const photoId = response.payload?.photoID 
  || response.payload?.photo_id 
  || response.payload?.id;
```

---

## 8. Listing Data Read — Dual Source

FlipFresh reads listing data from TWO pages in parallel (`Promise.all`) and merges them. This ensures maximum data completeness.

### Source A — Item Page: `se(listingId)`
URL: `https://www.facebook.com/marketplace/item/{listingId}/`

Parses all `<script type="application/json">` tags. Scores each candidate JSON blob:
- `listing_price` present: +4 pts
- `title` present: +4 pts
- `serialized_verticals_data` present: +3 pts
- `attribute_data` present: +3 pts
- vehicle-specific fields (year, make, model): +2 pts
- `description` present: +1 pt
- `photo_attachments` or `listing_photos` present: +1 pt

Highest-scoring candidate is used. Looks for `marketplace_product_details_page` node in the JSON tree.

**Fields extracted:** title, price, currency, description, category_id, lat/lon, photos, attribute_data, typename, delivery_types, hashtags, serialized_verticals_data

### Source B — Edit Page: `ue(listingId)`
URL: `https://www.facebook.com/marketplace/edit/?listing_id={listingId}`

Fetches with `credentials: include, accept: text/html`. Parses JSON script tags.

**Primary goal:** Get `serialized_verticals_data` (the richest vertical-specific data — vehicle specs, property details). The edit page consistently has more complete SVD than the item page.

**Fields extracted:** serialized_verticals_data, vehicle fields (year/make/model/mileage/fuel type), lat/lon override, description, category.

### Merge: `he(itemData, editData)`
- Item-page preferred for: `__typename`, photos, lat/lon (unless edit page has better)
- Edit-page preferred for: `serialized_verticals_data` (always use edit page's if available)
- All other fields: item-page preferred, edit-page as fallback

---

## 9. Listing Type Detection — `ye(listing)`

```javascript
function ye(listing) {
  const typename = listing.__typename || "";
  const svd = listing.serialized_verticals_data || "";
  
  // Vehicle detection
  if (/vehicle/i.test(typename) || 
      /"fuelType"|"vehicleCondition"|"vehicleMileage"|"vehicleYear"/.test(svd)) {
    return "vehicle";
  }
  
  // Real estate detection
  if (/real.?estate|rental|property|housing/i.test(typename) ||
      /"bedroomCount"|"bathroomCount"|"availableDate"|"rentalType"/.test(svd)) {
    return "realestate";
  }
  
  // Default
  return "general";  // MarketplaceForSaleItemProductDetailsPage
}
```

---

## 10. Full Repost Flow — `$e(listingId)`

All steps go through a paced operation queue `O()` with **5–11 second random delays** between each step to avoid rate limiting. Between listings, there's an additional **5–6 minute delay**.

```
Phase 1: "Harvesting live IDs"
  → ie() — get doc_ids (from cache, open tabs, or fresh tab probes)

Phase 2: "Reading listing"  
  → Promise.all([se(listingId), ue(listingId)])  // parallel HTTP reads
  → he(itemData, editData)                       // merge
  → ye(merged)                                   // detect type (vehicle/realestate/general)

Phase 3: "Uploading photos"
  → For each photo URL:
      re-download (stripping stp param)
      re-upload to upload.facebook.com
      collect new photo_id

Phase 4: "Deleting old listing"
  → le(doc_id, "useCometMarketplaceForSaleItemDeleteMutation", deleteVars, referrer)

Phase 5: "Creating new listing"
  → build payload by type (sections 5a/5b/5c above)
  → le(doc_id, "useCometMarketplaceListingCreateMutation", createVars, referrer)
  → up to 4 retries on failure
  → extract new listing ID from response

Phase 6: "Done"
  → store new listing ID in chrome.storage
  → update UI badge/popup
```

---

## 11. netcap.js — Passive Listing Scraper

`netcap.js` is injected into `/marketplace/you/selling`. It is a **passive data capture** layer that pre-populates listing data so the repost flow doesn't always have to make fresh requests.

### XHR Interception
```javascript
// Intercepts FB's own pagination query on the selling page
const originalSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function(body) {
  this.addEventListener("load", function() {
    if (this.responseURL?.includes("MarketplaceYouSellingFastActiveSectionPaginationQuery")) {
      // Parse response, extract listing nodes
      // Store in window.__rp_captured[listingId] = {id, title, price, description, imageUrls}
    }
  });
  return originalSend.apply(this, arguments);
};
```

### DOM Observer
Also watches for dynamically injected `<script type="application/json">` tags on the page and parses them for `marketplace_listing_sets` data.

### Storage
```javascript
window.__rp_captured[listingId] = {
  id: listingId,
  title: "...",
  price: 123,
  description: "...",
  imageUrls: ["https://..."]
};
// Also written to:
document.getElementById("__fb_mc_root").setAttribute("data-listings", JSON.stringify(captured));
```

**Fallback pagination doc_id** used by netcap.js:
```javascript
// For the selling-page pagination query itself:
"6206851639350477"  // MarketplaceYouSellingFastActiveSectionPaginationQuery hardcoded fallback
```

---

## 12. content.js — Composer Query Capture

Content script injected on all FB marketplace pages. When FB loads the composer (create/edit listing page), it naturally fires `CometMarketplaceComposerRootComponentQuery` to get the form schema. content.js intercepts this XHR response and relays it to background.js via:

```javascript
chrome.runtime.sendMessage({ type: "COMPOSER_CAPTURED", data: composerResponse });
```

This lets FlipFresh know the live doc_id for the composer query without explicitly probing for it.

---

## 13. Key Insights for Our Implementation

| Topic | FlipFresh Approach | Notes |
|-------|-------------------|-------|
| Repost method | DELETE + CREATE (no relist API) | This is the only option — FB has no relist mutation |
| Doc IDs | Live harvest + 6h cache + hardcoded fallbacks | Hardcoded IDs go stale; must harvest or have update mechanism |
| Photo IDs | Always re-upload | Old photo IDs are tied to the old listing — cannot reuse |
| Token source | `document.documentElement.innerHTML` regex | Must run inside FB page context (MAIN world) |
| API execution context | `chrome.scripting.executeScript({ world: "MAIN" })` | All API calls inside FB tab — bypasses CORS |
| Rate limiting | 5–11s between operations, 5–6 min between listings | Aggressive pacing to avoid detection |
| Listing read | Dual-source: item page + edit page | Edit page has better SVD; item page has better photos/typename |
| Attribute data | Flat lowercased JSON obj from attribute_data array | Field names are lowercased when building attribute_data_json |
| Vertical detection | typename regex + SVD content analysis | Three types: vehicle / realestate / general |
| SVD handling | Vehicles: pass through verbatim; Real estate: merge specific fields | Never parse SVD for vehicles — pass as-is |

---

## 14. Hardcoded Values Reference

```javascript
// doc_ids (as of v7.0.76 — will go stale)
CometMarketplaceComposerRootComponentQuery:              "27736074505998825"
MarketplacePDPC2CMediaViewerWithImagesQuery:             "10059604367394414"
useCometMarketplaceListingCreateMutation:                "9551550371629242"
useCometMarketplaceForSaleItemDeleteMutation:            "30073389588942699"
MarketplaceYouSellingFastActiveSectionPaginationQuery:   "6206851639350477"

// Storage keys
ff_docid_cache_v1    // chrome.storage — doc_id cache (6h TTL)

// Cache TTL
216e5 ms = 6 hours

// Pacing
5000–11000 ms between operations (Math.random() * 6000 + 5000)
300000–360000 ms (5–6 min) between listings

// API endpoints
POST https://www.facebook.com/api/graphql/
POST https://upload.facebook.com/ajax/react_composer/attachments/photo/upload

// Upload source identifier
source: "8"   // identifies this as a composer attachment upload
```

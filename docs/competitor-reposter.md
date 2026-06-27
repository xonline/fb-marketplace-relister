# Competitor Analysis: Marketplace Listings Reposter v1.70

Reverse-engineered from the publicly distributed Chrome extension (244KB contentScript.js + 221KB background.js + WASM module).

---

## 1. Repost Mechanism

**The mechanism is: CREATE new listing + DELETE old listing (option a).**

There is NO dedicated "renew" or "boost" API mutation. The extension orchestrates a full relist cycle:

1. Fetch auth tokens from the FB page (fb_dtsg, user_id, marketplace_id)
2. Fetch the 3 doc_ids needed (create, delete, listing-images query)
3. For each selected listing:
   - Call WASM `relist_listing(listing_id, fb_dtsg, user_id)` which internally:
     1. Calls `__wasm_get_listing(listing_id)` → reads source data via two GraphQL calls
     2. Re-uploads every photo from its URL via `__wasm_upload_photo_url(uri)` → gets new photo IDs
     3. Calls `__wasm_create_listing(data)` → fires `useCometMarketplaceListingCreateMutation`
     4. Calls `__wasm_delete_listing(listing_id)` → fires `useCometMarketplaceForSaleItemDeleteMutation`

The WASM binary (Rust/wasm-bindgen compiled) handles the orchestration; JS provides the FB API bridge via the `window.__wasm_*` callbacks.

---

## 2. The CREATE GraphQL Call

### Mutation Name
```
fb_api_req_friendly_name = "useCometMarketplaceListingCreateMutation"
```

### doc_id Source
The `doc_id` is NOT hardcoded. It is extracted dynamically from the FB page using `window.require()` against the relay operation name:

```javascript
// background.js uses chrome.scripting.executeScript in MAIN world:
window.require("useCometMarketplaceListingCreateMutation_facebookRelayOperation")
// Returns the numeric doc_id string for the current FB deploy
```

This is called with:
```javascript
Oa("useCometMarketplaceListingCreateMutation_facebookRelayOperation", 
   "https://www.facebook.com/marketplace/create/item")
```
The background script opens that URL (silently, as an inactive tab) and runs `window.require()` in the MAIN world to extract the live doc_id.

### POST Endpoint
```
POST https://www.facebook.com/api/graphql/
Referer: https://www.facebook.com/marketplace/create/item
```

### POST Body (form-urlencoded)
```
av={user_id}
__a=1
__comet_req=1
fb_dtsg={fb_dtsg}
fb_api_caller_class=RelayModern
fb_api_req_friendly_name=useCometMarketplaceListingCreateMutation
variables={JSON-encoded variables object}
doc_id={dynamically fetched doc_id}
```

### Variables Object — Full Structure

```javascript
{
  input: {
    client_mutation_id: "-1",
    actor_id: "{user_id}",           // same as av=
    audience: {
      marketplace: {
        marketplace_id: "{marketplace_id}"  // user's marketplace node ID
      }
    },
    data: {
      common: {
        // ---- CATEGORY ----
        category_id: "{marketplace_listing_category_id}",  // string, the taxonomy category id
        // Note: this is marketplace_listing_category_id (NOT marketplace_category_id)
        // Read from: m.marketplace_listing_category_id ?? f.target.marketplace_listing_category_id

        // ---- DESCRIPTION ----
        description: "{redacted_description}",
        // Read from: m.redacted_description ?? f.target.redacted_description

        // ---- TITLE ----
        title: "{marketplace_listing_title}",
        // Read from: m.marketplace_listing_title ?? f.target.marketplace_listing_title

        // ---- PRICE ----
        item_price: {
          currency: "{listing_price.currency}",  // e.g. "AUD"
          price: "{listing_price.amount stripped of trailing decimals}"
          // Strip: .replace(/\.([0-9]*)/, "")  → "150.00" → "150"
        },

        // ---- LOCATION ----
        latitude: {f.target.location.latitude},   // number
        longitude: {f.target.location.longitude},  // number

        // ---- ATTRIBUTES (for Item listings only) ----
        attribute_data_json: "{JSON.stringify(attributeMap)}",
        // Built from: attribute_data array of {attribute_name, value}
        // Transformed to: { [attribute_name.toLowerCase()]: value, ... }
        // e.g. {"condition": "USED_LIKE_NEW", "color": "Blue"}

        // ---- DELIVERY ----
        delivery_types: ["LOCAL_PICKUP"],
        // Read from: m.delivery_types ?? f.target.delivery_types
        // Default: []

        // ---- VISIBILITY ----
        hidden_from_friends_visibility: "HIDDEN_FROM_FRIENDS",
        // Read from: m.hidden_from_friends ?? f.target.hidden_from_friends
        // Default if missing or non-string: "HIDDEN_FROM_FRIENDS"

        // ---- HASHTAGS / TAGS ----
        product_hashtag_names: ["tag1", "tag2"],
        // Read from: marketplace_hashtags.edges or .nodes → map tag_name
        suggested_hashtag_names: [],

        // ---- MEDIA ----
        photo_ids: ["id1", "id2"],
        // IMPORTANT: these are NEW photo IDs from re-uploading the images
        // NOT the original listing photo IDs
        // Re-upload via: upload.facebook.com/ajax/react_composer/attachments/photo/upload
        // Original URIs come from: MarketplacePDPC2CMediaViewerWithImagesQuery
        //   → data.viewer.marketplace_product_details_page.target.listing_photos[].image.uri

        video_ids: ["vid1"],
        // Read from: (m.pre_recorded_videos ?? f.target.pre_recorded_videos).map(v => v.id)
        // Re-uploaded via WASM if present

        // ---- SHIPPING (all static/disabled for local listings) ----
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

        // ---- OTHER ----
        sku: "1",                        // always hardcoded "1"
        surface: "composer",             // always "composer"
        variants: [],
        xpost_target_ids: []
      }
    }
  }
}
```

### Response
```javascript
response.data.marketplace_listing_create.listing.id
// Returns the new listing ID string
```

---

## 2b. Listing Type Variants

The `data.common` payload differs by listing type (`f.__typename`):

| `f.__typename` | Category |
|---|---|
| `"MarketplaceForSaleItemProductDetailsPage"` | Item (general goods) |
| `"MarketplaceRealEstateProductDetailsPage"` | Real Estate |
| `"MarketplaceVehicleProductDetailsPage"` | Vehicle |

**For RealEstate listings**, the payload replaces most fields with:
```javascript
{
  category_id, description, title,
  item_price: { price: y },  // no currency field
  serialized_verticals_data: JSON.stringify(verticals),
  // verticals built from m.serialized_verticals_data parsed + extended with:
  //   availableDate, furnishingType (lowercased), parkingSpaces
  video_ids, xpost_target_ids: [], photo_ids
}
```

**For Vehicle listings**, the payload is:
```javascript
{
  category_id, description, title,
  item_price: { price: y },
  latitude, longitude,
  serialized_verticals_data: m.serialized_verticals_data,  // raw, not reparsed
  video_ids, xpost_target_ids: [], photo_ids
}
```

---

## 3. The DELETE GraphQL Call

### Mutation Name
```
fb_api_req_friendly_name = "useCometMarketplaceForSaleItemDeleteMutation"
```

### doc_id Source
```javascript
window.require("useCometMarketplaceForSaleItemDeleteMutation_facebookRelayOperation")
// fetched from: https://www.facebook.com/marketplace/you/selling
```

### Variables
```javascript
{
  input: {
    client_mutation_id: "-1",
    actor_id: "{user_id}",
    batch_delete_variants: true,
    for_sale_item_id: "{listing_id}",
    referral_surface: "MARKETPLACE_INSIGHTS",
    surface: "MARKETPLACE_PAGE_SELLING"
  }
}
```

POST referrer: `https://www.facebook.com/marketplace/you/selling`

---

## 4. How It Reads Source Listing Data

Two separate GraphQL calls are made to read each listing:

### Call 1: Item page HTML parse
```
GET https://www.facebook.com/marketplace/item/{listing_id}/
```
Parses the raw HTML, extracts inline JSON via `window.require("marketplace_product_details_page")`.

This gives `f` (the marketplace_product_details_page object) with fields:
- `f.__typename` (listing type)
- `f.target.marketplace_listing_category_id`
- `f.target.redacted_description`
- `f.target.listing_price.amount` and `.currency`
- `f.target.marketplace_listing_title`
- `f.target.pre_recorded_videos` (array with `.id`, `.playable_url`)
- `f.target.listing_photos` (array with `.id`, `.image.uri`)
- `f.target.location.latitude` / `.longitude`
- `f.target.attribute_data` (array of `{attribute_name, value}`)
- `f.target.delivery_types`
- `f.target.hidden_from_friends`
- `f.target.marketplace_hashtags` (`.edges` or `.nodes` with `tag_name`)

### Call 2: Edit composer GraphQL query
```
GET https://www.facebook.com/marketplace/edit/?listing_id={listing_id}
```
First extracts doc_id for `CometMarketplaceComposerRootComponentQuery_facebookRelayOperation` from that page, then:

```
POST https://www.facebook.com/api/graphql/
fb_api_req_friendly_name = "CometMarketplaceComposerRootComponentQuery"
variables = {
  category_id: "0",
  composer_mode: "EDIT_LISTING",
  delivery_types: ["in_person"],
  has_prefetched_category: false,
  has_prefill_data: false,
  is_edit: true,
  listingId: "{listing_id}",
  prefill_id: "0",
  scale: 1
}
```

Response: `data.listing` → this gives `m` (group_commerce_product_item) which often has richer/override data that takes precedence over `f` in the `m ?? f.target` pattern throughout.

### Call 3: Image URIs (separate query)
```
fb_api_req_friendly_name = "MarketplacePDPC2CMediaViewerWithImagesQuery"
doc_id: window.require("MarketplacePDPC2CMediaViewerWithImagesQuery_facebookRelayOperation")
        // fetched from: https://www.facebook.com/marketplace/
variables = { targetId: "{listing_id}" }
```
Referrer: `https://www.facebook.com/marketplace/you/selling`

Response path:
```
data.viewer.marketplace_product_details_page.target.listing_photos[].image.uri
```
These URIs are the CDN URLs that get re-fetched and re-uploaded.

**Data priority**: `m.field ?? f.target.field` (the edit-composer response overrides the item-page data).

---

## 5. Photo Handling — Re-Upload (NOT Reuse)

Photos are **re-uploaded**, not reused by ID. The flow is:

1. Fetch original photo CDN URIs via `MarketplacePDPC2CMediaViewerWithImagesQuery`
2. For each URI, fetch the image bytes and upload to FB's composer upload endpoint:

```
POST https://upload.facebook.com/ajax/react_composer/attachments/photo/upload
     ?av={user_id}&__user={user_id}&__a=1&fb_dtsg={fb_dtsg}

FormData:
  fb_dtsg       = {fb_dtsg}
  target_id     = {marketplace_id}
  source        = "8"
  profile_id    = {user_id}
  farr          = {image blob}
```

Response: strip first 9 chars (FB's `for (;;);` prefix), parse JSON:
```
response.payload.photoID  →  new photo ID string
```

These new photo IDs are what go into `photo_ids` in the create mutation.

**Photo IDs from the old listing are never reused** — they would be invalidated when the old listing is deleted anyway.

---

## 6. Auth — How fb_dtsg, user_id, marketplace_id Are Obtained

All three are extracted from the FB Marketplace selling page on load:

```
GET https://www.facebook.com/marketplace/you/selling
```

Then parsed from inline JSON script tags using `window.require()` (via `chrome.scripting.executeScript` in MAIN world):

| Token | Source |
|---|---|
| `user_id` | `window.require("CurrentUserInitialData").USER_ID` |
| `fb_dtsg` | `window.require("DTSGInitialData").token` |
| `marketplace_id` | `window.require("current_marketplace").id` (from page JSON data search) |

The `marketplace_id` is also extracted via the `Ma()` helper which does a JSON deep-search for the `"current_marketplace"` key in the parsed page data.

The extension also intercepts `MarketplaceYouSellingFastActiveSectionPaginationQuery` XHR responses (via `network_listener.js` injected into the page) to grab the active listing set without a separate API call.

---

## 7. Rate Limiting

The extension uses p-queue with:
- `intervalCap: 1, interval: 3000ms` for create, delete, and update operations
- Meaning: **1 operation per 3 seconds per queue**

---

## 8. Update Listing Mutation (for reference)

There is also an edit/update path (not used in repost, but available):

```
fb_api_req_friendly_name = "useCometMarketplaceListingEditMutation"
doc_id: window.require("useCometMarketplaceListingEditMutation_facebookRelayOperation")
        // fetched from: https://www.facebook.com/marketplace/edit/?listing_id={id}

variables = {
  input: {
    client_mutation_id: "-1",
    actor_id: "{user_id}",
    data: { common: {same structure as create} },
    listing_id: "{listing_id}"
  }
}
```

Response: `data.marketplace_listing_edit`

---

## 9. Complete Repost Flow Summary

```
1. Page loads at facebook.com/marketplace/you/selling
2. network_listener.js intercepts XHR → captures listing sets
3. contentScript populates Ga{} object:
   - user_id  ← window.require("CurrentUserInitialData").USER_ID
   - fb_dtsg  ← window.require("DTSGInitialData").token
   - marketplace_id ← window.require("current_marketplace").id
4. User selects listings + clicks "Repost Selected"
5. Parallel fetch 3 doc_ids:
   - create_listing_doc_id ← require("useCometMarketplaceListingCreateMutation_facebookRelayOperation") from /marketplace/create/item
   - delete_listing_doc_id ← require("useCometMarketplaceForSaleItemDeleteMutation_facebookRelayOperation") from /marketplace/you/selling  
   - listing_doc_id        ← require("MarketplacePDPC2CMediaViewerWithImagesQuery_facebookRelayOperation") from /marketplace/
6. For each listing (throttled 1 per 3s):
   a. Load WASM module (video_upload_bg.wasm via video_upload.js)
   b. WASM calls __wasm_get_listing(listing_id):
      - GET /marketplace/item/{id}/ → parse inline JSON (f)
      - POST CometMarketplaceComposerRootComponentQuery → get edit data (m)
      - POST MarketplacePDPC2CMediaViewerWithImagesQuery → get image URIs
      - Returns JSON: {listing, has_videos, video_urls, image_uris}
   c. WASM re-uploads each image:
      - __wasm_upload_photo_url(uri) → POST to upload.facebook.com → new photoID
   d. WASM calls __wasm_create_listing(dataJSON):
      - POST /api/graphql/ useCometMarketplaceListingCreateMutation
      - Returns new listing ID
   e. WASM calls __wasm_delete_listing(old_listing_id):
      - POST /api/graphql/ useCometMarketplaceForSaleItemDeleteMutation
7. window.location.reload() to refresh the listing view
```

---

## Key Implementation Notes

1. **doc_ids are dynamic** — never hardcode them. Always extract via `window.require("{MutationName}_facebookRelayOperation")` from the appropriate FB page.

2. **photo_ids in the create payload are NEW IDs** from a fresh upload, not the source listing's photo IDs.

3. **category_id is `marketplace_listing_category_id`** — this is the taxonomy/virtual category string (e.g. `"362933047426989"`), NOT a simple category name.

4. **`attribute_data_json` is a JSON string** (double-encoded) — the object `{[attr_name.toLowerCase()]: value}` is `JSON.stringify()`-ed into a string before being placed in the variables.

5. **Price stripping**: `listing_price.amount.replace(/\.([0-9]*)/, "")` — removes decimals entirely (cents are dropped, so `"150.00"` → `"150"`).

6. **`sku` is always `"1"`** — hardcoded regardless of source listing.

7. **The WASM module contains the orchestration logic** (Rust compiled to wasm-bindgen). The JS side only provides `window.__wasm_*` callbacks that the WASM calls out to. The actual sequencing (get → upload photos → create → delete) runs inside the WASM binary.

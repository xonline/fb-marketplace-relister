# Competitor Analysis: Facebook Marketplace AI Manager, Reposter, Relister v1.0.45

Reverse-engineered from extension files: `relisting.js` (35KB), `scraper.js` (18KB), `content.js` (33KB), `background.js` (48KB).  
Files were **readable JavaScript** (not minified).

---

## 1. Repost Mechanism — The Answer

**Pure UI automation. Zero GraphQL. Zero direct API calls.**

The extension drives the Facebook Marketplace web UI by:
1. **Scraping** the listing from the FB edit page (DOM scrape of the `/marketplace/edit/` form)
2. **Deleting** the old listing by clicking through the selling dashboard UI (`/marketplace/you/selling`)
3. **Creating** a new listing by navigating to `/marketplace/create/{type}` and filling the form via DOM manipulation + dispatching synthetic events

There is no `fb_dtsg`, no `doc_id`, no `fb_api_req_friendly_name`, no `attribute_data_json`, no GraphQL payload of any kind. The entire flow is tab-based UI driving.

---

## 2. Full Repost Flow (Step-by-Step)

### Phase 1 — Scrape (triggered by `checkScheduledReposts` alarm every 1 minute)

1. `background.js` polls `chrome.storage.local` for `selectedAds` (user's scheduled listings).
2. Checks `repost.lastRun` + `repost.frequency` + `repost.unit` (`"hour"` or `"day"`) to decide if it's time.
3. Opens `/marketplace/you/selling` in a background tab.
4. Sends `openEditMenus` message to `content.js` on that tab.
5. `content.js` scrolls to bottom, finds the matching ad card by title+price match, clicks its **"More options"** button (`[aria-label="More options for {title}"]`), then clicks the **Edit listing** link.
6. The edit URL (`/marketplace/edit/?listing_id=xxx`) is opened as a new background tab.
7. `background.js` receives `openTab` message → opens edit URL → calls `sendMessageToScaper` → sends `scrapeData` message to `scraper.js` on that tab.

### Phase 2 — Scraper captures listing data (in `scraper.js`)

```javascript
// Called on the /marketplace/edit/?listing_id=xxx page
async function scrapeData(ad, listingId) {
  setTimeout(async () => {
    const adId = extractAdId();                        // from URL ?listing_id=
    const extractedData = await getTextAndInputValues(); // inputs + textareas + list items
    const getCategory = await getCategoryAndCondition(); // label[role="combobox"] values
    let extractImagesdata = await extractImagesWithParentDivs(); // img.src from div.x1c4vz4f
    const getCheckbox = await getCheckboxStatus();     // [role="checkbox"] states
    const isCheckbox = await isCheckboxChecked();      // "Hide from friends" toggle
    const scrapeList = await scrapeListItems();        // ul>li[aria-hidden=false] key-value pairs
    
    // Determine listing type
    const type = extractedData[0]?.title === "Title" ? "item"
               : extractedData[0]?.title === "Location" ? "vehicle"
               : "rental";

    const productData = {
      adId,       // listing_id from URL
      type,       // "item" | "vehicle" | "rental"
      extractedData,
      getCategory,
      extractImagesdata,
      getCheckbox,
      isCheckbox,
      relist: false,
      deleted: false,
      id: `${btoa(encodeURIComponent(title))}-${price.replace(/[^0-9]/g, "")}`,
      selected: ad,  // original ad object from selectedAds
    };
    
    await saveToChromeStorage(productData, ad, listingId);
    chrome.runtime.sendMessage({ action: "closeTab" });
  }, 3000);
}
```

### Scraper DOM selectors

| Field | Method |
|-------|--------|
| `extractedData` (inputs/textareas) | `div.x78zum5.xdt5ytf.xh8yej3` → finds `span` (title) + `input`/`textarea` (value) |
| `extractedData` (list items) | `ul > li[aria-hidden='false']` → `span.x150jy0e span.x193iq5w` (key) + `span.x1e558r4 span.x193iq5w` (value) |
| `getCategory` (dropdowns) | `label.x78zum5.xh8yej3` → `span` (title) + `div > div > span` or `div > input` (value) |
| `extractImagesdata` | `div.x1c4vz4f img` → `img.src`, excludes `data:image` and `static.xx.fbcdn.net` URLs |
| `getCheckbox` | `[role="checkbox"]` → `aria-checked` + text |
| `isCheckbox` (hide from friends toggle) | `[aria-label="Enabled"]` → `aria-checked` attribute |
| `adId` | `new URL(window.location.href).searchParams.get("listing_id")` |

**Photos: re-fetched from their CDN URL, re-uploaded as new files.** No photo ID reuse.

### Phase 3 — Delete old listing

After scraping, `sendDelete()` is called which sends `deleteAd` to `background.js`.

`background.js` opens `/marketplace/you/selling` in a tab, calls `sendMessageToDelete()` → sends `deletingAd` to `content.js`.

`content.js` `openDeleteMenu(title, price)`:
1. Scrolls to bottom (`scrollToBottomAndWait`)
2. Queries ad cards: `div.x9f619.x1ja2u2z.x78zum5.x1n2onr6.x1r8uery.x1iyjqo2.xs83m0k...`
3. Matches by title+price using `createSlug()` comparison
4. Clicks **"More options"** button (`[aria-label="More options for {title}"]` or fallback selectors)
5. Calls `deleteListing()`:
   - Finds menu item containing "delete": `div[role="menuitem"]` matching `.innerText.toLowerCase().includes("delete")`
   - Clicks it
   - Waits 3s then calls `confirmDelete()`:
     - Fast path: `div[aria-label="Delete"]` where `innerText === "delete"` → click
     - Extended path: waits for `div[aria-label="Delete listing"]` popup → finds `div[aria-label="Delete"][role="button"]` inside it → click
   - Sends `deletetedAd` message when done

### Phase 4 — Create new listing (in `relisting.js`)

After delete, `background.js` opens `/marketplace/create/{type}` (where type = `item` | `vehicle` | `rental`) in a background tab.

`relisting.js` `relistMarketplaceAd(selectedIndex)` runs:

```javascript
// Execution order:
await clickTargetDiv();      // Clicks the composer activation div (long CSS selector)
await relistItem(adData);    // Fills all inputs/textareas/dropdowns (see below)
await fillCategory(adData);  // Handles the Category dropdown specifically
await uploadImages(adData);  // Re-downloads and re-uploads photos
await fillInputFields(adData); // Redundant fill pass with different selector
await fillDescription(adData); // Fills textarea[description]
await toggleHideFromFriends(adData); // Sets [aria-label="Enabled"][role="switch"]
await handleCheckboxes(adData); // Sets [role="checkbox"] states
await handleRental(adData);   // Extra pass for rental comboboxes
await relistCheckboxes(adData.extractedData, "label.x78zum5.xh8yej3");
// Wait 6s
await clickNextButton();     // Clicks div[aria-label="Next"][role="button"]
// Wait 4s
await clickPublishButton();  // Clicks div[aria-label="Publish"][role="button"]:not([aria-disabled])
// Retries up to 10x with 1s delay if Publish is disabled
```

**`relistItem()` — the core fill function:**

```javascript
async function relistItem(adData) {
  const allFields = [...adData.extractedData, ...catLocation]; // inputs + dropdowns (except Location)

  for (const { title, value } of allFields) {
    if (!value || value.trim() === "") continue;
    if (title === "Category") continue; // handled separately

    // 1. Try dropdown (combobox)
    const combobox = document.querySelector(`label[role="combobox"][aria-label="${title}"]`)
      || Array.from(document.querySelectorAll('label[role="combobox"]'))
           .find(l => l.textContent.trim().includes(title));
    if (combobox) {
      combobox.click(); // open dropdown
      await delay(500);
      // find matching option in [role="listbox"] [role="option"] and click
    }

    // 2. Try input/textarea
    const input = document.querySelector(`input[aria-label="${title}"]`)
      || document.querySelector(`textarea[aria-label="${title}"]`)
      || Array.from(document.querySelectorAll("label"))
           .find(l => l.textContent.trim().includes(title))
           ?.querySelector("input, textarea");
    if (input) {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
}
```

**`fillCategory()` — category-specific:**
- Clicks `label.x78zum5.xh8yej3[role="button"]` or `label.x78zum5.xh8yej3[role="combobox"]` where span text === "Category"
- Waits for `div[aria-label="Dropdown menu"]`
- Matches category by text using fuzzy `str1Instr2()` comparison
- Clicks matched item, re-clicks button to close

**`uploadImages()` — photo upload:**
```javascript
// Gets file input: input[type="file"][accept="image/*,image/heif,image/heic"]
// For each image in adData.extractImagesdata (max 10):
const response = await fetch(imageUrl); // re-downloads from FB CDN
const blob = await response.blob();
const file = new File([blob], `image_${Date.now()}.jpg`, { type: blob.type });
dataTransfer.items.add(file);
// After all images collected:
fileInput.files = dataTransfer.files;
fileInput.dispatchEvent(new Event("change", { bubbles: true }));
```

---

## 3. The `adData` Structure (stored in `chrome.storage.local.productData`)

```javascript
{
  adId: "123456789",        // listing_id from ?listing_id= URL param (string)
  type: "item",             // "item" | "vehicle" | "rental"
  relist: false,            // becomes true after relisting
  deleted: false,
  id: "base64title-price",  // generated composite ID for duplicate detection
  
  // Text inputs and textareas from the edit form
  extractedData: [
    { title: "Title", value: "iPhone 14 Pro" },
    { title: "Price", value: "800" },
    { title: "Description", value: "Great condition..." },
    { title: "SKU", value: "..." },
    { title: "Condition", value: "Used - Like New" },
    // vehicles also have: Mileage, Model
    // rentals also have: Price per month, Number of bedrooms, Number of bathrooms
  ],
  
  // Dropdown fields (comboboxes)
  getCategory: [
    { title: "Category", value: "Electronics" },
    { title: "Location", value: "Sydney NSW" },
    // vehicles: Year, Make, Type
    // rentals: Type (of rental)
  ],
  
  // Photo data — actual CDN URLs, not IDs
  extractImagesdata: [
    { imageUrl: "https://scontent.xx.fbcdn.net/v/...jpg" },
    // max 10 images
  ],
  
  // Checkbox states (delivery options, etc.)
  getCheckbox: [
    { text: "Shipping", checked: true },
    { text: "Local pickup", checked: false },
  ],
  
  // "Hide from friends" toggle state
  isCheckbox: {
    toggleState: "true" | "false" | null,
    hideFromFriendsText: "...",
    additionalInfo: "...",
  },
  
  // Original ad from selectedAds (includes FB listing URL, id, title, price)
  selected: {
    id: "...",
    title: "iPhone 14 Pro",
    price: "$800",
    // ...
  },
  listingId: "123456789",  // same as adId
}
```

---

## 4. `selectedAds` Structure (user's ad list in chrome.storage)

This is populated from the selling page scrape. Each ad:
```javascript
{
  id: "...",           // internal composite ID
  title: "...",        // from span.x1lliihq.x6ikm8r.x10wlt62.x1n2onr6
  price: "...",        // from span.x193iq5w... (price span)
  frequency: 1,        // repost interval number
  unit: "hour"|"day",  // repost interval unit
  lastRun: ISO_date,   // last repost timestamp (updated after each relist)
  timestamp: ISO_date, // when ad was first added
  instantly: false,    // if true, repost immediately (ignores schedule)
}
```

---

## 5. Scheduling Logic

`background.js` runs `checkScheduledReposts()` every 1 minute via `chrome.alarms`.

```javascript
const lastRun = new Date(repost.lastRun || repost.timestamp);
const frequencyMs = repost.unit === "hour"
  ? repost.frequency * 60 * 60 * 1000
  : repost.frequency * 24 * 60 * 60 * 1000;
const intervalsPassed = Math.floor((now - lastRun) / frequencyMs);
const shouldRun = intervalsPassed > 0;
```

Only **one ad is processed per alarm cycle** (`listing > 0 → return`).

---

## 6. Auth — None Needed

Because this is pure UI automation, no auth tokens are extracted or used. The extension piggybacks on the user's existing Facebook browser session. No `fb_dtsg`, no `actor_id`, no bearer token.

---

## 7. "Renew" Feature (separate from relist)

The extension also has a **"Renew in Marketplace"** flow (`renewFb()` in `content.js`) that uses Facebook's native bulk-renew:
1. Clicks "Manage listings" button on `/marketplace/you/selling`
2. Clicks "Select all"
3. Clicks "Actions"
4. Clicks "Renew in marketplace" from the actions menu
5. Confirms with `[aria-label="Renew"]` button

This is a lighter-weight alternative to delete+recreate — it refreshes listing dates without changing content. **It appears to be a separate feature from the scheduled repost, which uses delete+recreate.**

---

## 8. Key Takeaways for Our Implementation

1. **No GraphQL needed.** The entire repost is DOM automation. This is actually good — no reverse-engineering of API signatures required.

2. **The create URL pattern is simple:** `https://www.facebook.com/marketplace/create/item` (or `vehicle`, `rental`). Navigate there and fill the form.

3. **Type detection from first field title:**
   - First field = "Title" → `item`
   - First field = "Location" → `vehicle`
   - Otherwise → `rental`

4. **Field matching strategy:** aria-label first, then `label[textContent.includes(title)]` fallback. Dispatch `new Event("input", { bubbles: true })` after setting value — React/FB needs this.

5. **Category is special:** It uses a custom dropdown (`div[aria-label="Dropdown menu"]`), not a `<select>`. Must click to open, then click the matching option.

6. **Photos are re-uploaded, not reused.** Fetch the CDN URL, convert to Blob/File, set on `<input type="file">` via DataTransfer, dispatch `change` event.

7. **Publish button may be disabled initially.** Poll up to 10x with 1s delay waiting for `:not([aria-disabled="true"])`.

8. **Delete-before-create is the approach.** They commented out a "delete during scrape" path and the current code deletes first, then opens the create tab. Both tabs run concurrently in the background.

9. **Fuzzy title/price matching** (`createSlug()` / `dashSlug()`) is essential for finding the right ad card on the selling page — prices come back formatted (e.g. "$800" vs "800").

10. **Their delete-first approach risks timing issues** — if delete completes before the create tab loads the form. Our implementation should handle this with adequate waits or a different sequencing strategy.

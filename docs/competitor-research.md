# Competitor Research — FB Marketplace Delete & Create Selectors

## Sources Analysed

1. **GeorgiKeranov/facebook-marketplace-bot** (Python/Selenium) — removes & republishes from CSV
   - https://github.com/GeorgiKeranov/facebook-marketplace-bot
2. **privacyrepo/facebook-marketplace-autolisting-bot** (Python/Playwright) — same pattern
   - https://github.com/privacyrepo/facebook-marketplace-autolisting-bot

No public open-source Chrome extension was found. The Python/Selenium bots apply the same DOM structure since they drive a real Chrome browser — selectors are valid for extension content scripts too.

---

## CRITICAL FINDING — Delete Approach

**Competitors do NOT click the "..." / More Options button at all.**

They navigate *into* the listing first (opening it in a detail/edit panel), at which point a **direct Delete button** becomes visible with `aria-label="Delete"`. The "..." menu is bypassed entirely.

### Delete Flow (GeorgiKeranov — verified working)

```
Step 1 — Find listing by searching
  selector: input[placeholder="Search your listings"]
  action: clear, type listing title

Step 2 — Click the listing title to open it
  XPath: //span[text()="EXACT_TITLE"]
  This opens a right-panel or modal with the listing details

Step 3 — Click Delete directly (no "..." button needed)
  selector: div:not([role="gridcell"]) > div[aria-label="Delete"][tabindex="0"]
  The :not([role="gridcell"]) excludes grid cells, targeting the action button

Step 4 — Confirm deletion dialog
  primary:  div[aria-label="Delete listing"] div[aria-label="Delete"][tabindex="0"]
  fallback: div[aria-label="Delete Listing"] div[aria-label="Delete"][tabindex="0"]
  (FB uses both capitalizations — check both)

Step 5 — Wait for completion
  wait-invisible: div[aria-label="Your Listing"]
  (the modal/panel disappears when delete finishes)
```

### Why this matters for our extension

Our current approach tries to find `[aria-label="More options"]` / `[aria-label="More actions"]` on the listing *card* in the grid view. This is fragile — FB changes these aria-labels frequently, and the button may be SVG-only with no label.

**Recommended alternative for v1.9:**
Instead of clicking the "..." on the card, click INTO the listing card to open the detail panel, then use the direct `div[aria-label="Delete"]` selector. This matches what all known working bots do.

The detail panel is opened by clicking the listing's main anchor/card element. Once open, delete appears without needing the "..." menu.

---

## Create Listing Selectors

Cross-validated between both repos. These are reliable.

### Navigation
```
URL: https://www.facebook.com/marketplace/create/item
```

### Photo Upload
```css
input[accept="image/*,image/heif,image/heic"]
```
Both repos use this selector. It's the hidden file input. Trigger via `.click()` or `set_input_files()` equivalent.

### Form Fields (two equivalent selectors — use whichever matches first)

| Field | CSS (privacyrepo) | XPath (GeorgiKeranov) |
|-------|-------------------|----------------------|
| Title | `label[aria-label="Title"] input` | `//span[text()="Title"]/following-sibling::input[1]` |
| Price | `label[aria-label="Price"] input` | `//span[text()="Price"]/following-sibling::input[1]` |
| Description | `label[aria-label="Description"] textarea` | `//span[text()="Description"]/following-sibling::div/textarea` |
| Category | `label[aria-label="Category"]` | `//span[text()="Category"]` (click to expand) |
| Condition | `label[aria-label="Condition"]` | `//div/span[text()="Condition"]` (click to expand) |
| Location | `label[aria-label="Location"] input` | `//span[text()="Location"]/following-sibling::input[1]` |
| Tags | `label[aria-label="Product tags"] textarea` | — |
| SKU | `label[aria-label="SKU"] input` | — |

### Dropdowns
```css
/* After clicking Category or Condition to expand: */
div[role="option"]           /* individual option */
div[role="radio"] span       /* radio-style option */
ul[role="listbox"] li:first-child > div  /* location autocomplete — pick first result */
div[aria-label="Click to submit current value"]  /* submit a tag */
```

### Navigation & Publishing
```css
/* Next button (may appear once or twice) */
div[aria-label="Next"]
div [aria-label="Next"] > div   /* variant */

/* Publish button — :not([aria-disabled]) ensures it's active */
div[aria-label="Publish"]:not([aria-disabled])
```

### Post-publish — handle "Leave Page" dialog
```xpath
//div[@tabindex="0"] //span[text()="Leave Page"]
//span[text()="Close"]   /* fallback */
```

---

## What Our Extension Currently Does vs. What Competitors Do

| Step | Our v1.8.0 approach | Competitor approach |
|------|---------------------|---------------------|
| Find listing | `findListingCard()` — match card in DOM grid | Search input `input[placeholder="Search your listings"]` + click title |
| Open delete menu | Click "..." moreBtn (7 strategies, still fragile) | **No "..." needed** — click INTO listing to open detail panel |
| Delete button | `[aria-label="Delete listing"], [role="menuitem"]...` | `div:not([role="gridcell"]) > div[aria-label="Delete"][tabindex="0"]` |
| Confirm | `[role="dialog"] [aria-label="Delete"]` | `div[aria-label="Delete listing"] div[aria-label="Delete"][tabindex="0"]` |
| Create form - title | `nativeSetInput` on current title input | `label[aria-label="Title"] input` |
| Create form - price | `nativeSetInput` on price input | `label[aria-label="Price"] input` |
| Photos | DragEvent simulation | `input[accept="image/*,image/heif,image/heic"]` file input directly |

### Key takeaways

1. **Delete**: Switch to click-into-listing approach. The "..." button hunt is not how any working tool does it.
2. **Photo upload**: Try the direct file input `input[accept="image/*,image/heif,image/heic"]` — simpler than DragEvent simulation.
3. **Form fill**: `label[aria-label="X"] input` style selectors are more stable than relying on placeholder text or positional queries.
4. **Search to find listing**: `input[placeholder="Search your listings"]` is a reliable anchor point for navigating to the right listing.

---

## Recommended v1.9 Delete Flow Rewrite

```javascript
async function deleteListing(listing) {
  // 1. Navigate to selling page (already there)
  // 2. Find the search input and search for this listing
  const searchInput = await waitForElement('input[placeholder="Search your listings"]', 5000);
  if (!searchInput) { /* fallback to card-click approach */ }
  
  nativeSetInput(searchInput, listing.title);
  await sleep(1000);
  
  // 3. Click the listing title to open detail panel
  // Try exact match first, then prefix
  const titleSpan = [...document.querySelectorAll('span')].find(s => s.textContent.trim() === listing.title);
  if (!titleSpan) { /* skip */ }
  titleSpan.click();
  await sleep(1500);
  
  // 4. Click direct Delete button (no "..." menu)
  const deleteBtn = await waitForElement(
    'div:not([role="gridcell"]) > div[aria-label="Delete"][tabindex="0"]',
    5000
  );
  if (!deleteBtn) { /* listing not open, skip */ }
  deleteBtn.click();
  await sleep(1000);
  
  // 5. Confirm dialog
  let confirmBtn = await waitForElement(
    'div[aria-label="Delete listing"] div[aria-label="Delete"][tabindex="0"]',
    5000
  );
  if (!confirmBtn) {
    confirmBtn = await waitForElement(
      'div[aria-label="Delete Listing"] div[aria-label="Delete"][tabindex="0"]',
      3000
    );
  }
  if (confirmBtn) confirmBtn.click();
  
  // 6. Wait for panel to close
  await waitForElementToDisappear('div[aria-label="Your Listing"]', 8000);
}
```

---

## Create Form — Recommended Selector Updates

Replace current form-fill selectors with:
```javascript
// Photo upload — direct file input (no drag/drop simulation needed)
const photoInput = document.querySelector('input[accept="image/*,image/heif,image/heic"]');

// Title
const titleInput = document.querySelector('label[aria-label="Title"] input');

// Price  
const priceInput = document.querySelector('label[aria-label="Price"] input');

// Description
const descInput = document.querySelector('label[aria-label="Description"] textarea');

// Category (click to expand, then click option by text)
const catEl = document.querySelector('label[aria-label="Category"]');

// Condition (click to expand, then click option by text)
const condEl = document.querySelector('label[aria-label="Condition"]');

// Location
const locInput = document.querySelector('label[aria-label="Location"] input');

// Tags
const tagsInput = document.querySelector('label[aria-label="Product tags"] textarea');

// Next
const nextBtn = document.querySelector('div[aria-label="Next"]');

// Publish
const publishBtn = document.querySelector('div[aria-label="Publish"]:not([aria-disabled])');
```

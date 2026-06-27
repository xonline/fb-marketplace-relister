# Manifest Recommendations — FB Marketplace Relister

These are issues found in `manifest.json` that should be addressed before Chrome Web Store submission. **No changes have been made to manifest.json** — apply these manually.

---

## Critical (Will Cause Rejection)

### 1. Missing `icons` field

**Current:** The manifest has no `icons` field.
**Problem:** The Chrome Web Store requires a 128×128 icon. Without an `icons` declaration, the store will use a default grey puzzle piece — likely a rejection or a very poor first impression.
**Fix:** Create an `icons/` directory with four PNG files, then add to `manifest.json`:

```json
"icons": {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png"
}
```

Also update the `action` block to reference the icons:
```json
"action": {
  "default_popup": "popup.html",
  "default_title": "FB Marketplace Relister",
  "default_icon": {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png"
  }
}
```

---

## Moderate (May Cause Rejection or Poor User Experience)

### 2. `description` field is too technical for store presentation

**Current:** `"Relists Facebook Marketplace items via direct GraphQL API — carries description, photos, category, price, location & buyer-visible item condition. No UI automation."`

**Problem:** While accurate, "direct GraphQL API" and "No UI automation" are developer-speak. Chrome uses this manifest description in some contexts. More importantly, reviewers may read it and it should read professionally.

**Recommended replacement:**
```
"description": "Relist your Facebook Marketplace listings in one click — refreshes price, photos, location & condition. Bulk relist, auto-schedule & optional AI enhance."
```
(132 chars — at the store short description limit, which also applies to the manifest description field.)

---

## Low (Best Practice / Future-Proofing)

### 3. Duplicate CDN host permission

**Current:** Both `"https://*.fbcdn.net/*"` and `"https://*.xx.fbcdn.net/*"` are listed.

**Assessment:** `*.xx.fbcdn.net` is a subdomain of `*.fbcdn.net`, so `"https://*.fbcdn.net/*"` already covers it. However, keeping both explicit entries is not harmful and makes the intent visible to reviewers. This is optional cleanup — no change required for submission.

---

### 4. No `web_accessible_resources` declared

**Current:** Not present in manifest.
**Assessment:** If the extension does not serve any resources (images, scripts) to web pages via `chrome.runtime.getURL(...)`, this is correct and no fix needed. Based on the architecture (content.js injects a button, no external resource fetches), this appears intentional. Verify before submission.

---

### 5. `options_page` vs `options_ui`

**Current:** `"options_page": "options.html"` — opens options in a new tab.
**Alternative:** `"options_ui": { "page": "options.html", "open_in_tab": true }` — same behaviour but is the MV3-preferred declaration style.
**Assessment:** `options_page` still works in MV3. This is cosmetic — no functional impact. Low priority.

---

## Summary Table

| Issue | Severity | Action |
|---|---|---|
| Missing `icons` field and icon PNG files | CRITICAL | Must fix before submission |
| `description` field too technical | MODERATE | Recommended to update |
| Duplicate fbcdn host permission | LOW | Optional cleanup |
| `web_accessible_resources` absent | LOW | Verify it's intentionally absent |
| `options_page` vs `options_ui` | LOW | Optional modernisation |

# Chrome Web Store Submission Checklist — FB Marketplace Relister

Step-by-step ordered process. Complete prerequisites before moving to upload.

---

## Phase 0 — One-Time Prerequisites

- [ ] **Register as a Chrome Web Store developer** (one-time, $5 USD)
  - Go to [https://chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole)
  - Sign in with the Google account you want associated with the developer account
  - Pay the $5 one-time registration fee (Google Pay / credit card)
  - This unlocks the ability to publish unlimited extensions
  - The registered account name will appear as the publisher on all your extensions

- [ ] **Host the privacy policy publicly**
  - Convert `store/privacy-policy.md` to an HTML page or publish via GitHub Pages, your site, or a Notion public page
  - The URL must be publicly accessible (no login required) and stable
  - Recommended: `https://x-online.com.au/extensions/fb-marketplace-relister/privacy` or GitHub Pages equivalent
  - Note the URL — you will paste it into two places: the store listing form and the Privacy Practices tab

---

## Phase 1 — Pre-Upload Fixes

Complete these before zipping. Do NOT skip.

- [ ] **Create icon files** — the manifest currently has no `icons` field and no icon PNG files exist
  - Design and export: `icons/icon-16.png`, `icons/icon-32.png`, `icons/icon-48.png`, `icons/icon-128.png`
  - See `assets-plan.md` for design direction and pixel specs

- [ ] **Add `icons` field to manifest.json**
  ```json
  "icons": {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
  ```

- [ ] **Click-test the full popup + bulk + schedule UI** in a real Chrome browser (loaded unpacked)
  - Per NOTES.md §6: "the popup UI itself is not yet click-tested in a live browser — do one manual click-through before publishing"
  - Test: single relist, bulk select, schedule toggle, AI enhance toggle (with a real Gemini key)

- [ ] **Review the manifest `description` field**
  - Current: `"Relists Facebook Marketplace items via direct GraphQL API — carries description, photos, category, price, location & buyer-visible item condition. No UI automation."`
  - This is the text Chrome uses as the manifest description. It's accurate but technical — consider a user-friendlier version that matches store listing copy. Max 132 characters.

---

## Phase 2 — Package the Extension

- [ ] **Exclude development/test files from the zip**
  - Exclude: `utils.js` (NOTES.md §9 confirms it is unused), `*.bak` files, `docs/`, `.git/`, `.code-review-graph/`, old `*.zip` files, `NOTES.md`
  - Include only: `manifest.json`, `background.js`, `content.js`, `popup.html`, `popup.js`, `options.html`, `options.js`, `ai.js`, `icons/` directory

- [ ] **Create the submission zip**
  ```bash
  cd /home/ubuntu/projects/fb-marketplace-relister
  zip -r fb-marketplace-relister-v3.6.3-store.zip \
    manifest.json background.js content.js \
    popup.html popup.js options.html options.js ai.js \
    icons/
  ```

- [ ] **Verify zip contents** — unzip to a temp directory and load it as an unpacked extension to confirm it works cleanly

---

## Phase 3 — Chrome Developer Dashboard

### 3.1 Create New Item

- [ ] Go to [https://chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole)
- [ ] Click **"New item"**
- [ ] Upload your `fb-marketplace-relister-v3.6.3-store.zip`
- [ ] Dashboard will parse the manifest and pre-fill the name and version

### 3.2 Store Listing Tab

- [ ] **Detailed description** — paste from `store/store-listing.md` (the full detailed description block); replace `[link to hosted policy]` placeholder with your real URL
- [ ] **Category** — select `Productivity`
- [ ] **Language** — `English (en)`
- [ ] **Store icon** — upload `icons/icon-128.png`
- [ ] **Screenshots** — upload 1–5 screenshots at 1280×800 px (see `assets-plan.md` for ideas)
- [ ] **Small promotional tile** — upload the 440×280 px promotional image
- [ ] **Marquee promotional tile** — upload 1400×560 px image (optional but recommended)
- [ ] **Privacy policy URL** — paste the public URL to your hosted privacy policy

### 3.3 Privacy Practices Tab

- [ ] Answer the data collection questions per `data-safety.md`
- [ ] Certify that user data is NOT sold
- [ ] Certify data is NOT used for unrelated purposes
- [ ] Paste your privacy policy URL again in the designated field
- [ ] Complete the **single purpose** declaration:
  > "Relist the user's own Facebook Marketplace listings to refresh their position in search results."

### 3.4 Distribution Tab

- [ ] **Visibility** — select `Public` (or `Unlisted` for a soft launch)
- [ ] **Regions** — All regions, or restrict if desired (English-language product → at minimum AU, US, UK, CA)
- [ ] **Pricing** — Free (or set up in-app payments if monetising in future)

### 3.5 Permissions Justification (if prompted)

Chrome review may ask you to justify sensitive permissions. Use the text from `permissions-justification.md` for each permission. Keep responses concise:

- `tabs` — "Needed to locate the user's Facebook Marketplace selling tab and open listing pages for data extraction."
- `scripting` — "Required to inject authentication token reads and GraphQL API calls into the user's logged-in facebook.com tab. Facebook's API rejects requests from extension background workers; page-context injection is the only way to authenticate."
- `*://*.facebook.com/*` — "All core relist operations (reading listing data, creating/editing/deleting listings via GraphQL) target Facebook's API endpoints across its subdomains."
- `https://upload.facebook.com/*` — "Re-uploading listing photos to obtain fresh photo IDs for the new listing."
- `https://*.fbcdn.net/*` — "Fetching existing listing photo binaries from Facebook's CDN for re-upload."
- `https://generativelanguage.googleapis.com/*` — "Optional AI description enhancement: sends listing text to Google Gemini using the user's own API key, only when this opt-in feature is enabled."

---

## Phase 4 — Submit for Review

- [ ] **Save** the listing (all tabs must be saved / green)
- [ ] Click **"Submit for review"**
- [ ] You will see a confirmation that the item is "Pending review"

---

## Phase 5 — Review Timeline & Follow-Up

**Typical timelines (as of 2026):**

- Simple extensions with clean MV3 code and narrow permissions: **a few hours to 3 days**
- Extensions with `scripting` + broad host permissions (like this one): likely **3–7 days** (manual review expected)
- If flagged or needing clarification: **up to 3 weeks**
- If pending more than 3 weeks with no update: contact Chrome Developer Support

**After submission:**

- [ ] Check the Developer Dashboard for status updates
- [ ] If **additional information is requested** by reviewers, respond promptly with justifications from `permissions-justification.md`
- [ ] If **rejected**, the rejection email will specify the policy violation; address it and resubmit
- [ ] Once **approved**, you have up to **30 days** to publish — click "Publish" in the dashboard or it reverts to draft

---

## Phase 6 — Post-Publish

- [ ] Verify the extension is live at `https://chromewebstore.google.com/detail/[extension-id]`
- [ ] Test installing from the store (use a different Chrome profile)
- [ ] Update `NOTES.md` with the store URL and extension ID
- [ ] Set up a support/contact channel (your privacy policy lists `poy@x-online.com.au`)

---

## Common Rejection Reasons to Pre-empt

| Rejection Reason | Pre-empted? |
|---|---|
| Missing privacy policy | Yes — `store/privacy-policy.md` covers all required points |
| Vague permissions justification | Yes — `permissions-justification.md` has per-permission text |
| Extension name implies affiliation with Meta/Facebook | Moderate risk — "FB Marketplace" uses "FB" abbreviation. Consider "Marketplace Relister for Facebook" as a fallback if rejected on naming |
| `scripting` without clear justification | Yes — justification explains the FB API architecture requirement |
| Icons missing from manifest | Address in Phase 1 before submitting |
| Remote code policy violation | No remote code — stated explicitly in permissions justification |
| Single purpose unclear | Declared explicitly in data-safety.md and permissions justification |

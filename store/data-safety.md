# Data Safety / Privacy Practices — Chrome Web Store Form Answers

This document contains the answers for the **Privacy Practices** tab in the Chrome Web Store Developer Dashboard for **v3.7.4**. Complete each section exactly as documented below.

---

## Section 1: Data Collection Declaration

*The dashboard presents a fixed list of user data categories. Check the ones that apply.*

### Does this extension collect or transmit any user data?

**Answer: Yes**

The extension transmits listing content to our server when the optional AI enhancement feature is used (Provided AI mode). It also transmits listing content to Google Gemini directly in BYOK mode. The extension transmits an anonymous license UUID to our server to verify Pro subscription status. Payment is handled entirely by Stripe. The landing page uses GA4 analytics.

---

### Data Categories — Check/Select as Follows:

| Category | Collected? | Notes |
|---|---|---|
| **Personally identifiable information** (name, address, email, age, ID) | NO | The extension does not collect PII. Listing data (title, description, price, etc.) is not PII. |
| **Health information** | NO | |
| **Financial and payment information** | NO (by the extension) | Payments are processed entirely by Stripe. The extension sends an anonymous license UUID (generated locally) to `relist.nowoly.com` to verify Pro subscription status. No card data ever reaches our code. The UUID is not linked to the user's name or email. |
| **Authentication information** (passwords, credentials) | NO | The extension uses the user's existing Facebook session via `credentials: 'include'` — it does not read, store, or transmit login credentials. |
| **Personal communications** (emails, texts, messages) | NO | |
| **Location** | NO (indirect) | Location is read from listing data and passed to Facebook's own API to reproduce the listing. Not stored or sent to any server we operate. |
| **Web history** | NO | |
| **User activity** (e.g. mouse clicks, scroll, keystrokes) | NO | |
| **Website content** (text, images from pages) | YES | The extension reads listing content (title, description, photos, price, location) from Facebook Marketplace pages — solely to relist that content. When the optional AI feature is enabled, listing title, price, description, and optionally a photo are sent to `relist.nowoly.com/api/ai` (Provided AI mode) or directly to `generativelanguage.googleapis.com` (BYOK mode) to generate improved copy. |

---

## Section 2: Data Use Certification

### Is any of the data collected sold to third parties?

**NO.** We do not sell any data. Listing content sent for AI enhancement is processed in memory and discarded after the response is returned.

---

### Is any of the data used or transferred for purposes unrelated to the extension's single purpose?

**NO.** Listing data is used only to: (a) perform the relist operation the user initiated, or (b) generate AI-improved copy when the user has enabled that feature. It is not used for advertising, profiling, or any secondary purpose.

---

### Is any of the data used or transferred to determine creditworthiness or for lending purposes?

**NO.**

---

### Is any data transmitted to third parties?

**Conditional YES — Google (Gemini) and Stripe only.**

**AI Enhancement (Provided AI mode — Pro):**
Listing title, price, description, and optionally a photo are transmitted to `relist.nowoly.com/api/ai`, which forwards to the Google Gemini API. This is opt-in only (disabled by default). Data is processed in memory and not stored. Disclosed in the privacy policy and store listing.

**AI Enhancement (BYOK mode):**
If the user provides their own Google Gemini API key, listing content is transmitted directly from their browser to `generativelanguage.googleapis.com`. Uses the user's own API key, not ours. Opt-in only.

**Pro Subscription Verification:**
The extension generates an anonymous license UUID (random identifier, stored in `chrome.storage.local`) and transmits it to `relist.nowoly.com` to verify Pro subscription status. This UUID is not linked to the user's name or email.

**Payments:**
Subscription payments are processed entirely by Stripe. No card data reaches the extension or our server. Stripe handles all payment data.

No other third-party data transmission occurs.

---

### Is data collected encrypted in transit?

**YES.** All communications — to Facebook's API, to `relist.nowoly.com`, to Google Gemini, and to Stripe — use HTTPS (TLS). All host permissions in the manifest specify `https://` explicitly.

---

### Does the extension store any user data?

**YES (locally on device only).** User preferences (schedule interval, AI toggle, subscription status) are stored in `chrome.storage.local` on the user's device. This data never leaves the device via our servers.

Listing content transmitted for AI enhancement is **not stored** — it is processed in memory and discarded after the API response.

---

### Does the extension handle sensitive categories of data?

**NO.** The listing data handled (title, description, photos, price, condition) is not sensitive in the categories defined by Chrome Web Store policy (health, financial, authentication, communications, etc.).

---

## Section 3: Privacy Policy URL

**Required field:** Use the publicly hosted URL:

**`https://relist.nowoly.com/privacy.html`**

The full privacy policy text is in `store/privacy-policy.md` and rendered at the URL above.

---

## Section 4: Single Purpose Declaration

> **"Relist the user's own Facebook Marketplace listings to refresh their position in search results."**

---

## Additional Notes for Reviewer

- The extension does **not** use the Chrome `cookies` API, `webRequest` API, or `history` API.
- The extension does **not** inject ads or collect analytics/telemetry.
- **New in v3.7.4:** The extension contacts `relist.nowoly.com/api/ai` when the user enables Provided AI mode (Pro subscribers only). This is disclosed in the privacy policy, store listing, and the Options page UI. Listing data is transmitted over HTTPS, processed in memory, and not retained.
- **New in v3.7.4:** Subscription payments are handled by Stripe. The extension contacts `relist.nowoly.com` to verify subscription status via an anonymous license UUID (not linked to name or email).
- All injected code (`chrome.scripting.executeScript`) is authored within the extension package; no remote scripts are fetched or executed.
- The landing page (`relist.nowoly.com`) uses Google Analytics 4. The extension itself contains no analytics code.

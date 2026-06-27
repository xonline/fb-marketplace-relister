# Privacy Policy — Marketplace Relister

**Last updated:** 2026-06-27
**Developer:** Poy (x-online)
**Contact:** poy@x-online.com.au

---

## 1. Overview

Marketplace Relister ("the Extension") is a Chrome browser extension that allows you to relist your own Facebook Marketplace listings. This Privacy Policy explains what data the Extension accesses, how it is used, and your choices. It covers both the Extension and the landing page at `relist.nowoly.com`.

**Short answer:** Almost everything stays on your device. The only data that ever leaves your browser is when you use the optional AI listing enhancement — your listing text and optionally a photo are sent to our server (`relist.nowoly.com`), which forwards them to Google Gemini to generate copy. We do not store that data. Pro subscriptions are handled entirely by Stripe — we never see your card details. This landing page uses Google Analytics 4; the browser extension itself does not.

---

## 2. Data We Access

### 2.1 Facebook Marketplace Listing Data

When you use the Extension, it reads the following fields from your Facebook Marketplace listings:

- Listing title
- Listing description
- Photos (as binary image data to re-upload)
- Category
- Price and currency
- Location
- Item condition (e.g. Used – Good)

**This data is accessed solely to perform the relist action you requested.** It is read from the Facebook page currently open in your browser, processed in memory within the Extension, and submitted back to Facebook's API to create a refreshed listing. It is not stored beyond the immediate operation and is not used for any other purpose.

The only exception is when you use the optional AI listing enhancement feature — see Section 3.

### 2.2 Extension Settings

The Extension stores your preferences (e.g. scheduled relist interval, AI toggle, Pro subscription status) in Chrome's local extension storage (`chrome.storage.local`). This data:

- Stays on your device only.
- Is never transmitted to any server we operate.
- Is never shared with third parties.
- Can be cleared at any time via the Extension's Options page or via `chrome://extensions`.

---

## 3. Optional AI Listing Enhancement

The Extension includes an **optional, opt-in** feature that uses Google's Gemini AI to improve your listing title and description. This feature is **disabled by default**.

### 3.1 Provided AI (Pro — included with subscription)

When this mode is active and you relist a listing:

- Your listing **title**, **price**, **description**, and optionally one **listing photo** are sent over HTTPS to our server at `relist.nowoly.com/api/ai`.
- Our server forwards this data to the **Google Gemini API** to generate improved listing copy, then returns the result to your browser.
- **We do not store your listing content beyond the duration of the API request.** The data is processed in memory and discarded once the response is returned.
- We do not sell, share, or use your listing data for any purpose other than generating the AI response you requested.
- All transmission is encrypted in transit via HTTPS (TLS).
- Google's handling of data is subject to [Google's Privacy Policy](https://policies.google.com/privacy) and [Google AI Terms of Service](https://ai.google.dev/terms).

### 3.2 Bring-Your-Own-Key (BYOK) Mode

Alternatively, you may provide your own Google Gemini API key. In this mode:

- Your listing title, description, and optionally a photo are sent **directly from your browser** to the Google Gemini API (`generativelanguage.googleapis.com`).
- Your API key is stored in `chrome.storage.local` on your device and sent directly to Google — it never passes through our server.
- We never see, store, or transmit your API key.
- Subject to [Google's Privacy Policy](https://policies.google.com/privacy) and [Google AI Terms of Service](https://ai.google.dev/terms).

**If you do not enable AI enhancement, no listing data is sent to our server or to Google.**

---

## 4. Permissions Used and Why

| Permission | Purpose |
|---|---|
| `storage` | Saves your settings (schedule, AI toggle, subscription status) locally in Chrome's extension storage. |
| `tabs` | Opens and identifies the Facebook Marketplace selling page needed to perform relist operations. |
| `scripting` | Injects code into your active Facebook tab to read authentication tokens and perform GraphQL API calls in page context — required because Facebook's API rejects requests from the extension's background worker. |
| `activeTab` | Reads content from the currently active Facebook tab when you initiate a relist. |
| `alarms` | Powers the scheduled auto-relist feature — fires background tasks at the interval you configure. |
| `*://*.facebook.com/*` | Read page tokens and submit relist GraphQL mutations to Facebook's internal API. |
| `https://upload.facebook.com/*` | Re-upload listing photos so they receive fresh photo IDs for the new listing. |
| `https://*.fbcdn.net/*`, `https://*.xx.fbcdn.net/*` | Fetch listing photo data from Facebook's CDN for re-uploading. |
| `https://generativelanguage.googleapis.com/*` | Send listing content directly to Google Gemini (BYOK mode only — requires your own API key). |
| `https://relist.nowoly.com/*` | Send listing content to our AI relay endpoint (Provided AI mode for Pro subscribers) and verify Pro subscription status via your anonymous license identifier. |

---

## 5. Payments via Stripe

Pro subscriptions are processed entirely by **Stripe**.

- Payment is handled entirely by Stripe — we never receive, see, or store your credit card or payment details.
- We store only an anonymous license identifier (a random UUID v4 generated by the extension) linked to your subscription status (active/inactive). This allows the extension to verify your Pro status by contacting `relist.nowoly.com`. The license identifier is not linked to your name or email.
- Your payment data is governed by [Stripe's Privacy Policy](https://stripe.com/privacy).
- To cancel your subscription, use the Stripe billing portal link from your purchase receipt, or contact us via the feedback form in the extension.

---

## 6. Website Analytics (Landing Page)

This landing page (`relist.nowoly.com`) uses **Google Analytics 4 (GA4)** to collect anonymised usage data — page views, referral sources, and general device/browser information.

- GA4 sets cookies in your browser to track sessions across page views.
- Data is anonymised and aggregated; we do not use it to identify individual visitors.
- Analytics is on the **landing page only** — the Chrome extension does not contain any analytics, tracking, or telemetry code.
- You can opt out via [Google Analytics Opt-out Browser Add-on](https://tools.google.com/dlpage/gaoptout).

---

## 7. Data We Do Not Collect

We explicitly do **not**:

- Store listing content, photos, or any Facebook data — AI relay requests are processed in memory and discarded.
- Sell, rent, or share any data with advertisers or third parties.
- Track which listings you relist or how often you use the Extension.
- Collect analytics or telemetry from within the Extension itself.
- Use remote code execution or load scripts from external servers into the Extension.
- Store your credit card or payment information — payments are handled entirely by Stripe.

---

## 8. Local Processing

All core Extension logic (reading listings, performing relists, scheduling) runs locally inside your Chrome browser. The Extension communicates directly with Facebook's own API on your behalf using your existing Facebook session.

The only server-side component is the optional AI relay (`relist.nowoly.com/api/ai`), used only when you enable Provided AI mode. That endpoint processes requests in memory without logging or storing listing content.

---

## 9. Children's Privacy

This Extension is not directed at children under 13 and we do not knowingly collect personal information from children.

---

## 10. Changes to This Policy

We may update this Privacy Policy from time to time. The "Last updated" date at the top will reflect any changes. Continued use of the Extension after changes constitutes acceptance of the updated policy. For significant changes, we will update the Extension's store listing.

---

## 11. Contact

If you have questions about this Privacy Policy, please contact:

**Email:** poy@x-online.com.au

---

## 12. Disclaimer

This Extension is an independent tool created by a third-party developer. It is not affiliated with, endorsed by, or in any way officially connected with Meta Platforms, Inc. or Facebook. "Facebook" and "Marketplace" are trademarks of Meta Platforms, Inc.

---

*This policy is published at https://relist.nowoly.com/privacy.html and linked in the Chrome Web Store listing as required by Google's Developer Program Policies.*

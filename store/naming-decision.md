# Naming Decision — Using "Facebook" / "Marketplace" in the Extension Title

*Research date: June 2026.*

---

## 1. What the Rules Actually Say

### Chrome Web Store Policy

Chrome's [Impersonation & Intellectual Property policy](https://developer.chrome.com/docs/webstore/program-policies/impersonation-and-intellectual-property) states:

> "Don't infringe on the intellectual property rights of others, including patent, trademark, trade secret, copyright, and other proprietary rights."
> "Don't represent that your product is authorized by, endorsed by, or produced by another company or organization, if that is not the case."

Chrome's [branding guidelines](https://developer.chrome.com/docs/webstore/branding) only prohibit using **Google** trademarks without permission — they do not issue rules about Meta/Facebook trademarks specifically.

Chrome does NOT publish an explicit allowlist or blocklist for third-party brand names in extension titles. Enforcement is handled case-by-case via IP complaint.

### Meta's Trademark Policy

Meta's [Brand Resource Center](https://www.meta.com/brand/resources/meta/our-trademarks/) states:

> "You may not use or register, or otherwise claim rights in any Meta trademark, including as or as part of any trademark, service mark, company name, trade name, username or domain registration."

Meta's [open source trademark policy](https://opensource.fb.com/legal/trademark/) allows nominative fair use — identifying what a tool *works with* — provided:
1. The use cannot be readily identified without using the trademark
2. Only the minimum necessary amount is used
3. Use does not suggest sponsorship, endorsement, or affiliation

---

## 2. What Competitors Are Actually Doing (and Getting Away With)

From live Chrome Web Store data as of June 2026:

| Extension Name | Status | Users |
|---------------|--------|-------|
| Delete & Relist **Facebook Marketplace** — Relistify | Live | 603 |
| AutoListing – **Facebook Marketplace** Relister | Live | 33 |
| **Facebook Marketplace** Automator FMA | Live | 347 |
| **Facebook Marketplace** AI Manager, Reposter, Relister | Live | 29 |
| AutoList for **Facebook Marketplace** - Bulk Lister | Live | 237 |
| **FB** Marketplace Pro | Live | 17 |

All six extensions use "Facebook Marketplace" (or "FB Marketplace") in their title and remain live on the store. The market leader (Relistify, 603 users) has used "Facebook Marketplace" in its title for multiple years without removal.

**Practical conclusion:** Meta does not appear to be actively pursuing extensions that use "Facebook" in their name in a descriptive/nominative way. This is consistent with nominative fair use doctrine — using a trademark to accurately describe what a product *works with*, not to imply ownership or endorsement.

However, Meta legally **could** file a complaint at any time, and Chrome would likely act on it. This is a small but non-zero risk.

---

## 3. Risk Assessment

| Name Strategy | Discoverability | Trademark Risk | Notes |
|---------------|----------------|----------------|-------|
| Include "Facebook Marketplace" in title | High | Low-Medium | Multiple competitors live with this approach; nominative use is defensible with a clear disclaimer |
| Use "FB Marketplace" in title | High | Low | "FB" is an abbreviation, not the registered trademark — lower risk. FB Marketplace Pro is live. |
| "for Facebook Marketplace" sub-title pattern | High | Low | The "for [Brand]" framing is the clearest nominative use pattern; implies compatibility, not affiliation |
| Avoid "Facebook" entirely | Medium | Zero | CWS search is driven by description keywords, not just name — Marketplace Listings Reposter has 993 users this way |

**Verdict:** The "for Facebook Marketplace" pattern (or using "Facebook Marketplace" with a disclaimer) is defensible nominative use. The existing competitors prove Chrome's review team accepts these names. Use it, but always include the disclaimer.

---

## 4. Recommended Extension Name

### PRIMARY NAME (recommended)

**"Relist for Facebook Marketplace"**

- Grammatically frames it as a *tool for the platform*, not an official product of Meta
- Matches the "for [Platform]" pattern used by many Chrome utilities (e.g. "Password Manager for Chrome", "Downloader for Instagram™")
- Includes "Facebook Marketplace" for discoverability in CWS search
- Different enough from competitors ("Delete & Relist Facebook Marketplace") to stand alone
- Clean, benefit-first: the word "Relist" is the action the user wants

### FALLBACK 1

**"FB Marketplace Relister"**

- Uses the "FB" abbreviation (not the registered "Facebook" trademark)
- Mirrors the existing "FB Marketplace Pro" extension that Chrome accepts
- Shorter — fits well as a display name in the browser toolbar tooltip
- Slightly lower discoverability than the full "Facebook" spelling

### FALLBACK 2 (safest — no trademark use at all)

**"Marketplace Relister Pro"**

- Zero trademark risk
- Still contains "Marketplace" and "Relister" — both strong CWS search keywords
- The word "Facebook" in the description body handles the SEO
- Use if: (a) Chrome rejects the primary name during review, or (b) Meta sends a complaint

---

## 5. Required Non-Affiliation Disclaimer

This wording MUST appear in the detailed description (already included in `store-listing.md`), the options/about page in the extension, and the privacy policy footer.

**Standard form (use as-is):**

> "Relist for Facebook Marketplace is an independent browser extension. It is not affiliated with, endorsed by, or produced by Meta Platforms, Inc. Facebook and Facebook Marketplace are trademarks of Meta Platforms, Inc."

**Condensed form (for space-constrained UI elements):**

> "Not affiliated with Meta Platforms, Inc. Facebook™ is a trademark of Meta Platforms, Inc."

---

## 6. Trademark Attribution in the Description

If using "Facebook" or "Facebook Marketplace" in the title, add this line to the detailed description near the disclaimer:

> "Facebook® and Facebook Marketplace® are registered trademarks of Meta Platforms, Inc."

This signals to Chrome reviewers (and to Meta) that the developer is aware of the trademark status and is not claiming ownership — a sign of good faith nominative use.

---

## 7. What to Do If Challenged

If Chrome's review team flags the name, switch to **Fallback 1** (FB Marketplace Relister) during the appeal. If Meta sends a legal complaint, switch to **Fallback 2** (Marketplace Relister Pro) — the description keywords maintain CWS discoverability regardless of the title.

Never add "Official" or "by Meta" or any language implying Meta endorses the extension.

---

*Sources:*
- https://developer.chrome.com/docs/webstore/program-policies/impersonation-and-intellectual-property
- https://developer.chrome.com/docs/webstore/branding
- https://www.meta.com/brand/resources/meta/our-trademarks/
- https://opensource.fb.com/legal/trademark/
- https://groups.google.com/a/chromium.org/g/chromium-extensions/c/WJ3OExNJJbA (Chromium dev forum thread on trademark complaints)
- Live Chrome Web Store listings (June 2026)

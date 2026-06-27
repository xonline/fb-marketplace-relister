# Store Assets Plan — FB Marketplace Relister

---

## Required Image Assets (Chrome Web Store 2026)

| Asset | Dimensions | Format | Required? | Notes |
|---|---|---|---|---|
| **Extension icon** | 128 × 128 px | PNG | REQUIRED | Actual artwork: 96×96 px centred with 16 px transparent padding all sides |
| **Small promotional tile** | 440 × 280 px | PNG or JPEG | REQUIRED | Displayed on the store homepage, category pages, and search results |
| **Marquee promotional tile** | 1400 × 560 px | PNG or JPEG | Optional | Shown as a hero banner if Chrome editors feature the extension — worth creating |
| **Screenshots** | 1280 × 800 px (preferred) OR 640 × 400 px | PNG or JPEG | REQUIRED (min 1, max 5) | Full bleed, square corners, no device frame imposed by Chrome — frame them yourself if desired |

---

## Existing Icon Files — Status

Checked the project directory (`/home/ubuntu/projects/fb-marketplace-relister/`):

**No icon files found.** The project contains no `.png`, `.jpg`, `.svg`, or `.ico` files. The `manifest.json` does not declare an `icons` field.

### What is Missing

| Asset | Status |
|---|---|
| `icon-16.png` (16×16) | MISSING — needed for favicon/tab bar display |
| `icon-32.png` (32×32) | MISSING — recommended for Windows |
| `icon-48.png` (48×48) | MISSING — used on `chrome://extensions` management page |
| `icon-128.png` (128×128) | MISSING — **required for Web Store submission** |
| `icons` field in `manifest.json` | MISSING — manifest has no `icons` declaration |
| Small promo tile (440×280) | MISSING — must be created |
| Screenshots (1280×800) | MISSING — must be taken/created |
| Marquee tile (1400×560) | MISSING — optional but recommended |

---

## Manifest Icon Fix Required

The manifest currently has no `icons` field. Before submission, add:

```json
"icons": {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png"
}
```

And create an `icons/` directory with the four PNG files. See `manifest-recommendations.md` for the full list.

---

## Icon Design Direction

The icon should be immediately recognisable as a "marketplace refresh/relist" concept. Suggestions:

**Option A — Circular Arrows + Bag:**
A shopping bag or tag icon with two circular refresh arrows overlaid. Blue/teal palette (neutral, not using Facebook's blue directly to avoid brand confusion).

**Option B — Tag + Upward Arrow:**
A price tag with an upward-pointing arrow — communicates "move listing up". Clean, minimal.

**Option C — Marketplace Grid + Refresh:**
A 2×2 grid (marketplace/listings metaphor) with a small refresh arrow at the top-right corner.

**Brand constraints:** Do not use Facebook's thumbs-up icon, the F logo, or Meta's infinity/M logos. Do not use colours that imply affiliation (avoid the exact Facebook #1877F2 blue as the primary/sole colour).

---

## Screenshot Ideas (5 recommended)

All screenshots should be 1280×800 px. Consider adding a thin device frame or browser chrome to contextualise them.

### Screenshot 1 — The On-Page Relist Button
**Caption:** "Relist button appears directly on your Facebook Marketplace Selling page — no extra steps"
**What to show:** The `/marketplace/you/selling` page with a visible "Relist" button injected next to a listing. Ideally with a cursor hover state.

### Screenshot 2 — Popup in Action (Single Relist Progress)
**Caption:** "Real-time progress: Photos → Create → Condition → Done in under 10 seconds"
**What to show:** The extension popup showing a relist in progress — status labels like "Uploading photos…", "Creating listing…", "Done ✓". Use a realistic-looking listing (blurred/anonymised if needed).

### Screenshot 3 — Bulk Multi-Select
**Caption:** "Select multiple listings and relist them all at once"
**What to show:** The popup with several listings checked (checkboxes visible), a "Relist Selected" button prominent. Shows the multi-select UI clearly.

### Screenshot 4 — Options Page: Schedule + AI Enhance
**Caption:** "Schedule automatic relisting every 12 or 24 hours — runs in the background while you sleep"
**What to show:** The Options page with the schedule interval selector and the AI enhance toggle (disabled by default). Shows the Gemini API key field with placeholder text.

### Screenshot 5 — Before / After Listing Position (Conceptual)
**Caption:** "Your listing climbs back to the top of local search after relisting"
**What to show:** A side-by-side or before/after composition showing a listing timestamp "3 days ago" vs "just now" — illustrating the freshness benefit. This can be a designed graphic rather than a raw screenshot.

---

## Promotional Tile Design Notes

### Small Promo Tile (440×280)
- Headline: "Relist. Refresh. Rise to the top."
- Sub-line: "1-click Facebook Marketplace relisting"
- Visual: the extension icon large, plus a subtle upward arrow or graph
- Background: clean gradient (e.g. deep teal → mid-blue)
- No Facebook/Meta logos

### Marquee Tile (1400×560)
- More space — can include a mini screenshot composite on the right
- Headline large on the left: "Keep your Marketplace listings at the top."
- Feature pills: "1-Click" / "Bulk Relist" / "Auto-Schedule" / "AI Enhance"
- Same visual language as small tile

---

## Asset Production Checklist

- [ ] Design icon at vector scale, export at 16, 32, 48, 128 px PNG
- [ ] Create `icons/` directory in extension root, add four icon PNGs
- [ ] Add `icons` field to `manifest.json` (see manifest-recommendations.md)
- [ ] Take/produce 5 screenshots at 1280×800 px
- [ ] Design small promo tile 440×280 px
- [ ] Design marquee tile 1400×560 px (optional but recommended)
- [ ] Verify no Facebook/Meta logos or trademarked UI elements appear in any asset

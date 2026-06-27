// FB Marketplace Selector Debugger
// Paste this into browser console on: facebook.com/marketplace/you/selling?state=LIVE&status[0]=IN_STOCK
// Copy the output and share it — it tells us exactly which selectors work on your page.

(function debug() {
  const results = {};

  // 1. Search input
  results.searchInput_placeholder = !!document.querySelector('input[placeholder="Search your listings"]');
  results.searchInput_typeSearch   = !!document.querySelector('input[type="search"]');
  results.allInputsWithSearch      = Array.from(document.querySelectorAll('input'))
    .map(i => ({ type: i.type, placeholder: i.placeholder, ariaLabel: i.getAttribute('aria-label') }))
    .filter(i => i.placeholder || i.ariaLabel);

  // 2. Listing links (ID-based)
  const itemLinks = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]'));
  results.itemLinks_count = itemLinks.length;
  results.itemLinks_sample = itemLinks.slice(0, 3).map(a => a.href.match(/\/marketplace\/item\/(\d+)/)?.[1]);

  // 3. Listing title spans (what we click to open detail panel)
  const allSpans = Array.from(document.querySelectorAll('span'))
    .filter(s => !s.closest('input, textarea, [role="searchbox"], nav'));
  const longSpans = allSpans.filter(s => {
    const t = s.textContent.trim();
    return t.length > 10 && t.length < 100 && !t.includes('\n');
  });
  results.candidateTitleSpans_count = longSpans.length;
  results.candidateTitleSpans_sample = longSpans.slice(0, 5).map(s => s.textContent.trim());

  // 4. Action buttons visible on the listing cards
  const LABELS = ['Boost listing', 'Mark as sold', 'Mark as available', 'Relist', 'Delete', 'Edit'];
  results.actionButtons = {};
  LABELS.forEach(label => {
    const el = document.querySelector(`[aria-label="${label}"], [aria-label="${label.toLowerCase()}"]`);
    results.actionButtons[label] = !!el;
  });

  // 5. Delete button (in grid card)
  results.deleteInGrid = document.querySelectorAll('[aria-label="Delete"]').length;

  // 6. "Your Listing" panel (only appears after clicking a listing)
  results.yourListingPanel = !!document.querySelector('div[aria-label="Your Listing"]');
  results.yourListingPanel_alt = !!document.querySelector('div[aria-label="Your listing"]');

  console.log('=== FB Marketplace Selector Debug ===');
  console.log(JSON.stringify(results, null, 2));
  console.log('=====================================');
  console.log('NEXT STEP: Click any listing title to open its detail panel, then run the second snippet below.');
  return results;
})();

// ──────────────────────────────────────────────────────────────────
// SECOND SNIPPET — run AFTER clicking a listing to open detail panel:

(function debugPanel() {
  const panel = {};
  panel.yourListingPanel     = !!document.querySelector('div[aria-label="Your Listing"]');
  panel.yourListingPanel_lc  = !!document.querySelector('div[aria-label="Your listing"]');
  panel.deleteBtn_precise    = !!document.querySelector('div:not([role="gridcell"]) > div[aria-label="Delete"][tabindex="0"]');
  panel.deleteBtn_simple     = !!document.querySelector('div[aria-label="Delete"][tabindex="0"]');
  panel.allDeleteBtns = Array.from(document.querySelectorAll('[aria-label*="Delete"], [aria-label*="delete"]'))
    .map(el => ({ tag: el.tagName, role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex'), ariaLabel: el.getAttribute('aria-label'), parentRole: el.parentElement?.getAttribute('role') }));
  console.log('=== Panel Debug ===');
  console.log(JSON.stringify(panel, null, 2));
  return panel;
})();

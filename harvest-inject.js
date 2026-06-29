/**
 * harvest-inject.js — MAIN-world, document_start.
 *
 * Wraps window.fetch + XMLHttpRequest BEFORE Facebook's app bundle runs, so we
 * capture every Marketplace GraphQL response (the initial batch AND the
 * scroll-triggered "load more" pages). Accumulates every active listing into
 * window.__fbrHarvested. background.js reads this via executeScript(MAIN).
 *
 * Runs in the page's MAIN world — NO chrome.* APIs available here.
 *
 * Earlier the interceptor was injected from content.js at document_idle, which
 * was too late: Facebook had already fired (and bound) its first listing
 * queries, so only ~5–10 of ~15 listings were caught. Installing at
 * document_start fixes that.
 */
(() => {
  if (window.__fbrInterceptorInstalled) return;
  window.__fbrInterceptorInstalled = true;
  if (!window.__fbrHarvested) window.__fbrHarvested = [];

  function collectFromObj(root) {
    function walk(o, seen, depth) {
      if (!o || typeof o !== 'object' || depth > 50 || seen.has(o)) return;
      seen.add(o);
      const tn = o.__typename;
      if ((tn === 'MarketplaceForSaleItem' || tn === 'GroupCommerceProductItem') &&
          o.id && o.marketplace_listing_title &&
          !(o.is_sold || o.is_pending || o.is_draft)) {
        const id = String(o.id);
        if (!window.__fbrHarvested.some(x => x.id === id)) {
          const uri = (o.primary_listing_photo && o.primary_listing_photo.image && o.primary_listing_photo.image.uri)
                   || (o.listing_photos && o.listing_photos.edges && o.listing_photos.edges[0] && o.listing_photos.edges[0].node && o.listing_photos.edges[0].node.image && o.listing_photos.edges[0].node.image.uri)
                   || null;
          let photoFilename = null;
          if (uri) {
            try { photoFilename = new URL(uri).pathname.split('/').pop() || null; }
            catch (_) { photoFilename = uri.split('/').pop().split('?')[0] || null; }
          }
          window.__fbrHarvested.push({ id, title: o.marketplace_listing_title, photoFilename });
        }
      }
      const vals = Array.isArray(o) ? o : Object.values(o);
      for (const v of vals) walk(v, seen, depth + 1);
    }
    walk(root, new Set(), 0);
  }

  function processText(text) {
    if (!text || text.indexOf('marketplace_listing_title') === -1) return;
    // FB responses can be newline-delimited multi-JSON.
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try { collectFromObj(JSON.parse(line)); } catch (_) {}
    }
  }

  // Wrap fetch
  const _origFetch = window.fetch;
  if (_origFetch) {
    window.fetch = function () {
      const args = Array.prototype.slice.call(arguments);
      const url = (typeof args[0] === 'string') ? args[0]
                : (args[0] && typeof args[0].url === 'string') ? args[0].url : '';
      const p = _origFetch.apply(this, args);
      if (url.indexOf('/api/graphql') !== -1) {
        p.then(function (resp) {
          try { resp.clone().text().then(processText).catch(function () {}); } catch (_) {}
        }).catch(function () {});
      }
      return p;
    };
  }

  // Wrap XMLHttpRequest
  const _origOpen = XMLHttpRequest.prototype.open;
  const _origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__fbrXhrUrl = String(url || '');
    return _origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (this.__fbrXhrUrl && this.__fbrXhrUrl.indexOf('/api/graphql') !== -1) {
      const self = this;
      self.addEventListener('load', function () {
        try { processText(self.responseText); } catch (_) {}
      });
    }
    return _origSend.apply(this, arguments);
  };
})();

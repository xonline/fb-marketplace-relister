// hook.js — Runs in the PAGE's main world (world: "MAIN") so it can patch window.fetch/XHR.
// Intercepts Facebook's own GraphQL responses and relays marketplace data to content.js
// via window.postMessage. content.js (isolated world) cannot patch window.fetch itself.
(function () {
  if (window.__fbRelisterHooked) return;
  window.__fbRelisterHooked = true;

  function relay(text) {
    if (text && (text.includes('marketplace') || text.includes('listing'))) {
      window.postMessage({ __fbRelister: 'graphql', text }, '*');
    }
  }

  // ─── fetch hook ───────────────────────────────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0]
              : (args[0] && args[0].url) ? args[0].url : '';

    const res = await _fetch.apply(this, args);

    if (url.includes('/api/graphql')) {
      res.clone().text().then(t => relay(t)).catch(() => {});
    }

    return res;
  };

  // ─── XHR hook ─────────────────────────────────────────────────────────────────
  const _XHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new _XHR();
    let capturedUrl = '';

    const origOpen = xhr.open.bind(xhr);
    xhr.open = function (m, u) {
      capturedUrl = String(u);
      return origOpen.apply(this, arguments);
    };

    xhr.addEventListener('load', function () {
      if (capturedUrl.includes('/api/graphql')) {
        relay(xhr.responseText || '');
      }
    });

    return xhr;
  }
  PatchedXHR.prototype = _XHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  console.log('[Relister] main-world hook installed');
})();

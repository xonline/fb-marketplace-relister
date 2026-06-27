/**
 * FB Marketplace Relister v3.0.0 — Injected Functions
 *
 * TWO top-level async functions, each 100% self-contained (no shared outer scope).
 * Chrome serialises these with .toString() and re-parses them inside the target tab.
 * Every helper is duplicated inside each function body.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * scrapeListingFn()
 *   Runs on: /marketplace/edit/?listing_id=X
 *   Returns: {
 *     type:            'item' | 'vehicle' | 'rental',
 *     fields:          [{ title:string, value:string }],   // text inputs & textareas
 *     dropdowns:       [{ title:string, value:string }],   // label-based combos/selects
 *     images:          string[],                           // CDN URLs, full-res, max 10
 *     hideFromFriends: 'true' | 'false' | null,
 *     checkboxes:      [{ text:string, checked:boolean }],
 *     log:             string[],
 *   }
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * fillListingFn(scraped)
 *   Runs on: /marketplace/create/<type>
 *   Args:    the return value of scrapeListingFn() (JSON-serialisable)
 *   Returns: { published:boolean, newId:string|null, log:string[] }
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Selector strategy (primary → fallback):
 *   Text inputs   : aria-label match → label-span text match → hashed-class div
 *   Dropdowns     : label[role="combobox"][aria-label] → label span text → hashed label class
 *   Category      : label span text === "Category" → hashed label class
 *   Images        : img[src*="fbcdn"/"scontent"] (not static./data:) → div.x1c4vz4f img
 *   Publish       : div[aria-label="Publish"][role="button"]:not([aria-disabled="true"])
 */

/* ═══════════════════════════════════════════════════════════════════════════
   SCRAPE
   ═══════════════════════════════════════════════════════════════════════════ */

async function scrapeListingFn() {
  const log = [];

  /* ── helpers ─────────────────────────────────────────────────────────── */

  function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /** Wait for a single element (MutationObserver + timeout). */
  function waitForElement(selector, timeout) {
    timeout = timeout || 8000;
    return new Promise(function(resolve, reject) {
      var el = document.querySelector(selector);
      if (el) return resolve(el);
      var obs = new MutationObserver(function() {
        var found = document.querySelector(selector);
        if (found) { obs.disconnect(); resolve(found); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(function() {
        obs.disconnect();
        reject(new Error('timeout waiting for ' + selector));
      }, timeout);
    });
  }

  /** Strip stp= query param to get full-res fbcdn URL. */
  function stripStp(url) {
    try {
      var u = new URL(url);
      u.searchParams.delete('stp');
      return u.toString();
    } catch (e) {
      return url;
    }
  }

  /* ── wait for form to render ─────────────────────────────────────────── */
  try {
    await waitForElement('input, textarea', 8000);
    await delay(500);
    log.push('scrape: form rendered');
  } catch (e) {
    log.push('scrape: WARNING — form did not render in 8s, proceeding anyway');
  }

  /* ── fields: text inputs and textareas ───────────────────────────────── */
  var fields = [];
  var seenFieldTitles = new Set();

  // Primary: every <label> whose span text + input/textarea we can read
  // Also matches the exact structure FB uses in the edit form.
  var allLabels = Array.from(document.querySelectorAll('label'));
  for (var lbl of allLabels) {
    var spanEl = lbl.querySelector('span');
    var inputEl = lbl.querySelector('input:not([type="file"]):not([type="checkbox"]):not([role="switch"]), textarea');
    if (!spanEl || !inputEl) continue;
    // Skip combobox/button labels — those are dropdowns, handled separately
    if (lbl.getAttribute('role') === 'combobox' || lbl.getAttribute('role') === 'button') continue;
    var title = spanEl.textContent.trim();
    var value = inputEl.type === 'checkbox'
      ? (inputEl.checked ? 'Enabled' : 'Disabled')
      : (inputEl.value || '').trim();
    if (!title) continue;
    if (!seenFieldTitles.has(title)) {
      seenFieldTitles.add(title);
      fields.push({ title: title, value: value });
    }
  }
  log.push('scrape: label-pass found ' + fields.length + ' input fields');

  // Fallback: ai_magic hashed-class divs
  if (fields.length === 0) {
    log.push('scrape: label-pass empty, trying hashed-class fallback');
    var fallbackParents = document.querySelectorAll('div.x78zum5.xdt5ytf.xh8yej3');
    fallbackParents.forEach(function(parent) {
      var span = parent.querySelector('span');
      var input = parent.querySelector('input, textarea');
      if (!span || !input) return;
      var title = span.textContent.trim();
      var value = input.type === 'checkbox'
        ? (input.checked ? 'Enabled' : 'Disabled')
        : (input.value || '').trim();
      if (!title) return;
      if (!seenFieldTitles.has(title)) {
        seenFieldTitles.add(title);
        fields.push({ title: title, value: value });
      }
    });
    log.push('scrape: hashed-class fallback found ' + fields.length + ' fields');
  }

  // Also pick up list-item fields (key/value rendered in <ul>)
  var listItems = document.querySelectorAll("ul > li[aria-hidden='false']");
  var listCount = 0;
  listItems.forEach(function(li) {
    var keyEl = li.querySelector('span.x150jy0e span.x193iq5w') || li.querySelector('span:first-child');
    var valEl = li.querySelector('span.x1e558r4 span.x193iq5w') || li.querySelector('span:last-child');
    if (!keyEl || !valEl) return;
    var title = (keyEl.innerText || keyEl.textContent || '').trim();
    var value = (valEl.innerText || valEl.textContent || '').trim();
    if (!title || !value) return;
    if (!seenFieldTitles.has(title)) {
      seenFieldTitles.add(title);
      fields.push({ title: title, value: value });
      listCount++;
    }
  });
  if (listCount > 0) log.push('scrape: list-item pass added ' + listCount + ' more fields');

  /* ── dropdowns: combos / selects ─────────────────────────────────────── */
  var dropdowns = [];
  var seenDropdownTitles = new Set();

  // Primary: label[role="combobox"] or label[role="button"]
  var comboLabels = Array.from(document.querySelectorAll('label[role="combobox"], label[role="button"]'));
  for (var cl of comboLabels) {
    var span = cl.querySelector('span');
    if (!span) continue;
    var title = span.textContent.trim();
    if (!title) continue;
    // Value is in a nested div>div>span or a child input's value
    var valSpan = cl.querySelector('div > div > span');
    var valInput = cl.querySelector('div > input');
    var value = valSpan ? valSpan.textContent.trim() : (valInput ? valInput.value.trim() : '');
    if (!seenDropdownTitles.has(title)) {
      seenDropdownTitles.add(title);
      dropdowns.push({ title: title, value: value });
    }
  }
  log.push('scrape: primary combobox-label pass found ' + dropdowns.length + ' dropdowns');

  // Fallback: ai_magic hashed-class label
  if (dropdowns.length === 0) {
    log.push('scrape: dropdown primary empty, trying hashed-class label fallback');
    document.querySelectorAll('label.x78zum5.xh8yej3').forEach(function(label) {
      var span = label.querySelector('span');
      var valSpan = label.querySelector('div > div > span');
      var valInput = label.querySelector('div > input');
      if (!span) return;
      var title = span.textContent.trim();
      var value = valSpan ? valSpan.textContent.trim() : (valInput ? valInput.value.trim() : '');
      if (!title || seenDropdownTitles.has(title)) return;
      seenDropdownTitles.add(title);
      dropdowns.push({ title: title, value: value });
    });
    log.push('scrape: hashed-class label fallback found ' + dropdowns.length + ' dropdowns');
  }

  /* ── type detection ───────────────────────────────────────────────────── */
  var type = 'item';
  if (fields.length > 0) {
    var firstTitle = fields[0].title;
    if (firstTitle === 'Title') type = 'item';
    else if (firstTitle === 'Location') type = 'vehicle';
    else type = 'rental';
  }
  log.push('scrape: detected type=' + type + ' from first field title="' + (fields[0] ? fields[0].title : '') + '"');

  /* ── images ───────────────────────────────────────────────────────────── */
  var images = [];
  var seenUrls = new Set();

  // Primary: any img whose src contains fbcdn or scontent, excluding static./data:
  var allImgs = Array.from(document.querySelectorAll('img'));
  for (var img of allImgs) {
    var src = img.getAttribute('src') || '';
    if (!src) continue;
    if (src.startsWith('data:')) continue;
    if (src.includes('static.') || src.includes('static.xx.fbcdn.net')) continue;
    if (!src.includes('fbcdn') && !src.includes('scontent')) continue;
    // Prefer large images: skip tiny thumbnails (width < 80)
    var w = img.naturalWidth || img.width || 0;
    var h = img.naturalHeight || img.height || 0;
    if (w > 0 && w < 80 && h < 80) continue;
    var clean = stripStp(src);
    if (!seenUrls.has(clean)) {
      seenUrls.add(clean);
      images.push(clean);
    }
    if (images.length >= 10) break;
  }
  log.push('scrape: primary img pass found ' + images.length + ' images');

  // Fallback: ai_magic div.x1c4vz4f img
  if (images.length === 0) {
    log.push('scrape: image primary empty, trying div.x1c4vz4f fallback');
    document.querySelectorAll('div.x1c4vz4f img').forEach(function(img) {
      var src = img.getAttribute('src') || '';
      if (!src || src.startsWith('data:') || src.includes('static.')) return;
      var clean = stripStp(src);
      if (!seenUrls.has(clean)) {
        seenUrls.add(clean);
        images.push(clean);
      }
    });
    log.push('scrape: div.x1c4vz4f fallback found ' + images.length + ' images');
  }

  if (images.length > 10) images.length = 10;

  /* ── hide-from-friends toggle ─────────────────────────────────────────── */
  var hideFromFriends = null;
  try {
    // Primary: input[aria-label="Enabled"][role="switch"]
    var toggleInput = document.querySelector('input[aria-label="Enabled"][role="switch"]');
    if (toggleInput) {
      hideFromFriends = toggleInput.checked ? 'true' : 'false';
      log.push('scrape: hideFromFriends toggle via input[role=switch] = ' + hideFromFriends);
    } else {
      // Fallback: div/span with aria-label="Enabled" or aria-checked
      var toggleDiv = document.querySelector('[aria-label="Enabled"]');
      if (toggleDiv) {
        var ariaChecked = toggleDiv.getAttribute('aria-checked');
        hideFromFriends = ariaChecked === 'true' ? 'true' : ariaChecked === 'false' ? 'false' : null;
        log.push('scrape: hideFromFriends toggle via [aria-label=Enabled] aria-checked=' + ariaChecked);
      } else {
        log.push('scrape: hideFromFriends toggle not found');
      }
    }
  } catch (e) {
    log.push('scrape: hideFromFriends ERROR: ' + e.message);
  }

  /* ── checkboxes ───────────────────────────────────────────────────────── */
  var checkboxes = [];
  try {
    var checkboxEls = document.querySelectorAll('[role="checkbox"]');
    checkboxEls.forEach(function(cb) {
      var isChecked = cb.getAttribute('aria-checked') === 'true';
      // Try to find label text nearby
      var textEl = cb.querySelector('span[dir="auto"]') || cb.querySelector('span') || cb.closest('label');
      var text = textEl ? textEl.textContent.trim() : '';
      if (!text) {
        // Walk up one level and find a sibling span
        var parent = cb.parentElement;
        if (parent) {
          var sib = parent.querySelector('span');
          text = sib ? sib.textContent.trim() : '';
        }
      }
      checkboxes.push({ text: text, checked: isChecked });
    });
    log.push('scrape: found ' + checkboxes.length + ' checkboxes');
  } catch (e) {
    log.push('scrape: checkboxes ERROR: ' + e.message);
  }

  /* ── summary ─────────────────────────────────────────────────────────── */
  log.push('scrape: DONE — fields=' + fields.length + ' dropdowns=' + dropdowns.length + ' images=' + images.length + ' type=' + type);

  return {
    type: type,
    fields: fields,
    dropdowns: dropdowns,
    images: images,
    hideFromFriends: hideFromFriends,
    checkboxes: checkboxes,
    log: log,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   FILL
   ═══════════════════════════════════════════════════════════════════════════ */

async function fillListingFn(scraped) {
  var log = [];
  var published = false;
  var newId = null;

  /* ── helpers ─────────────────────────────────────────────────────────── */

  function delay(ms) {
    return new Promise(function(r) { setTimeout(r, ms); });
  }

  /** Wait for a single element (MutationObserver + timeout). */
  function waitForElement(selector, timeout) {
    timeout = timeout || 8000;
    return new Promise(function(resolve, reject) {
      var el = document.querySelector(selector);
      if (el) return resolve(el);
      var obs = new MutationObserver(function() {
        var found = document.querySelector(selector);
        if (found) { obs.disconnect(); resolve(found); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(function() {
        obs.disconnect();
        reject(new Error('timeout waiting for ' + selector));
      }, timeout);
    });
  }

  /** Wait for any of several selectors — resolves with the first one found. */
  function waitForAny(selectors, timeout) {
    timeout = timeout || 8000;
    return new Promise(function(resolve, reject) {
      function check() {
        for (var i = 0; i < selectors.length; i++) {
          var el = document.querySelector(selectors[i]);
          if (el) return resolve(el);
        }
        return null;
      }
      var immediate = check();
      if (immediate) return;
      var obs = new MutationObserver(function() {
        var found = check();
        if (found) { obs.disconnect(); resolve(found); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(function() {
        obs.disconnect();
        reject(new Error('timeout waiting for any of: ' + selectors.join(', ')));
      }, timeout);
    });
  }

  /**
   * React-safe value setter.
   * Plain assignment to .value is ignored by React's synthetic event system.
   * We call the native setter and then dispatch input+change.
   */
  function setNativeValue(el, value) {
    var proto = el.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * slug/dashSlug helper — normalise to lowercase-dashed for fuzzy matching.
   */
  function dashSlug(str) {
    if (!str || !str.length) return str;
    return str.toString()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^\w-]+/g, '')
      .replace(/--+/g, '-');
  }

  /**
   * str1Instr2: fuzzy — are most slug-tokens of string1 found in string2?
   */
  function str1Instr2(string1, string2) {
    string1 = dashSlug(string1 || '');
    string2 = dashSlug(string2 || '');
    var arr1 = string1.split('-').filter(Boolean);
    var found = 0;
    for (var i = 0; i < arr1.length; i++) {
      if (string2.indexOf(arr1[i]) !== -1) found++;
    }
    return found >= 2 || found === arr1.length;
  }

  /* ── 1. Wait for composer form ───────────────────────────────────────── */
  log.push('fill: waiting for create form to render...');
  try {
    await waitForElement('input, textarea', 8000);
    await delay(2000); // FB SPA needs settle time after initial render
    log.push('fill: create form rendered');
  } catch (e) {
    log.push('fill: WARNING — form may not be ready: ' + e.message);
    await delay(3000);
  }

  /* ── 2. Fill text inputs and dropdowns (relistItem logic) ────────────── */
  // Merge fields + dropdowns, skip Category (handled separately), skip empty
  var allFields = [];
  var seenMerge = new Set();
  var srcArrays = [scraped.fields || [], scraped.dropdowns || []];
  for (var si = 0; si < srcArrays.length; si++) {
    for (var fi = 0; fi < srcArrays[si].length; fi++) {
      var fd = srcArrays[si][fi];
      if (!fd.title || seenMerge.has(fd.title)) continue;
      seenMerge.add(fd.title);
      allFields.push(fd);
    }
  }

  for (var ai = 0; ai < allFields.length; ai++) {
    var title = allFields[ai].title;
    var value = allFields[ai].value;

    if (!value || value.trim() === '') {
      log.push('fill: skipping "' + title + '" — empty value');
      continue;
    }
    if (title === 'Category') {
      log.push('fill: skipping "Category" — handled by fillCategory step');
      continue;
    }
    // Skip Description — handled separately (textarea with React setter)
    if (title === 'Description' || title === 'Rental description') {
      log.push('fill: skipping "' + title + '" — handled by fillDescription step');
      continue;
    }

    var fieldFound = false;

    // Try combobox dropdown first
    try {
      var combobox = document.querySelector('label[role="combobox"][aria-label="' + title + '"]')
        || Array.from(document.querySelectorAll('label[role="combobox"]')).find(function(lb) {
          return lb.textContent.trim().indexOf(title) !== -1;
        });

      if (combobox) {
        combobox.click();
        await delay(600);
        // Look for options in a listbox or dropdown menu
        var options = Array.from(
          document.querySelectorAll('[role="listbox"] [role="option"], [role="option"]')
        );
        if (options.length === 0) {
          options = Array.from(document.querySelectorAll('[role="listbox"] div'));
        }
        var matched = null;
        for (var oi = 0; oi < options.length; oi++) {
          var optText = options[oi].textContent.trim();
          if (optText === value
            || dashSlug(optText) === dashSlug(value)
            || str1Instr2(optText, value)
            || str1Instr2(value, optText)) {
            matched = options[oi];
            break;
          }
        }
        if (matched) {
          matched.click();
          fieldFound = true;
          log.push('fill: dropdown "' + title + '" set to "' + value + '" ✓');
        } else {
          log.push('fill: dropdown "' + title + '" — no match for "' + value + '". Options: ['
            + options.slice(0, 8).map(function(o) { return o.textContent.trim(); }).join(', ') + ']');
          // Close the dropdown by pressing Escape
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        }
        await delay(300);
      }
    } catch (e) {
      log.push('fill: dropdown "' + title + '" ERROR: ' + e.message);
    }

    // Try text input / textarea
    if (!fieldFound) {
      try {
        var input = document.querySelector('input[aria-label="' + title + '"]')
          || document.querySelector('textarea[aria-label="' + title + '"]')
          || (function() {
            // Walk labels looking for span text match
            var labels = Array.from(document.querySelectorAll('label'));
            for (var li2 = 0; li2 < labels.length; li2++) {
              var spanEl = labels[li2].querySelector('span');
              if (spanEl && spanEl.textContent.trim() === title) {
                return labels[li2].querySelector('input:not([type="file"]):not([type="checkbox"]), textarea');
              }
            }
            return null;
          })();

        if (input && input.tagName !== 'TEXTAREA') { // textareas handled in fillDescription
          setNativeValue(input, value);
          fieldFound = true;
          log.push('fill: input "' + title + '" set to "' + value.substring(0, 60) + '" ✓');
        }
      } catch (e) {
        log.push('fill: input "' + title + '" ERROR: ' + e.message);
      }
    }

    // Checkbox fallback
    if (!fieldFound) {
      try {
        var checkbox = document.querySelector('input[type="checkbox"][aria-label="' + title + '"]')
          || (function() {
            var labels = Array.from(document.querySelectorAll('label'));
            for (var li3 = 0; li3 < labels.length; li3++) {
              var sp = labels[li3].querySelector('span');
              if (sp && sp.textContent.trim() === title) {
                return labels[li3].querySelector('input[type="checkbox"]');
              }
            }
            return null;
          })();

        if (checkbox) {
          var shouldCheck = value.toLowerCase() === 'enabled' || value.toLowerCase() === 'true';
          if (checkbox.checked !== shouldCheck) {
            checkbox.click();
          }
          fieldFound = true;
          log.push('fill: checkbox "' + title + '" set to ' + shouldCheck + ' ✓');
        }
      } catch (e) {
        log.push('fill: checkbox "' + title + '" ERROR: ' + e.message);
      }
    }

    if (!fieldFound) {
      log.push('fill: WARNING "' + title + '" — not found in form, skipped');
    }
  }

  /* ── 3. Fill Category ─────────────────────────────────────────────────── */
  var categoryValue = null;
  var catFromDropdowns = (scraped.dropdowns || []).find(function(d) { return d.title === 'Category'; });
  var catFromFields = (scraped.fields || []).find(function(f) { return f.title === 'Category'; });
  if (catFromDropdowns && catFromDropdowns.value) categoryValue = catFromDropdowns.value;
  else if (catFromFields && catFromFields.value) categoryValue = catFromFields.value;

  if (categoryValue) {
    log.push('fill: filling Category = "' + categoryValue + '"');
    try {
      // Primary: label where span text === "Category"
      var categoryButton = null;
      var allLabels2 = Array.from(document.querySelectorAll('label[role="button"], label[role="combobox"]'));
      for (var ci = 0; ci < allLabels2.length; ci++) {
        var sp2 = allLabels2[ci].querySelector('span');
        if (sp2 && sp2.textContent.trim() === 'Category') {
          categoryButton = allLabels2[ci];
          break;
        }
      }
      // Fallback: ai_magic hashed classes
      if (!categoryButton) {
        categoryButton = document.querySelector('label.x78zum5.xh8yej3[role="button"]')
          || document.querySelector('label.x78zum5.xh8yej3[role="combobox"]');
      }

      if (!categoryButton) {
        log.push('fill: Category — button not found');
      } else {
        categoryButton.click();
        log.push('fill: Category button clicked, waiting for dropdown...');
        await delay(1000);

        var catDropdown = await waitForElement('div[aria-label="Dropdown menu"]', 6000).catch(function() { return null; });
        if (!catDropdown) {
          // Try alternative: a listbox
          catDropdown = document.querySelector('[role="listbox"]') || document.querySelector('[role="menu"]');
        }

        if (!catDropdown) {
          log.push('fill: Category dropdown did not appear');
        } else {
          var catItems = Array.from(catDropdown.querySelectorAll('div[role="button"], div[role="option"]'));
          log.push('fill: Category — ' + catItems.length + ' options: ['
            + catItems.slice(0, 15).map(function(it) {
              return (it.querySelector('span') || it).textContent.trim();
            }).join(', ') + ']');

          var catFound = false;
          for (var cii = 0; cii < catItems.length; cii++) {
            var itemText = ((catItems[cii].querySelector('span') || catItems[cii]).textContent || '').trim();
            if (itemText.toLowerCase() === categoryValue.toLowerCase()
              || dashSlug(itemText) === dashSlug(categoryValue)
              || str1Instr2(itemText, categoryValue)
              || str1Instr2(categoryValue, itemText)) {
              catItems[cii].click();
              catFound = true;
              log.push('fill: Category matched "' + itemText + '" for target "' + categoryValue + '" ✓');
              break;
            }
          }
          if (!catFound) {
            log.push('fill: Category "' + categoryValue + '" NOT matched — available: ['
              + catItems.map(function(it) { return (it.querySelector('span') || it).textContent.trim(); }).join(', ') + ']');
          }
          await delay(500);
        }
      }
    } catch (e) {
      log.push('fill: Category ERROR: ' + e.message);
    }
  } else {
    log.push('fill: Category — no value scraped, skipping');
  }

  /* ── 4. Upload images ─────────────────────────────────────────────────── */
  var images = scraped.images || [];
  if (images.length > 0) {
    log.push('fill: uploading ' + images.length + ' images...');
    try {
      // Locate the file input — FB uses accept="image/*,image/heif,image/heic" or similar
      var fileInput = document.querySelector('input[type="file"][accept*="image"]')
        || document.querySelector('input[type="file"]');

      if (!fileInput) {
        log.push('fill: images — file input not found');
      } else {
        var dataTransfer = new DataTransfer();
        var uploadCount = 0;
        for (var ii = 0; ii < Math.min(images.length, 10); ii++) {
          var imageUrl = images[ii];
          try {
            var response = await fetch(imageUrl);
            if (!response.ok) throw new Error('HTTP ' + response.status);
            var blob = await response.blob();
            var mimeType = blob.type || 'image/jpeg';
            var ext = mimeType.split('/')[1] || 'jpg';
            var file = new File([blob], 'image_' + (ii + 1) + '.' + ext, { type: mimeType });
            dataTransfer.items.add(file);
            uploadCount++;
            log.push('fill: image ' + (ii + 1) + ' fetched (' + Math.round(blob.size / 1024) + 'KB) ✓');
          } catch (fetchErr) {
            log.push('fill: image ' + (ii + 1) + ' fetch FAILED: ' + fetchErr.message + ' url=' + imageUrl.substring(0, 80));
          }
        }

        if (dataTransfer.files.length > 0) {
          fileInput.files = dataTransfer.files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          log.push('fill: dispatched change event with ' + dataTransfer.files.length + ' files');

          // Wait for upload thumbnails to appear (uploads are async on FB's end)
          // Poll for uploaded-image indicators: img[src*="fbcdn"] or upload-progress elements
          var uploadWaitMs = 0;
          var uploadMaxMs = 30000; // 30s max
          var uploadPollMs = 1000;
          var thumbnailsReady = false;
          while (uploadWaitMs < uploadMaxMs) {
            await delay(uploadPollMs);
            uploadWaitMs += uploadPollMs;
            // FB renders uploaded thumbnails as img elements with fbcdn src inside the composer
            var thumbs = document.querySelectorAll('img[src*="fbcdn"], img[src*="blob:"]');
            // Also check for upload-in-progress spinner disappearing
            var spinners = document.querySelectorAll('[aria-label*="upload" i], [aria-label*="Upload" i]');
            if (thumbs.length >= dataTransfer.files.length) {
              thumbnailsReady = true;
              log.push('fill: upload thumbnails detected (' + thumbs.length + ') after ' + uploadWaitMs + 'ms ✓');
              break;
            }
            log.push('fill: waiting for upload thumbnails... (' + uploadWaitMs + 'ms, ' + thumbs.length + '/' + dataTransfer.files.length + ' visible)');
          }
          if (!thumbnailsReady) {
            log.push('fill: upload thumbnails not confirmed within ' + uploadMaxMs + 'ms — continuing anyway');
          }
        } else {
          log.push('fill: images — all fetches failed, no files to upload');
        }
      }
    } catch (e) {
      log.push('fill: images ERROR: ' + e.message);
    }
  } else {
    log.push('fill: images — none to upload');
  }

  /* ── 5. Fill Description ─────────────────────────────────────────────── */
  var descField = (scraped.fields || []).find(function(f) {
    return f.title === 'Description' || f.title === 'Rental description';
  });
  if (descField && descField.value) {
    log.push('fill: filling Description (' + descField.value.length + ' chars)...');
    try {
      // Primary: textarea[aria-label="Description"] or label-span match
      var descEl = document.querySelector('textarea[aria-label="Description"]')
        || document.querySelector('textarea[aria-label="Rental description"]')
        || (function() {
          var teas = Array.from(document.querySelectorAll('textarea'));
          // Find the textarea whose label span says Description
          for (var di = 0; di < teas.length; di++) {
            var lbl2 = teas[di].closest('label');
            if (lbl2) {
              var sp3 = lbl2.querySelector('span');
              if (sp3 && (sp3.textContent.trim() === 'Description' || sp3.textContent.trim() === 'Rental description')) {
                return teas[di];
              }
            }
          }
          // Fallback: first textarea found
          return teas.length > 0 ? teas[0] : null;
        })();

      if (descEl) {
        setNativeValue(descEl, descField.value);
        log.push('fill: Description set ✓');
      } else {
        log.push('fill: Description — textarea not found');
      }
    } catch (e) {
      log.push('fill: Description ERROR: ' + e.message);
    }
  } else {
    log.push('fill: Description — no value scraped, skipping');
  }

  /* ── 6. Hide-from-friends toggle ──────────────────────────────────────── */
  if (scraped.hideFromFriends !== null && scraped.hideFromFriends !== undefined) {
    log.push('fill: setting hideFromFriends = ' + scraped.hideFromFriends);
    try {
      var hffInput = document.querySelector('input[aria-label="Enabled"][role="switch"]');
      if (hffInput) {
        var wantChecked = scraped.hideFromFriends === 'true';
        if (hffInput.checked !== wantChecked) {
          hffInput.click();
          log.push('fill: hideFromFriends toggled to ' + wantChecked + ' ✓');
        } else {
          log.push('fill: hideFromFriends already ' + wantChecked + ', no change');
        }
      } else {
        // Fallback: look for any toggle with aria-checked
        var hffDiv = document.querySelector('[aria-label="Enabled"]');
        if (hffDiv) {
          var currentState = hffDiv.getAttribute('aria-checked');
          var wantState = scraped.hideFromFriends;
          if (currentState !== wantState) {
            hffDiv.click();
            log.push('fill: hideFromFriends (div) toggled ✓');
          } else {
            log.push('fill: hideFromFriends (div) already correct ✓');
          }
        } else {
          log.push('fill: hideFromFriends — toggle element not found');
        }
      }
    } catch (e) {
      log.push('fill: hideFromFriends ERROR: ' + e.message);
    }
  } else {
    log.push('fill: hideFromFriends — null/not scraped, skipping');
  }

  /* ── 7. Checkboxes (delivery options etc.) ───────────────────────────── */
  var checkboxes = scraped.checkboxes || [];
  if (checkboxes.length > 0) {
    log.push('fill: processing ' + checkboxes.length + ' checkboxes...');
    for (var cbi = 0; cbi < checkboxes.length; cbi++) {
      var cbData = checkboxes[cbi];
      if (!cbData.text) continue;
      try {
        // Find [role="checkbox"] whose nearby span matches text
        var cbEls = Array.from(document.querySelectorAll('[role="checkbox"]'));
        var matchedCb = null;
        for (var cbe = 0; cbe < cbEls.length; cbe++) {
          var cbLabel = cbEls[cbe].querySelector('span[dir="auto"]') || cbEls[cbe].querySelector('span');
          var cbParent = cbEls[cbe].parentElement;
          var cbParentText = cbParent ? (cbParent.querySelector('span') || {textContent: ''}).textContent.trim() : '';
          var cbText = cbLabel ? cbLabel.textContent.trim() : cbParentText;
          if (cbText === cbData.text || cbParentText === cbData.text) {
            matchedCb = cbEls[cbe];
            break;
          }
        }
        if (matchedCb) {
          var isChecked = matchedCb.getAttribute('aria-checked') === 'true';
          if (isChecked !== cbData.checked) {
            matchedCb.click();
            log.push('fill: checkbox "' + cbData.text + '" toggled to ' + cbData.checked + ' ✓');
          } else {
            log.push('fill: checkbox "' + cbData.text + '" already ' + cbData.checked);
          }
        } else {
          log.push('fill: checkbox "' + cbData.text + '" not found');
        }
      } catch (e) {
        log.push('fill: checkbox "' + cbData.text + '" ERROR: ' + e.message);
      }
    }
  } else {
    log.push('fill: no checkboxes to set');
  }

  /* ── 8. Wait for FB validation to settle ─────────────────────────────── */
  log.push('fill: waiting 6s for FB validation...');
  await delay(6000);

  /* ── 9. Next button(s) — loop until Publish appears ─────────────────── */
  log.push('fill: checking for Next button(s)...');
  var nextClickCount = 0;
  var nextMaxClicks = 3; // safety cap — at most 3 Next steps
  for (var ni = 0; ni < nextMaxClicks; ni++) {
    var nextBtn = document.querySelector('div[aria-label="Next"][role="button"]');
    var publishBtnCheck = document.querySelector('div[aria-label="Publish"][role="button"]');
    if (publishBtnCheck) {
      log.push('fill: Publish button visible — skipping further Next clicks');
      break;
    }
    if (!nextBtn) {
      log.push('fill: no Next button found (attempt ' + (ni + 1) + ')');
      break;
    }
    nextBtn.click();
    nextClickCount++;
    log.push('fill: clicked Next (' + nextClickCount + ') — waiting 3s...');
    await delay(3000);
  }
  log.push('fill: Next phase done (' + nextClickCount + ' clicks)');

  /* ── 10. Publish — poll until enabled, then click ────────────────────── */
  log.push('fill: polling for Publish button (up to 15s)...');
  var publishClicked = false;
  for (var pi = 0; pi < 15; pi++) {
    try {
      // Enabled (not disabled) Publish button
      var pubBtn = document.querySelector('div[aria-label="Publish"][role="button"]:not([aria-disabled="true"])');
      if (pubBtn) {
        pubBtn.click();
        publishClicked = true;
        log.push('fill: Publish button clicked after ' + pi + 's ✓');
        break;
      }
      // Disabled button present — keep waiting
      var disabledPub = document.querySelector('div[aria-disabled="true"][aria-label="Publish"][role="button"]');
      if (disabledPub) {
        log.push('fill: Publish button disabled, waiting... (' + (pi + 1) + 's)');
      } else {
        // Neither found — check if Next is still there (needed another click)
        var lateNext = document.querySelector('div[aria-label="Next"][role="button"]');
        if (lateNext) {
          lateNext.click();
          log.push('fill: late Next button found and clicked');
          await delay(2000);
        } else {
          log.push('fill: no Publish or Next button found (' + (pi + 1) + 's)');
        }
      }
    } catch (e) {
      log.push('fill: Publish poll error: ' + e.message);
    }
    await delay(1000);
  }

  if (!publishClicked) {
    log.push('fill: FAILED — Publish button never became enabled (15s timeout)');
    return { published: false, newId: null, log: log };
  }

  published = true;

  /* ── 11. Try to extract newId from post-publish URL ──────────────────── */
  log.push('fill: waiting 3s for post-publish URL...');
  await delay(3000);
  try {
    var currentUrl = window.location.href;
    var idMatch = currentUrl.match(/\/marketplace\/item\/(\d+)/);
    if (idMatch) {
      newId = idMatch[1];
      log.push('fill: newId extracted from URL: ' + newId + ' ✓');
    } else {
      log.push('fill: newId not yet in URL (' + currentUrl.substring(0, 80) + ') — background will poll');
    }
  } catch (e) {
    log.push('fill: newId extraction ERROR: ' + e.message);
  }

  log.push('fill: DONE — published=' + published + ' newId=' + newId);
  return { published: published, newId: newId, log: log };
}

/**
 * options.js — Settings page logic for FB Marketplace Relister
 */

const FEATURE_REQUEST_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSc78R_TngfIQdszSibKVsNnsKYJVyK0zqj2eg4bZ8K6rJylqA/viewform';

const DEFAULT_SYSTEM_PROMPT =
  "You are the CBD Marketplace Pro, a specialist in crafting succinct, compelling, human-sounding ads for Facebook Marketplace, tailored for quick sales in Sydney. Persona: efficient, trustworthy, concise copywriter using Australian spelling. Given an item's brand/model/details and photo, produce: 2-3 keyword-rich title options; an engaging 1-2 paragraph description (open with what it is + appeal, then key features/benefits, then condition honestly; if used add 'Remember to be upfront about any specific marks if you add photos!'); and 5-10 product tags (product-related only, no location/payment). Always end the description with 'Pickup: Sydney CBD (near Central Station).' and 'Payment: Cash only.' on separate lines. No 'no scammers/time wasters' phrases, no corporate fluff.";

const DEFAULTS = {
  geminiApiKey:       '',
  geminiModel:        'gemini-2.5-flash',
  aiSystemPrompt:     DEFAULT_SYSTEM_PROMPT,
  aiEnhanceOnRelist:  false,
  priceDropEnabled:   false,
  priceDropType:      'percent',
  priceDropValue:     0,
  priceFloor:         1,
  scheduleEnabled:    false,
  scheduleEveryHours: 24,
  scheduleMode:       'interval',
  scheduleDateTime:   '',
  scheduleWeekday:    1,
  bulkDelaySec:       12,
};

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const fields = {
  geminiApiKey:       $('geminiApiKey'),
  geminiModel:        $('geminiModel'),
  aiSystemPrompt:     $('aiSystemPrompt'),
  aiEnhanceOnRelist:  $('aiEnhanceOnRelist'),
  priceDropEnabled:   $('priceDropEnabled'),
  priceDropType:      $('priceDropType'),
  priceDropValue:     $('priceDropValue'),
  priceFloor:         $('priceFloor'),
  scheduleEnabled:    $('scheduleEnabled'),
  scheduleEveryHours: $('scheduleEveryHours'),
  bulkDelaySec:       $('bulkDelaySec'),
};

const statusMsg    = $('status-msg');
const btnSave      = $('btn-save');
const btnTestAI    = $('btn-test-ai');
const dropUnit     = $('drop-unit');
// Plan status elements
const optPlanBadge  = $('opt-plan-badge');
const optPlanLabel  = $('opt-plan-label');
const optPlanSub    = $('opt-plan-sub');
const optBtnUpgrade = $('opt-btn-upgrade');
// Pro-gated sections (receive class 'pro-lock' when user is on free tier)
const sectionAI         = $('section-ai');
const sectionPricedrop  = $('section-pricedrop');
const sectionSchedule   = $('section-schedule');

// ── Helpers ──────────────────────────────────────────────────────────────────
function showStatus(type, text) {
  statusMsg.textContent = text;
  statusMsg.className   = type; // 'success' | 'error' | 'loading'
}

function hideStatus() {
  statusMsg.className   = '';
  statusMsg.textContent = '';
}

function readFields() {
  return {
    geminiApiKey:       fields.geminiApiKey.value.trim(),
    geminiModel:        fields.geminiModel.value.trim() || 'gemini-2.5-flash',
    aiSystemPrompt:     fields.aiSystemPrompt.value,
    aiEnhanceOnRelist:  fields.aiEnhanceOnRelist.checked,
    priceDropEnabled:   fields.priceDropEnabled.checked,
    priceDropType:      fields.priceDropType.value,
    priceDropValue:     parseFloat(fields.priceDropValue.value) || 0,
    priceFloor:         parseFloat(fields.priceFloor.value) || 1,
    scheduleEnabled:    fields.scheduleEnabled.checked,
    scheduleEveryHours: parseInt(fields.scheduleEveryHours.value, 10) || 24,
    bulkDelaySec:       parseInt(fields.bulkDelaySec.value, 10) || 12,
  };
}

function fillFields(settings) {
  const s = Object.assign({}, DEFAULTS, settings);
  fields.geminiApiKey.value        = s.geminiApiKey;
  fields.geminiModel.value         = s.geminiModel;
  fields.aiSystemPrompt.value      = s.aiSystemPrompt;
  fields.aiEnhanceOnRelist.checked = s.aiEnhanceOnRelist;
  fields.priceDropEnabled.checked  = s.priceDropEnabled;
  fields.priceDropType.value       = s.priceDropType;
  fields.priceDropValue.value      = s.priceDropValue;
  fields.priceFloor.value          = s.priceFloor;
  fields.scheduleEnabled.checked   = s.scheduleEnabled;
  fields.scheduleEveryHours.value  = s.scheduleEveryHours;
  fields.bulkDelaySec.value        = s.bulkDelaySec;

  // Sync unit label
  updateDropUnit(s.priceDropType);
}

function updateDropUnit(type) {
  dropUnit.textContent = type === 'percent' ? '%' : '$';
}

// ── Plan status ───────────────────────────────────────────────────────────────

function applyProGating(isPro) {
  const lock = !isPro;
  [sectionAI, sectionPricedrop, sectionSchedule].forEach(el => {
    if (!el) return;
    if (lock) el.classList.add('pro-lock');
    else      el.classList.remove('pro-lock');
  });
}

function loadPlanStatusOpts() {
  chrome.runtime.sendMessage({ kind: 'CHECK_PRO' }, response => {
    void chrome.runtime.lastError;
    if (!response) return;
    const { isPro } = response;

    if (isPro) {
      optPlanBadge.textContent  = 'PRO';
      optPlanBadge.className    = 'plan-badge-opt pro';
      optPlanLabel.textContent  = 'Pro plan — all features unlocked';
      optPlanSub.textContent    = '';
      optBtnUpgrade.style.display = 'none';
    } else {
      optPlanBadge.textContent  = 'FREE';
      optPlanBadge.className    = 'plan-badge-opt free';
      optPlanLabel.textContent  = 'Free plan — top 4 listings unlocked';
      optPlanSub.textContent    = 'AI, price drop & schedule require Pro';
      optBtnUpgrade.style.display = '';
    }
    applyProGating(isPro);
  });
}

optBtnUpgrade.addEventListener('click', () => {
  chrome.runtime.sendMessage({ kind: 'OPEN_PAYMENT_PAGE' });
});

// ── Load on open ─────────────────────────────────────────────────────────────
chrome.storage.local.get('fbr_settings', result => {
  fillFields(result.fbr_settings || {});
});

loadPlanStatusOpts();

// ── Save ─────────────────────────────────────────────────────────────────────
btnSave.addEventListener('click', () => {
  // Merge with existing stored settings so popup-only fields (scheduleMode,
  // scheduleDateTime, scheduleWeekday) are not wiped when saving from options.
  chrome.storage.local.get('fbr_settings', result => {
    const existing  = result.fbr_settings || {};
    const settings  = Object.assign({}, existing, readFields());
    chrome.storage.local.set({ fbr_settings: settings }, () => {
      if (chrome.runtime.lastError) {
        showStatus('error', 'Save failed: ' + chrome.runtime.lastError.message);
      } else {
        showStatus('success', 'Saved ✓');
        setTimeout(hideStatus, 3000);
      }
    });
  });
});

// ── Test AI Key ──────────────────────────────────────────────────────────────
btnTestAI.addEventListener('click', async () => {
  const settings = readFields();

  if (!settings.geminiApiKey) {
    showStatus('error', 'Enter a Gemini API key first.');
    return;
  }

  showStatus('loading', 'Testing API key…');
  btnTestAI.disabled = true;

  const model  = settings.geminiModel || 'gemini-2.5-flash';
  const url    = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${settings.geminiApiKey}`;
  const body   = JSON.stringify({
    contents: [{ parts: [{ text: 'Reply with just: OK' }] }],
  });

  try {
    const resp = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => '');
      const snippet  = bodyText.slice(0, 200);
      showStatus('error', `API error ${resp.status}: ${snippet}`);
    } else {
      const data    = await resp.json();
      const replyTx = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '(empty)';
      showStatus('success', `API key OK ✓  (model replied: "${replyTx.slice(0, 60)}")`);
      setTimeout(hideStatus, 6000);
    }
  } catch (err) {
    showStatus('error', `Network error: ${err.message}`);
  } finally {
    btnTestAI.disabled = false;
  }
});

// ── Live unit label sync ──────────────────────────────────────────────────────
fields.priceDropType.addEventListener('change', () => {
  updateDropUnit(fields.priceDropType.value);
});

// ── Feedback link ─────────────────────────────────────────────────────────────
const optBtnFeedback = document.getElementById('opt-btn-feedback');
if (optBtnFeedback) {
  optBtnFeedback.addEventListener('click', e => {
    e.preventDefault();
    chrome.tabs.create({ url: FEATURE_REQUEST_URL });
  });
}

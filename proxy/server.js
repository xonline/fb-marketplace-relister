'use strict';
/**
 * fbr-ai-proxy — AI proxy for "Relist for Facebook Marketplace"
 *
 * Endpoints:
 *   POST /api/ai               — license-gated Gemini call → {title,description}
 *   GET  /api/license?id=<uuid>— license status → {paid,plan,periodEnd}
 *   POST /api/stripe-webhook   — Stripe event handler (verified)
 *   POST /api/telemetry        — relist outcome tracking + Telegram alerts
 *   POST /api/event            — GA4 Measurement Protocol forward
 *   GET  /api/health           — health check
 *
 * ┌─ Key config ──────────────────────────────────────────────────────────────┐
 │  POY_GEMINI_API_KEY_FREE       — loaded via EnvironmentFile=/home/ubuntu/.env
 │  FBR_GEMINI_KEY_SLOT           — 'FREE' (default) | 'PAID'
 │  FBR_STRIPE_WEBHOOK_SECRET     — from proxy.env (webhook signing secret)
 │  GA4_MEASUREMENT_ID            — optional, set after GA4 property creation
 │  GA4_API_SECRET                — optional
 └───────────────────────────────────────────────────────────────────────────-─┘
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const url    = require('url');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.FBR_PORT || '8787', 10);
const HOST = '127.0.0.1';

const KEY_SLOT   = (process.env.FBR_GEMINI_KEY_SLOT || 'FREE').toUpperCase();
const GEMINI_KEY = KEY_SLOT === 'PAID'
  ? process.env.POY_GEMINI_API_KEY_PAID
  : process.env.POY_GEMINI_API_KEY_FREE;

const GLOBAL_DAILY_CAP = parseInt(process.env.FBR_GLOBAL_DAILY_CAP || '5000', 10);
const IP_HOURLY_CAP    = parseInt(process.env.FBR_IP_HOURLY_CAP    || '30',   10);

const STRIPE_WEBHOOK_SECRET = process.env.FBR_STRIPE_WEBHOOK_SECRET || '';

const GA4_MEASUREMENT_ID = process.env.GA4_MEASUREMENT_ID || '';
const GA4_API_SECRET     = process.env.GA4_API_SECRET     || '';

const TELEGRAM_TOKEN_FILE = '/home/ubuntu/scripts/.telegram-token';
const TELEGRAM_CHAT_ID   = '408149198';

const GEMINI_MODEL = 'gemini-flash-lite-latest';
const GEMINI_BASE  = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_URL   = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent`;

const PROXY_DIR       = path.dirname(process.argv[1] || __filename);
const LICENSES_FILE   = path.join(PROXY_DIR, 'licenses.json');
const TELEMETRY_FILE  = path.join(PROXY_DIR, 'telemetry.json');

const LOG_FILE        = '/home/ubuntu/logs/fbr-ai-proxy.log';
const TELEMETRY_LOG   = '/home/ubuntu/logs/fbr-telemetry.log';

// Telegram debounce — max 1 alert per hour
let lastTelegramAlert = 0;

// ── Logging ───────────────────────────────────────────────────────────────────
function log(level, msg, file) {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(file || LOG_FILE, line); } catch (_) {}
}

// ── License store (atomic JSON file) ─────────────────────────────────────────
function loadLicenses() {
  try {
    const raw = fs.readFileSync(LICENSES_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function saveLicenses(data) {
  const tmp = LICENSES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, LICENSES_FILE);
}

// Only accept genuine UUIDv4 license ids — rejects test/backdoor strings before any lookup.
const FBR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function getLicense(uuid) {
  if (!uuid || !FBR_UUID_RE.test(uuid)) return null;
  const store = loadLicenses();
  return store[uuid] || null;
}

function isLicensePaid(rec) {
  if (!rec || !rec.paid) return false;
  if (!rec.periodEnd) return false;
  return new Date(rec.periodEnd) > new Date();
}

function setLicense(uuid, record) {
  const store = loadLicenses();
  store[uuid] = { ...record, updatedAt: new Date().toISOString() };
  saveLicenses(store);
}

// ── Subscription helpers (events are the source of truth — no Stripe secret key) ──
// Pull plan/period/paid straight off a Stripe subscription object (from the webhook
// event payload), so we never need to call the Stripe API with a secret key.
function readSubFields(sub) {
  const status    = sub.status; // active, trialing, past_due, canceled, unpaid, ...
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;
  const interval  = sub.items?.data?.[0]?.price?.recurring?.interval;
  const plan      = interval === 'year' ? 'yearly' : 'monthly';
  const paid      = ['active', 'trialing'].includes(status);
  return { status, periodEnd, plan, paid };
}

// Apply subscription state to the license keyed by Stripe customer id.
// Returns true if a matching license was found & updated, false otherwise.
function applySubToLicense(custId, fields) {
  const store = loadLicenses();
  const entry = Object.entries(store).find(([, v]) => v.stripeCustomer === custId);
  if (!entry) return false;
  const [uuid, rec] = entry;
  store[uuid] = {
    ...rec,
    paid:      fields.paid,
    plan:      fields.plan,
    periodEnd: fields.periodEnd || rec.periodEnd,
    updatedAt: new Date().toISOString(),
  };
  saveLicenses(store);
  log('INFO', `License sync: uuid=${uuid.slice(0,8)}... status=${fields.status} paid=${fields.paid} until=${fields.periodEnd}`);
  return true;
}

// Pending buffer — if a subscription.* event arrives BEFORE checkout.session.completed
// (Stripe does not guarantee order), we stash the period/plan by customer id and apply
// it the moment the checkout event links that customer to a license UUID. Persisted so
// it survives a restart in the seconds between the two events.
const PENDING_FILE = path.join(PROXY_DIR, 'pending-subs.json');
function loadPending() {
  try { return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch (_) { return {}; }
}
function savePending(data) {
  const tmp = PENDING_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, PENDING_FILE);
}
function bufferPendingSub(custId, fields) {
  const p = loadPending();
  p[custId] = { ...fields, bufferedAt: new Date().toISOString() };
  savePending(p);
}
function takePendingSub(custId) {
  const p = loadPending();
  const f = p[custId];
  if (f) { delete p[custId]; savePending(p); }
  return f || null;
}

// ── Rate-limit state ──────────────────────────────────────────────────────────
const ipCounts = new Map();
let globalDayKey   = todayKey();
let globalDayCount = 0;

function todayKey() { return new Date().toISOString().slice(0, 10); }

function checkRateLimit(ip) {
  const day = todayKey();
  if (day !== globalDayKey) { globalDayKey = day; globalDayCount = 0; }
  if (globalDayCount >= GLOBAL_DAILY_CAP)
    return { ok: false, reason: 'Global daily cap reached' };

  const hour = new Date().getUTCHours();
  let slot = ipCounts.get(ip);
  if (!slot || slot.hour !== hour) { slot = { hour, count: 0 }; ipCounts.set(ip, slot); }
  if (slot.count >= IP_HOURLY_CAP)
    return { ok: false, reason: 'Per-IP hourly limit reached' };

  slot.count++;
  globalDayCount++;
  return { ok: true };
}

// ── Default system prompt ─────────────────────────────────────────────────────
const DEFAULT_SYSTEM_PROMPT =
  "You are the CBD Marketplace Pro, a specialist in crafting succinct, compelling, human-sounding ads for Facebook Marketplace, tailored for quick sales in Sydney. Persona: efficient, trustworthy, concise copywriter using Australian spelling. Given an item's brand/model/details and photo, produce: 2-3 keyword-rich title options; an engaging 1-2 paragraph description (open with what it is + appeal, then key features/benefits, then condition honestly). Always end the description with 'Pickup: Sydney CBD (near Central Station).' and 'Payment: Cash only.' on separate lines. No 'no scammers/time wasters' phrases, no corporate fluff.";

// ── Gemini call ───────────────────────────────────────────────────────────────
async function callGemini({ title, price, currency, currentDescription, imageBase64, systemPrompt }) {
  if (!GEMINI_KEY) throw new Error('Server misconfiguration: no Gemini API key loaded');

  const sys  = systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const item = [
    `Brand/Title: ${title || '(unknown)'}`,
    `Price: ${currency || 'AUD'} ${price || ''}`,
    `Current description: ${currentDescription || '(none)'}`,
  ].join('\n');

  const instruction =
    'Respond ONLY with strict JSON: {"title":"...","description":"..."}. ' +
    'Use Australian spelling. ' +
    "Put 'Pickup: Sydney CBD (near Central Station).' and 'Payment: Cash only.' on their own lines at the end of description.";

  const fullText = `${sys}\n\n${item}\n\n${instruction}`;
  const parts = [{ text: fullText }];

  if (imageBase64) {
    const imgData = typeof imageBase64 === 'string'
      ? { mime_type: 'image/jpeg', data: imageBase64 }
      : imageBase64;
    parts.push({ inline_data: imgData });
  }

  const body = JSON.stringify({ contents: [{ parts }] });
  const reqUrl = `${GEMINI_URL}?key=${GEMINI_KEY}`;

  const resp = await fetch(reqUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!resp.ok) {
    const text    = await resp.text().catch(() => '');
    const status  = resp.status;
    const snippet = text.slice(0, 400);

    if (status === 429 || text.includes('RESOURCE_EXHAUSTED')) {
      log('ERROR', `Gemini 429 RESOURCE_EXHAUSTED — key_slot=${KEY_SLOT}: ${snippet}`);
      const err = new Error('Gemini spend cap / rate limit (429)');
      err.geminiStatus = 429;
      err.userMessage  = 'AI temporarily unavailable — spend cap reached. Please try again later.';
      throw err;
    }
    if (status >= 500) {
      log('ERROR', `Gemini 5xx error — status=${status}: ${snippet}`);
      const err = new Error(`Gemini server error (${status})`);
      err.geminiStatus = status;
      err.userMessage  = 'AI temporarily unavailable — Gemini service error. Please try again later.';
      throw err;
    }
    log('WARN', `Gemini non-OK — status=${status}: ${snippet}`);
    throw new Error(`Gemini error ${status}: ${snippet.slice(0, 150)}`);
  }

  const json = await resp.json();
  const raw  = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!raw) throw new Error('Gemini returned empty response');

  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed;
  try { parsed = JSON.parse(stripped); }
  catch (_) { return { title: title || '', description: raw }; }

  return {
    title:       parsed.title       || title || '',
    description: parsed.description || '',
  };
}

// ── Stripe webhook verification (no SDK — pure crypto) ────────────────────────
function verifyStripeSignature(rawBody, sigHeader, secret) {
  // sigHeader: "t=1234567890,v1=abc123,v1=def456"
  if (!secret || !sigHeader) return null;

  const parts = {};
  for (const part of sigHeader.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') parts.t = v;
    if (k === 'v1') { parts.v1 = parts.v1 || []; parts.v1.push(v); }
  }
  if (!parts.t || !parts.v1) return null;

  // Reject stale webhooks (>5 min)
  const ts = parseInt(parts.t, 10);
  if (Math.abs(Date.now() / 1000 - ts) > 300) {
    log('WARN', `Stripe webhook timestamp too old: ${ts}`);
    return null;
  }

  const payload = `${parts.t}.${rawBody}`;
  const computed = crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('hex');

  const valid = parts.v1.some(sig => crypto.timingSafeEqual(
    Buffer.from(computed, 'hex'),
    Buffer.from(sig, 'hex'),
  ));

  if (!valid) return null;
  return JSON.parse(rawBody);
}

// ── Telegram alert ────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  const now = Date.now();
  if (now - lastTelegramAlert < 60 * 60 * 1000) return; // debounce 1hr
  lastTelegramAlert = now;

  try {
    const token = fs.readFileSync(TELEGRAM_TOKEN_FILE, 'utf8').trim();
    const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' });
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (e) {
    log('WARN', `Telegram alert failed: ${e.message}`);
  }
}

// ── Telemetry store ───────────────────────────────────────────────────────────
// Rolling window: track last 20 events
const TELEMETRY_WINDOW = 20;
const FAILURE_THRESHOLD_COUNT = 5;
const FAILURE_THRESHOLD_RATE  = 0.5; // 50%

function loadTelemetry() {
  try { return JSON.parse(fs.readFileSync(TELEMETRY_FILE, 'utf8')); }
  catch (_) { return { events: [] }; }
}

function saveTelemetry(data) {
  const tmp = TELEMETRY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, TELEMETRY_FILE);
}

async function handleTelemetry(payload) {
  const { t, ok, code } = payload;
  const entry = { t: t || 'relist', ok: !!ok, code: code || '', ts: new Date().toISOString() };
  log('INFO', `telemetry: t=${entry.t} ok=${entry.ok} code=${entry.code}`, TELEMETRY_LOG);

  const data = loadTelemetry();
  data.events = data.events || [];
  data.events.push(entry);

  // Keep rolling window
  if (data.events.length > TELEMETRY_WINDOW) {
    data.events = data.events.slice(-TELEMETRY_WINDOW);
  }

  saveTelemetry(data);

  // Check failure rate in the current window
  const window = data.events;
  const failures = window.filter(e => !e.ok);
  const failRate = failures.length / window.length;

  if (failures.length >= FAILURE_THRESHOLD_COUNT && failRate > FAILURE_THRESHOLD_RATE) {
    // Find most common code
    const codeCounts = {};
    for (const f of failures) codeCounts[f.code] = (codeCounts[f.code] || 0) + 1;
    const topCode = Object.entries(codeCounts).sort((a,b) => b[1]-a[1])[0];
    const pct = Math.round(failRate * 100);
    const msg = `⚠️ Relist breakage: ${pct}% of recent relists failing (code: ${topCode?.[0] || 'unknown'}) — FB may have changed.`;
    log('WARN', `Alert triggered: ${msg}`, TELEMETRY_LOG);
    await sendTelegram(msg);
  }
}

// ── GA4 event forward ─────────────────────────────────────────────────────────
async function forwardGA4(payload) {
  const { name, params, cid } = payload;
  if (!GA4_MEASUREMENT_ID || !GA4_API_SECRET) {
    log('INFO', `GA4 not configured — skipping event: ${name}`);
    return;
  }
  const body = JSON.stringify({
    client_id: cid || 'anonymous',
    events: [{ name: name || 'fbr_event', params: params || {} }],
  });
  try {
    const resp = await fetch(
      `https://www.google-analytics.com/mp/collect?measurement_id=${GA4_MEASUREMENT_ID}&api_secret=${GA4_API_SECRET}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }
    );
    log('INFO', `GA4 event ${name} → ${resp.status}`);
  } catch (e) {
    log('WARN', `GA4 forward failed: ${e.message}`);
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-FBR-License, X-FBR-Token',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

// ── Request handler ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url || '/', true);
  const pathname = parsed.pathname;
  const query = parsed.query;

  // CORS pre-flight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  // ── GET /api/health ───────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJSON(res, 200, { ok: true, slot: KEY_SLOT, model: GEMINI_MODEL, ts: new Date().toISOString() });
  }

  // ── GET /api/license?id=<uuid> ────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/license') {
    const id = query.id || '';
    const rec = getLicense(id);
    if (!rec) return sendJSON(res, 200, { paid: false, plan: null, periodEnd: null });
    return sendJSON(res, 200, {
      paid:      isLicensePaid(rec),
      plan:      rec.plan || null,
      periodEnd: rec.periodEnd || null,
    });
  }

  // ── POST /api/ai ──────────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/ai') {
    const licenseUuid = req.headers['x-fbr-license'] || '';

    if (!licenseUuid) {
      return sendJSON(res, 402, { error: 'pro_required', message: 'Pro subscription required. Get a license at relist.nowoly.com.' });
    }

    const rec = getLicense(licenseUuid);
    if (!rec || !isLicensePaid(rec)) {
      const ip = req.socket.remoteAddress || 'unknown';
      log('WARN', `License rejected: uuid=${licenseUuid.slice(0,8)}... ip=${ip}`);
      return sendJSON(res, 402, { error: 'pro_required', message: 'Invalid or expired license. Subscribe at relist.nowoly.com.' });
    }

    // Rate limit
    const ip = req.socket.remoteAddress || 'unknown';
    const rl = checkRateLimit(ip);
    if (!rl.ok) {
      log('WARN', `Rate limited: ${ip} — ${rl.reason}`);
      return sendJSON(res, 429, { error: rl.reason });
    }

    const rawBody = await readBody(req);
    let payload;
    try { payload = JSON.parse(rawBody); }
    catch (_) { return sendJSON(res, 400, { error: 'Invalid JSON body' }); }

    const { title, price, currency, currentDescription, imageBase64, systemPrompt } = payload;
    if (!title && !currentDescription) {
      return sendJSON(res, 400, { error: 'Provide at least title or currentDescription' });
    }

    const t0 = Date.now();
    log('INFO', `AI request: uuid=${licenseUuid.slice(0,8)}... ip=${ip} title="${String(title||'').slice(0,50)}"`);

    try {
      const result = await callGemini({ title, price, currency, currentDescription, imageBase64, systemPrompt });
      const ms = Date.now() - t0;
      log('INFO', `AI ok in ${ms}ms — title="${String(result.title||'').slice(0,50)}"`);
      return sendJSON(res, 200, result);
    } catch (err) {
      const ms = Date.now() - t0;
      log('ERROR', `AI failed in ${ms}ms — ${err.message}`);
      if (err.geminiStatus === 429)
        return sendJSON(res, 503, { error: err.userMessage || 'AI temporarily unavailable (spend cap).' });
      if (err.geminiStatus >= 500)
        return sendJSON(res, 503, { error: err.userMessage || 'AI temporarily unavailable (Gemini error).' });
      return sendJSON(res, 500, { error: `AI error: ${err.message}` });
    }
  }

  // ── POST /api/stripe-webhook ──────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/stripe-webhook') {
    const rawBody = await readBody(req);
    const sigHeader = req.headers['stripe-signature'] || '';

    const event = verifyStripeSignature(rawBody, sigHeader, STRIPE_WEBHOOK_SECRET);
    if (!event) {
      log('WARN', 'Stripe webhook signature verification failed');
      return sendJSON(res, 400, { error: 'Invalid signature' });
    }

    log('INFO', `Stripe event: ${event.type}`);

    try {
      if (event.type === 'checkout.session.completed') {
        // The ONLY event carrying our extension UUID (client_reference_id). Link the
        // Stripe customer ↔ license UUID here; period/plan come from subscription.* events.
        const session = event.data.object;
        const uuid    = session.client_reference_id;  // extension UUID
        const custId  = session.customer;
        const subId   = session.subscription;

        if (!uuid) {
          log('WARN', 'checkout.session.completed missing client_reference_id — skipping');
          return sendJSON(res, 200, { received: true });
        }

        // If a subscription.* event already arrived for this customer, use its accurate
        // period/plan. Otherwise grant a 2-day grace that the imminent subscription.created
        // event will correct — covers the worst-case ordering with no Stripe API call.
        const pending  = takePendingSub(custId);
        const periodEnd = pending?.periodEnd
          || new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
        const plan      = pending?.plan || 'monthly';
        const paid      = pending ? pending.paid : true;

        setLicense(uuid, {
          paid,
          plan,
          periodEnd,
          stripeCustomer: custId,
          stripeSubId:    subId,
        });
        log('INFO', `License activated: uuid=${uuid.slice(0,8)}... customer=${custId} plan=${plan} until=${periodEnd}${pending ? ' (from buffered sub)' : ' (grace, awaiting sub event)'}`);
      }

      // created + updated share one path — both carry the authoritative period_end/status.
      else if (event.type === 'customer.subscription.created' ||
               event.type === 'customer.subscription.updated') {
        const sub    = event.data.object;
        const custId = sub.customer;
        const fields = readSubFields(sub);

        // Match by customer; if checkout hasn't linked the UUID yet, buffer for it to apply.
        if (!applySubToLicense(custId, fields)) {
          bufferPendingSub(custId, fields);
          log('INFO', `subscription.${event.type.split('.').pop()}: no license yet for ${custId} — buffered (status=${fields.status})`);
        }
      }

      else if (event.type === 'customer.subscription.deleted') {
        const sub    = event.data.object;
        const custId = sub.customer;
        // Immediate downgrade to free.
        if (!applySubToLicense(custId, { paid: false, plan: 'monthly', periodEnd: new Date().toISOString(), status: 'canceled' })) {
          log('WARN', `subscription.deleted: no license found for customer ${custId}`);
        } else {
          log('INFO', `Subscription cancelled → free: customer=${custId}`);
        }
      }
    } catch (e) {
      log('ERROR', `Stripe webhook handler error: ${e.message}`);
      return sendJSON(res, 500, { error: 'Webhook handler error' });
    }

    return sendJSON(res, 200, { received: true });
  }

  // ── POST /api/telemetry ───────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/telemetry') {
    const rawBody = await readBody(req);
    let payload;
    try { payload = JSON.parse(rawBody); }
    catch (_) { payload = {}; }

    await handleTelemetry(payload);
    return sendJSON(res, 204, {});
  }

  // ── POST /api/event ───────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/event') {
    const rawBody = await readBody(req);
    let payload;
    try { payload = JSON.parse(rawBody); }
    catch (_) { payload = {}; }

    await forwardGA4(payload);
    return sendJSON(res, 204, {});
  }

  return sendJSON(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  log('INFO', `fbr-ai-proxy started — ${HOST}:${PORT} — model=${GEMINI_MODEL} key_slot=${KEY_SLOT}`);
  if (!GEMINI_KEY) log('WARN', `GEMINI_KEY is EMPTY — check POY_GEMINI_API_KEY_${KEY_SLOT} in /home/ubuntu/.env`);
  if (!STRIPE_WEBHOOK_SECRET) log('WARN', 'FBR_STRIPE_WEBHOOK_SECRET not set — webhook verification will reject all events');
});

process.on('uncaughtException',  err    => log('ERROR', `Uncaught exception: ${err.message}`));
process.on('unhandledRejection', reason => log('ERROR', `Unhandled rejection: ${reason}`));

/**
 * fbr-ai-proxy — Cloudflare Worker edition
 * Replicates proxy/server.js logic exactly (same auth, same Gemini call, same responses).
 *
 * Required secrets (set via wrangler secret put):
 *   GEMINI_KEY   — Gemini API key (use POY_GEMINI_API_KEY_FREE for free tier)
 *   FBR_TOKEN    — Shared token for X-FBR-Token header (same value as in extension)
 *
 * TO SWAP TO PAID KEY LATER:
 *   wrangler secret put GEMINI_KEY
 *   (paste the POY_GEMINI_API_KEY_PAID value when prompted)
 *   wrangler deploy  ← redeploy to pick up the new secret
 *
 * Routes:   relist.nowoly.com/api/*  (zone: nowoly.com)
 * Health:   GET  /api/health  → {"ok":true,"via":"cf-worker","model":"gemini-flash-lite-latest"}
 * Main:     POST /api/ai      → {"title":"...","description":"..."}
 */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────────
const GEMINI_MODEL = 'gemini-flash-lite-latest';
const GEMINI_BASE  = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_URL   = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent`;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-FBR-Token',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

// ── Default system prompt (mirrors ai.js) ─────────────────────────────────────
const DEFAULT_SYSTEM_PROMPT =
  "You are the CBD Marketplace Pro, a specialist in crafting succinct, compelling, human-sounding ads for Facebook Marketplace, tailored for quick sales in Sydney. Persona: efficient, trustworthy, concise copywriter using Australian spelling. Given an item's brand/model/details and photo, produce: 2-3 keyword-rich title options; an engaging 1-2 paragraph description (open with what it is + appeal, then key features/benefits, then condition honestly). Always end the description with 'Pickup: Sydney CBD (near Central Station).' and 'Payment: Cash only.' on separate lines. No 'no scammers/time wasters' phrases, no corporate fluff.";

// ── JSON response helper ───────────────────────────────────────────────────────
function jsonResp(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ── Gemini call ───────────────────────────────────────────────────────────────
async function callGemini({ title, price, currency, currentDescription, imageBase64, systemPrompt }, geminiKey) {
  if (!geminiKey) throw new Error('Server misconfiguration: no Gemini API key loaded');

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
    // imageBase64 may be a plain base64 string or {mime_type, data}
    const imgData = typeof imageBase64 === 'string'
      ? { mime_type: 'image/jpeg', data: imageBase64 }
      : imageBase64;
    parts.push({ inline_data: imgData });
  }

  const body = JSON.stringify({ contents: [{ parts }] });
  const url  = `${GEMINI_URL}?key=${geminiKey}`;

  const resp = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!resp.ok) {
    const text    = await resp.text().catch(() => '');
    const status  = resp.status;
    const snippet = text.slice(0, 400);

    // 429 / RESOURCE_EXHAUSTED → spend cap or rate limit
    if (status === 429 || text.includes('RESOURCE_EXHAUSTED')) {
      const err = new Error('Gemini spend cap / rate limit (429)');
      err.geminiStatus = 429;
      err.userMessage  = 'AI temporarily unavailable — spend cap reached. Please try again later.';
      throw err;
    }

    // 5xx server errors
    if (status >= 500) {
      const err = new Error(`Gemini server error (${status})`);
      err.geminiStatus = status;
      err.userMessage  = 'AI temporarily unavailable — Gemini service error. Please try again later.';
      throw err;
    }

    // Other non-OK (4xx etc.)
    throw new Error(`Gemini error ${status}: ${snippet.slice(0, 150)}`);
  }

  const json = await resp.json();
  const raw  = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!raw) throw new Error('Gemini returned empty response');

  // Strip markdown fences if present (mirrors ai.js)
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (_) {
    // Non-JSON fallback — return raw as description
    return { title: title || '', description: raw };
  }

  return {
    title:       parsed.title       || title || '',
    description: parsed.description || '',
  };
}

// ── Main fetch handler ────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    // CORS pre-flight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health check (no auth required)
    if (method === 'GET' && path === '/api/health') {
      return jsonResp(200, { ok: true, via: 'cf-worker', model: GEMINI_MODEL });
    }

    // Only accept POST /api/ai
    if (method !== 'POST' || path !== '/api/ai') {
      return jsonResp(404, { error: 'Not found' });
    }

    // ── Auth: shared token (obfuscation layer) ──────────────────────────────
    const token = request.headers.get('x-fbr-token');
    if (!token || token !== env.FBR_TOKEN) {
      return jsonResp(401, { error: 'Unauthorized — missing or invalid X-FBR-Token' });
    }

    // ── Parse JSON body ─────────────────────────────────────────────────────
    let payload;
    try {
      payload = await request.json();
    } catch (_) {
      return jsonResp(400, { error: 'Invalid JSON body' });
    }

    const { title, price, currency, currentDescription, imageBase64, systemPrompt } = payload || {};

    if (!title && !currentDescription) {
      return jsonResp(400, { error: 'Provide at least title or currentDescription' });
    }

    // ── Call Gemini ─────────────────────────────────────────────────────────
    try {
      const result = await callGemini(
        { title, price, currency, currentDescription, imageBase64, systemPrompt },
        env.GEMINI_KEY
      );
      return jsonResp(200, result);
    } catch (err) {
      if (err.geminiStatus === 429) {
        return jsonResp(503, { error: err.userMessage || 'AI temporarily unavailable (spend cap).' });
      }
      if (err.geminiStatus >= 500) {
        return jsonResp(503, { error: err.userMessage || 'AI temporarily unavailable (Gemini error).' });
      }
      return jsonResp(500, { error: `AI error: ${err.message}` });
    }
  },
};

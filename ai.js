/**
 * ai.js — Gemini AI module for FB Marketplace Relister
 * Loaded in the background service worker via importScripts('ai.js')
 * Defines:
 *   self.generateListingCopy(item, settings)       — BYO Gemini key (Advanced / fallback)
 *   self.generateListingCopyViaProxy(item, settings) — provided AI via relist.nowoly.com proxy (Pro default)
 */

// Provided-AI proxy (Pro default — no user API key required)
const FBR_PROXY_URL = 'https://relist.nowoly.com/api/ai';

/**
 * generateListingCopyViaProxy — calls the FBR proxy (Gemini Flash-Lite hosted by x-online).
 * Pro users call this by default; no user API key needed.
 *
 * @param {Object} item      — { title, photoUrls, currentDescription, price, currency }
 * @param {Object} settings  — fbr_settings (aiSystemPrompt used if set)
 * @returns {Promise<{description: string, titleSuggestion: string}>}
 */
self.generateListingCopyViaProxy = async function generateListingCopyViaProxy(item, settings) {
  // Optionally attach first image as base64 (proxy forwards to Gemini)
  let imageBase64 = null;
  if (item.photoUrls && item.photoUrls[0]) {
    const imgData = await fetchImageAsBase64(item.photoUrls[0]);
    if (imgData) imageBase64 = imgData; // {mime_type, data}
  }

  const body = {
    title:              item.title              || '',
    price:              item.price              || '',
    currency:           item.currency           || 'AUD',
    currentDescription: item.currentDescription || '',
    systemPrompt:       (settings && settings.aiSystemPrompt) || '',
  };
  if (imageBase64) body.imageBase64 = imageBase64;

  // getLicenseUUID() is defined in background.js (hoisted function declaration)
  // and available here since ai.js runs in the same SW scope.
  const uuid = await getLicenseUUID();

  let resp;
  try {
    resp = await fetch(FBR_PROXY_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'X-FBR-License': uuid,
      },
      body: JSON.stringify(body),
    });
  } catch (networkErr) {
    throw new Error(`FBR proxy network error: ${networkErr.message}`);
  }

  if (!resp.ok) {
    if (resp.status === 402) {
      throw new Error('AI requires Pro — upgrade to enable AI-enhanced relisting');
    }
    let errMsg = `FBR proxy error ${resp.status}`;
    try {
      const errBody = await resp.json();
      if (errBody.error) errMsg = errBody.error;
    } catch (_) {}
    throw new Error(errMsg);
  }

  const result = await resp.json();
  return {
    description:      result.description || '',
    titleSuggestion:  result.title       || '',
  };
};

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Fetch an image URL and return base64-encoded data with mime_type.
 * Returns null if the fetch fails (caller proceeds text-only).
 */
async function fetchImageAsBase64(url) {
  try {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) return null;
    const contentType = resp.headers.get('content-type') || 'image/jpeg';
    const mime_type = contentType.split(';')[0].trim();
    const buffer = await resp.arrayBuffer();
    // Convert ArrayBuffer → base64 string
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const data = btoa(binary);
    return { mime_type, data };
  } catch (_) {
    return null;
  }
}

/**
 * generateListingCopy — calls Gemini to produce listing copy for an FB Marketplace item.
 *
 * @param {Object} item
 *   @param {string} item.title
 *   @param {string[]} item.photoUrls
 *   @param {string} item.currentDescription
 *   @param {number|string} item.price
 *   @param {string} item.currency
 * @param {Object} settings  — fbr_settings object (must include geminiApiKey, geminiModel, aiSystemPrompt)
 * @returns {Promise<{description: string, titleSuggestion: string}>}
 */
self.generateListingCopy = async function generateListingCopy(item, settings) {
  const { geminiApiKey, geminiModel, aiSystemPrompt } = settings || {};

  if (!geminiApiKey) {
    throw new Error('No Gemini API key set (Options)');
  }

  const model = geminiModel || 'gemini-2.5-flash';
  const systemPrompt = aiSystemPrompt || '';

  // Build the text prompt
  const itemBlock = [
    `Brand/Title: ${item.title || '(unknown)'}`,
    `Price: ${item.currency || 'AUD'} ${item.price || ''}`,
    `Current description: ${item.currentDescription || '(none)'}`,
  ].join('\n');

  const instruction = [
    'Respond ONLY with strict JSON: {"title":"...","description":"..."}.',
    'Use Australian spelling.',
    "Put 'Pickup: Sydney CBD (near Central Station).' and 'Payment: Cash only.' on their own lines at the end of description.",
  ].join(' ');

  const fullText = `${systemPrompt}\n\n${itemBlock}\n\n${instruction}`;

  // Build the parts array — start with text
  const parts = [{ text: fullText }];

  // Vision: add photo if available
  if (item.photoUrls && item.photoUrls[0]) {
    const imageData = await fetchImageAsBase64(item.photoUrls[0]);
    if (imageData) {
      parts.push({ inline_data: imageData });
    }
  }

  const requestBody = {
    contents: [{ parts }],
  };

  const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent?key=${geminiApiKey}`;

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
  } catch (networkErr) {
    throw new Error(`Gemini network error: ${networkErr.message}`);
  }

  if (!resp.ok) {
    let bodySnippet = '';
    try {
      const bodyText = await resp.text();
      bodySnippet = bodyText.slice(0, 300);
    } catch (_) {}
    throw new Error(`Gemini API error ${resp.status}: ${bodySnippet}`);
  }

  let responseJson;
  try {
    responseJson = await resp.json();
  } catch (_) {
    throw new Error('Gemini returned non-JSON response');
  }

  const rawText =
    responseJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  if (!rawText) {
    throw new Error('Gemini returned an empty response');
  }

  // Strip ```json ... ``` fences if present
  const stripped = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (_) {
    // Fallback: return raw text as description
    return {
      description: rawText,
      titleSuggestion: '',
    };
  }

  return {
    description: parsed.description || '',
    titleSuggestion: parsed.title || '',
  };
};

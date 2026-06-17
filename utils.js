// utils.js — Shared utilities for FB Marketplace Relister

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const SHORT  = () => 500  + Math.random() * 500;
const MEDIUM = () => 1000 + Math.random() * 1000;
const LONG   = () => 2500 + Math.random() * 1500;

async function scrollAndClick(el) {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(300 + Math.random() * 200);
  el.click();
}

function spanTextFinder(fieldName, tagName = 'input') {
  const spans = Array.from(document.querySelectorAll('span'));
  const matchSpan = spans.find(s => s.textContent.trim() === fieldName);
  if (!matchSpan) return null;

  let node = matchSpan;
  for (let i = 0; i < 6; i++) {
    node = node.parentElement;
    if (!node) break;
    const found = node.querySelector(tagName);
    if (found) return found;
  }
  return null;
}

function nativeSetInput(inputEl, value) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  ).set;
  nativeSetter.call(inputEl, value);
  inputEl.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
  inputEl.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
}

function nativeSetTextarea(textareaEl, value) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  ).set;
  nativeSetter.call(textareaEl, value);
  textareaEl.dispatchEvent(new Event('input',  { bubbles: true }));
  textareaEl.dispatchEvent(new Event('change', { bubbles: true }));
}

async function typeSlowly(el, text) {
  el.focus();
  for (const char of text) {
    const current = el.value;
    if (el.tagName === 'TEXTAREA') {
      nativeSetTextarea(el, current + char);
    } else {
      nativeSetInput(el, current + char);
    }
    await sleep(20 + Math.random() * 50);
  }
}

async function waitForElement(selector, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const el = document.querySelector(selector);
    if (el) return el;
    await sleep(200);
  }
  return null;
}

async function waitForElementGone(selector, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const el = document.querySelector(selector);
    if (!el) return true;
    await sleep(200);
  }
  return false;
}

function findRoleOption(optionText) {
  const options = Array.from(document.querySelectorAll('div[role="option"]'));
  return options.find(
    o => o.textContent.trim().toLowerCase() === optionText.trim().toLowerCase()
  ) || null;
}

function setStatus(message) {
  chrome.storage.local.set({ status: message, statusTime: Date.now() });
}

function setProgress(done, total) {
  chrome.storage.local.set({ progressDone: done, progressTotal: total });
}

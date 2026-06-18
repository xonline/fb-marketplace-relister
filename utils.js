// utils.js — Shared utilities (v2.1.0 — form-filling helpers removed)

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function setStatus(message) {
  chrome.storage.local.set({ status: message, statusTime: Date.now() });
}

function setProgress(done, total) {
  chrome.storage.local.set({ progressDone: done, progressTotal: total });
}

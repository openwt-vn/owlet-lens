'use strict';

const undici = require('undici');

// Node's built-in global fetch ships its own undici. Passing it a dispatcher built from the bundled
// undici package breaks on Node 26 ("invalid onError method"), so LLM calls use the bundled fetch and
// the bundled Agent together. A fetch that someone replaced on globalThis (tests, instrumentation) is
// still honoured.
const NATIVE_FETCH = globalThis.fetch;
const DEFAULT_FETCH_TIMEOUT_MS = 10 * 60 * 1000;
const FETCH_DISPATCHERS = new Map();

function getFetchTimeoutMs(env = process.env) {
  const parsed = Number(env.AI_REVIEW_LLM_TIMEOUT_MS);
  if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
  return DEFAULT_FETCH_TIMEOUT_MS;
}

function getFetchDispatcher(timeoutMs) {
  if (!FETCH_DISPATCHERS.has(timeoutMs)) {
    FETCH_DISPATCHERS.set(timeoutMs, new undici.Agent({
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    }));
  }
  return FETCH_DISPATCHERS.get(timeoutMs);
}

/**
 * fetch for LLM calls: bundled undici fetch + dispatcher with headers/body timeouts.
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 */
function llmFetch(url, init, timeoutMs) {
  if (globalThis.fetch !== NATIVE_FETCH) {
    return globalThis.fetch(url, { ...init, dispatcher: getFetchDispatcher(timeoutMs) });
  }
  return undici.fetch(url, { ...init, dispatcher: getFetchDispatcher(timeoutMs) });
}

module.exports = { DEFAULT_FETCH_TIMEOUT_MS, getFetchTimeoutMs, getFetchDispatcher, llmFetch };

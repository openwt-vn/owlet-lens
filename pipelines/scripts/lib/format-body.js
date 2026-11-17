// @ts-check
'use strict';

const { CONFIG } = require('./config.js');
const { VALID_CONFIDENCES } = require('./finding-validator.js');

const CONFIDENCE_NOTE_RE = / _\(confidence: (?:HIGH|MEDIUM|LOW)\)_/;

/**
 * Removes the confidence note from a posted comment body so text matching
 * (fuzzy dedup) sees the same text as before the note existed.
 *
 * @param {string} body
 * @returns {string}
 */
function stripConfidenceNote(body) {
  return typeof body === 'string' ? body.replace(CONFIDENCE_NOTE_RE, '') : body;
}

/**
 * Build the Markdown body for a review finding comment.
 * Appends a GitHub suggestion block when the suggestion is valid
 * and the provider is GitHub.
 *
 * @param {{ filePath?: string, severity?: string, category?: string, body: string, suggestion?: string | null }} f
 * @param {string} providerName
 * @returns {string}
 */
function formatBody(f, providerName) {
  const confidence = VALID_CONFIDENCES.has(f.confidence) ? ` _(confidence: ${f.confidence})_` : '';
  let body = `${CONFIG.aiReviewPrefix} **[${f.severity ?? 'UNKNOWN'}/${f.category ?? 'unknown'}]**${confidence} ${f.body}`;
  // Keep the leading indentation: a suggestion block replaces the whole line, so
  // stripping it would make "Apply suggestion" de-indent the code. Only blank
  // lines at the start and any trailing whitespace are removed.
  const raw = typeof f.suggestion === 'string' ? f.suggestion : '';
  const s = raw.trim() ? raw.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd() : '';
  if (s) {
    if (!s.includes('\n') && !s.includes('```') && providerName === 'github') {
      body += `\n\n\`\`\`suggestion\n${s}\n\`\`\``;
    } else {
      process.stderr.write(JSON.stringify({ level: 'debug', msg: 'suggestion.dropped', file: f.filePath, provider: providerName }) + '\n');
    }
  }
  return body;
}

module.exports = { formatBody, stripConfidenceNote };

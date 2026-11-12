// @ts-check
'use strict';

const {
  SIZE_ADVISORY_KEY,
  evaluateSizeAdvisory,
  buildSizeAdvisoryBody,
} = require('../size-advisory.js');

/**
 * Sync the sticky PR-size advisory comment (ADR-0018).
 *
 * - Limits exceeded → upsert `size-advisory` comment.
 * - Limits clear (and advisory config is active, or a stale comment exists) → delete.
 * - Every limit null and no existing comment → noop.
 *
 * @param {{
 *   upsertSummaryComment(key: string, body: string): Promise<{ id: string, action: 'created'|'updated' }>,
 *   findBotComment(key: string): Promise<{ id: string }|null>,
 *   deleteBotComment(key: string): Promise<{ id: string, action: 'deleted'|'absent' }>,
 *   renderSummaryMarker?: (key?: string) => string,
 * }} provider
 * @param {{ path: string, patch?: string }[]} diffs
 * @param {{
 *   review: {
 *     maxFiles?: number|null,
 *     maxChangedLines?: number|null,
 *     maxChangedLinesPerFile?: number|null,
 *     skipGeneratedFiles?: boolean,
 *   },
 *   excludePaths?: string[],
 *   dryRun?: boolean,
 * }} opts
 * @returns {Promise<{
 *   action: 'created'|'updated'|'deleted'|'absent'|'noop'|'would-upsert'|'would-delete',
 *   evaluation: import('../size-advisory.js').SizeAdvisoryResult,
 *   id?: string,
 * }>}
 */
async function sync(provider, diffs, opts) {
  const evaluation = evaluateSizeAdvisory(diffs, opts.review, opts.excludePaths ?? []);
  const dryRun = !!opts.dryRun;

  if (evaluation.exceeded) {
    const marker = typeof provider.renderSummaryMarker === 'function'
      ? provider.renderSummaryMarker(SIZE_ADVISORY_KEY)
      : `<!-- ai-review:v1:${SIZE_ADVISORY_KEY} -->`;
    const body = buildSizeAdvisoryBody({
      metrics: evaluation.metrics,
      breaches: evaluation.breaches,
      marker,
    });
    if (dryRun) return { action: 'would-upsert', evaluation };
    const r = await provider.upsertSummaryComment(SIZE_ADVISORY_KEY, body);
    return { action: r.action, id: r.id, evaluation };
  }

  // Not exceeded: delete a leftover advisory when present. Incomplete test
  // doubles without find/delete are treated as noop (production providers
  // always implement both).
  if (dryRun) {
    if (typeof provider.findBotComment !== 'function') {
      return { action: 'noop', evaluation };
    }
    const existing = await provider.findBotComment(SIZE_ADVISORY_KEY);
    return { action: existing ? 'would-delete' : 'noop', evaluation };
  }

  if (typeof provider.deleteBotComment !== 'function') {
    return { action: 'noop', evaluation };
  }
  const deleted = await provider.deleteBotComment(SIZE_ADVISORY_KEY);
  if (deleted.action === 'deleted') {
    return { action: 'deleted', id: deleted.id, evaluation };
  }
  return { action: 'noop', evaluation };
}

/** Compact dry-run / result fields for the review JSON line. */
function toResultFields(syncResult) {
  const { action, evaluation } = syncResult;
  return {
    sizeAdvisoryAction: action,
    sizeAdvisory: {
      exceeded: evaluation.exceeded,
      breaches: evaluation.breaches,
      metrics: {
        files: evaluation.metrics.files,
        changedLines: evaluation.metrics.changedLines,
      },
    },
  };
}

function wroteAction(action) {
  return action === 'created' || action === 'updated' || action === 'deleted';
}

module.exports = { sync, toResultFields, wroteAction, SIZE_ADVISORY_KEY };

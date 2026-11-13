// @ts-check
'use strict';

const sizeAdvisoryPort = require('./port/size-advisory-port.js');

/**
 * Emit the existing --dry-run stdout JSON (shape unchanged for product/CI).
 *
 * @param {{
 *   provider: import('./providers/provider.types.js').IReviewProvider,
 *   providerName: string,
 *   meta: { id: string|number },
 *   diffs: unknown[],
 *   plan: {
 *     toPost: unknown[],
 *     toReply: unknown[],
 *     toReopen: unknown[],
 *     toClose: unknown[],
 *   },
 *   review: any,
 *   excludePaths?: string[],
 *   stats: { dismissedCount: number },
 *   costUsd: number,
 *   durationMs: number,
 *   strict: { triggered?: boolean },
 *   stdout?: { write: (s: string) => unknown },
 * }} opts
 * @returns {Promise<number>}
 */
async function emitDryRunResult(opts) {
  const project = (a) => a.map((f) => ({
    filePath: f.filePath ?? f.finding?.filePath,
    line: f.line ?? f.finding?.line,
    severity: f.severity ?? f.finding?.severity,
    category: f.category ?? f.finding?.category,
    ruleId: f.ruleId ?? f.finding?.ruleId,
  }));
  const sizeDry = await sizeAdvisoryPort.sync(opts.provider, opts.diffs, {
    review: opts.review, excludePaths: opts.excludePaths, dryRun: true,
  });
  const out = opts.stdout ?? process.stdout;
  out.write(JSON.stringify({
    dryRun: true,
    provider: opts.providerName,
    prId: opts.meta.id,
    wouldPost: project(opts.plan.toPost),
    wouldReply: project(opts.plan.toReply),
    wouldReopen: project(opts.plan.toReopen),
    wouldClose: project(opts.plan.toClose),
    summaryAction: 'would-create',
    ...sizeAdvisoryPort.toResultFields(sizeDry),
    costUsd: opts.costUsd, durationMs: opts.durationMs,
    dismissedContext: { count: opts.stats.dismissedCount },
    strict: opts.strict,
  }) + '\n');
  return opts.strict?.triggered ? 8 : 0;
}

module.exports = { emitDryRunResult };

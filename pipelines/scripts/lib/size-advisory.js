// @ts-check
'use strict';

const { partitionByExclude } = require('./path-exclude-filter.js');
const { partitionBoilerplate } = require('./noise-filter.js');
const { CONFIG } = require('./config.js');

/** Sticky PR comment key for the PR-size advisory (ADR-0018). */
const SIZE_ADVISORY_KEY = 'size-advisory';

/**
 * Count added + removed lines in a unified-diff patch (not context, not
 * `---`/`+++` file headers). Matches the churn sense used for prompt
 * prioritization without requiring annotated form.
 *
 * @param {string|null|undefined} patch
 * @returns {number}
 */
function countChangedLines(patch) {
  if (typeof patch !== 'string' || !patch) return 0;
  let n = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+') || line.startsWith('-')) n += 1;
  }
  return n;
}

/**
 * Files counted for PR-size advisory: after exclude + boilerplate, and
 * deliberately *not* filtered by maxFileBytes (ADR-0018).
 *
 * @template {{ path: string, patch?: string }} T
 * @param {T[]} diffs
 * @param {{ skipGeneratedFiles?: boolean }} review
 * @param {string[]} [excludePaths]
 * @returns {T[]}
 */
function advisorySet(diffs, review, excludePaths) {
  const { kept: afterExclude } = partitionByExclude(diffs, excludePaths ?? []);
  const { kept } = partitionBoilerplate(afterExclude, review.skipGeneratedFiles !== false);
  return kept;
}

/**
 * @typedef {{ kind: 'maxFiles', actual: number, limit: number }
 *   | { kind: 'maxChangedLines', actual: number, limit: number }
 *   | { kind: 'maxChangedLinesPerFile', path: string, actual: number, limit: number }} SizeBreach
 *
 * @typedef {{
 *   active: boolean,
 *   exceeded: boolean,
 *   breaches: SizeBreach[],
 *   metrics: { files: number, changedLines: number, perFile: { path: string, changedLines: number }[] },
 * }} SizeAdvisoryResult
 */

/**
 * Evaluate optional PR-size limits against the advisory set.
 *
 * @param {{ path: string, patch?: string }[]} diffs
 * @param {{
 *   maxFiles?: number|null,
 *   maxChangedLines?: number|null,
 *   maxChangedLinesPerFile?: number|null,
 *   skipGeneratedFiles?: boolean,
 * }} review
 * @param {string[]} [excludePaths]
 * @returns {SizeAdvisoryResult}
 */
function evaluateSizeAdvisory(diffs, review, excludePaths) {
  const maxFiles = review.maxFiles ?? null;
  const maxChangedLines = review.maxChangedLines ?? null;
  const maxChangedLinesPerFile = review.maxChangedLinesPerFile ?? null;
  const active = maxFiles != null || maxChangedLines != null || maxChangedLinesPerFile != null;

  const set = advisorySet(diffs, review, excludePaths);
  const perFile = set.map((d) => ({ path: d.path, changedLines: countChangedLines(d.patch) }));
  const files = perFile.length;
  const changedLines = perFile.reduce((sum, f) => sum + f.changedLines, 0);
  const metrics = { files, changedLines, perFile };

  if (!active) {
    return { active: false, exceeded: false, breaches: [], metrics };
  }

  /** @type {SizeBreach[]} */
  const breaches = [];
  if (maxFiles != null && files > maxFiles) {
    breaches.push({ kind: 'maxFiles', actual: files, limit: maxFiles });
  }
  if (maxChangedLines != null && changedLines > maxChangedLines) {
    breaches.push({ kind: 'maxChangedLines', actual: changedLines, limit: maxChangedLines });
  }
  if (maxChangedLinesPerFile != null) {
    for (const f of perFile) {
      if (f.changedLines > maxChangedLinesPerFile) {
        breaches.push({
          kind: 'maxChangedLinesPerFile',
          path: f.path,
          actual: f.changedLines,
          limit: maxChangedLinesPerFile,
        });
      }
    }
  }

  return { active: true, exceeded: breaches.length > 0, breaches, metrics };
}

/**
 * @param {{
 *   metrics: { files: number, changedLines: number },
 *   breaches: SizeBreach[],
 *   marker: string,
 * }} input
 * @returns {string}
 */
function buildSizeAdvisoryBody(input) {
  const { metrics, breaches, marker } = input;
  const lines = [
    `### ${CONFIG.aiReviewPrefix} PR-size advisory`,
    '',
    'This PR crosses one or more configured size limits. The review still ran; this comment is a warning only.',
    '',
    `**Advisory set:** ${metrics.files} file(s) · ${metrics.changedLines} changed line(s) (added + removed)`,
    '',
    '**Limits exceeded:**',
  ];
  for (const b of breaches) {
    if (b.kind === 'maxFiles') {
      lines.push(`- \`maxFiles\`: ${b.actual} files > ${b.limit}`);
    } else if (b.kind === 'maxChangedLines') {
      lines.push(`- \`maxChangedLines\`: ${b.actual} lines > ${b.limit}`);
    } else {
      lines.push(`- \`maxChangedLinesPerFile\`: \`${b.path}\` has ${b.actual} lines > ${b.limit}`);
    }
  }
  lines.push('', marker);
  return lines.join('\n');
}

module.exports = {
  SIZE_ADVISORY_KEY,
  countChangedLines,
  advisorySet,
  evaluateSizeAdvisory,
  buildSizeAdvisoryBody,
};

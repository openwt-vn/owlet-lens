// @ts-check
'use strict';

const VALID_SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);

const VALID_CONFIDENCES = new Set(['HIGH', 'MEDIUM', 'LOW']);

const SEVERITY_ORDER = new Map([
  ['CRITICAL', 0],
  ['HIGH', 1],
  ['MEDIUM', 2],
  ['LOW', 3],
]);

const SNAP_WINDOW = 5;

/**
 * @param {number} line
 * @param {Set<number>} validLines
 * @param {number} window
 * @returns {number|null}
 */
function snapToNearestLine(line, validLines, window) {
  if (line < 1) return null;
  if (validLines.has(line)) return line;
  let best = null;
  let bestDist = window + 1;
  for (const v of validLines) {
    const d = Math.abs(v - line);
    if (d > window) continue;
    if (d < bestDist || (d === bestDist && v < best)) {
      best = v;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Validates an array of findings against the set of changed files and their lines.
 * Discards findings that reference unknown files, out-of-range lines, missing required
 * fields, or invalid severities. Findings whose line is in the deleted-only set
 * (deleted but not added) are tagged with `deletion: true` so callers can warn-and-drop
 * — annotateDiff stamps deleted lines with the post-image line number that follows
 * the deletion, so posting them on `side: 'RIGHT'` would mis-cite the replacement.
 *
 * @param {unknown} findings - Raw findings array from AI response
 * @param {Map<string, Set<number>> & { detail?: Map<string, { added: Set<number>, deleted: Set<number> }> }} changedFiles - Map of file paths to changed line numbers; `detail` (when present) exposes the added/deleted split.
 * @returns {Array<object>} Filtered array of valid findings
 */
function validateFindings(findings, changedFiles) {
  if (!Array.isArray(findings)) return [];

  const detail = changedFiles.detail;
  const out = [];
  for (let f of findings) {
    if (!f || typeof f !== 'object') continue;
    if (typeof f.file !== 'string' || !f.file) continue;
    if (typeof f.line !== 'number' || !Number.isInteger(f.line)) continue;
    if (typeof f.message !== 'string' || !f.message) continue;
    if (!VALID_SEVERITIES.has(f.severity)) continue;

    const fileLines = changedFiles.get(f.file);
    if (!fileLines) {
      process.stderr.write(JSON.stringify({
        level: 'warn', msg: 'finding.discarded',
        reason: 'unknown-file', file: f.file, line: f.line,
      }) + '\n');
      continue;
    }
    if (!fileLines.has(f.line)) {
      const snapped = snapToNearestLine(f.line, fileLines, SNAP_WINDOW);
      if (snapped === null) {
        process.stderr.write(JSON.stringify({
          level: 'warn', msg: 'finding.discarded',
          reason: 'out-of-range-line', file: f.file, line: f.line,
        }) + '\n');
        continue;
      }
      process.stderr.write(JSON.stringify({
        level: 'info', msg: 'finding.line.snapped',
        file: f.file, original: f.line, snapped,
      }) + '\n');
      f = { ...f, line: snapped };
    }

    let deletion = false;
    if (detail) {
      const d = detail.get(f.file);
      if (d && d.deleted.has(f.line) && !d.added.has(f.line)) {
        deletion = true;
      }
    }
    out.push(deletion ? { ...f, deletion: true } : f);
  }
  return out;
}

// Matches conventional test-file paths across common ecosystems:
// __tests__/ or test(s)/ directories, *.test.* / *.spec.* (JS/TS),
// *_test.go / *_test.py / test_*.py, *_spec.rb, *Test.java/kt.
const TEST_FILE_RE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$|_spec\.rb$|Test\.(java|kt)$/i;

/**
 * True when a path looks like a test file by convention.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isTestFile(filePath) {
  return typeof filePath === 'string' && TEST_FILE_RE.test(filePath);
}

/**
 * Sorts findings from highest to lowest severity without mutating the original array.
 *
 * @param {Array<object>} findings - Array of finding objects with a severity field
 * @returns {Array<object>} New sorted array
 */
function sortBySeverity(findings) {
  return [...findings].sort((a, b) => {
    const orderA = SEVERITY_ORDER.get(a.severity) ?? 999;
    const orderB = SEVERITY_ORDER.get(b.severity) ?? 999;
    return orderA - orderB;
  });
}

/**
 * Builds a Map of file paths to changed line numbers, with an attached
 * `detail` Map exposing added vs deleted lines separately. The outer
 * Map satisfies the legacy contract (reconcile + dismissal-port consumers
 * still treat it as Map<string, Set<number>>); the detail Map gives the
 * validator + post path enough information to distinguish deletion-only
 * citations from in-place edits.
 *
 * @param {Array<{filePath: string, annotatedDiff: string}>} annotatedDiffs
 * @returns {Map<string, Set<number>> & { detail: Map<string, { added: Set<number>, deleted: Set<number> }> }}
 */
function buildChangedFilesMap(annotatedDiffs) {
  const changedFiles = new Map();
  const detail = new Map();

  for (const { filePath, annotatedDiff } of annotatedDiffs) {
    if (!annotatedDiff) continue;

    const added = new Set();
    const deleted = new Set();
    for (const line of annotatedDiff.split('\n')) {
      const m = line.match(/^(\d+):([+-])/);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (m[2] === '+') added.add(n);
      else deleted.add(n);
    }
    const union = new Set([...added, ...deleted]);
    changedFiles.set(filePath, union);
    detail.set(filePath, { added, deleted });
  }

  Object.defineProperty(changedFiles, 'detail', {
    value: detail,
    enumerable: false,
  });
  return changedFiles;
}

module.exports = {
  VALID_SEVERITIES,
  VALID_CONFIDENCES,
  SEVERITY_ORDER,
  validateFindings,
  sortBySeverity,
  buildChangedFilesMap,
  isTestFile,
  __test__: { snapToNearestLine },
};

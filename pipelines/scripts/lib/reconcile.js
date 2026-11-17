// @ts-check
'use strict';

const { fingerprint: portFingerprint } = require('./fingerprint.js');
const { textSimilarity } = require('./fuzzy-match.js');
const { stripConfidenceNote } = require('./format-body.js');

// How far a finding's line can drift from an existing thread's line (from
// unrelated edits shifting code around it) before it's not considered a
// candidate for fuzzy dedup.
const FUZZY_LINE_TOLERANCE = 40;
// Minimum Jaccard similarity (significant-token overlap) between a new
// finding's body and an existing thread's original finding body to treat
// them as the same underlying issue. Tuned against real reworded/re-graded
// re-detections from game-seahorse PR #24 (0.19-0.33 observed); low enough
// to catch those, gated by same-file + line-tolerance + bot-authored-with-
// marker above to keep false positives rare.
const FUZZY_SIMILARITY_THRESHOLD = 0.18;

/**
 * @typedef {Object} PortThread
 * @property {string} id
 * @property {string} status
 * @property {string} filePath
 * @property {number} line
 * @property {Array<{ isBot: boolean, body?: string }>} comments
 * @property {{ fingerprint?: string|null, version?: string|null }} [marker]
 * @property {boolean} [platformResolved] the platform's own open/resolved flag.
 *   `undefined` when the provider did not report it — treated as unknown, so a
 *   thread is never retried on a guess.
 */

/**
 * @typedef {Object} PortFinding
 * @property {string} filePath
 * @property {number} line
 * @property {string} body
 * @property {string} ruleId
 * @property {string} [severity]
 * @property {string} [category]
 */

/**
 * Reconcile new findings against existing port-shaped review threads.
 *
 * @param {PortThread[]} existing
 * @param {PortFinding[]} newFindings
 * @param {{ changedFiles?: Map<string, Set<number>>, suppressClose?: Set<string> }} [opts]
 * @returns {{
 *   toPost: PortFinding[],
 *   toReply: Array<{ thread: PortThread, finding: PortFinding }>,
 *   toReopen: Array<{ thread: PortThread, finding: PortFinding }>,
 *   toClose: PortThread[],
 *   toResolve: PortThread[],
 * }}
 */
function reconcilePort(existing, newFindings, opts) {
  const existingByFp = new Map();
  for (const t of existing) {
    const fp = t.marker?.fingerprint;
    if (fp) existingByFp.set(fp, t);
  }

  const toPost = [];
  const toReply = [];
  const toReopen = [];
  const newFps = new Set();
  const claimedThreadIds = new Set();
  const unmatched = [];
  for (const f of newFindings) {
    const fp = portFingerprint(f.filePath, f.line, f.ruleId);
    newFps.add(fp);
    const match = existingByFp.get(fp);
    if (!match) {
      unmatched.push(f);
    } else if (match.status === 'active') {
      claimedThreadIds.add(match.id);
      // Only reply when a human spoke since the last bot comment (there's
      // something to respond to). When the bot already has the last word the
      // finding was already stated — re-posting it is noise, not signal.
      const lastComment = match.comments[match.comments.length - 1];
      if (lastComment && !lastComment.isBot) {
        toReply.push({ thread: match, finding: f });
      }
    } else {
      // Reopens are non-destructive (reply + status flip back to active),
      // so a fingerprint collision with a human comment is at worst a noisy
      // reply, not data loss. toClose requires marker.version below.
      claimedThreadIds.add(match.id);
      toReopen.push({ thread: match, finding: f });
    }
  }

  // Fuzzy dedup: a finding with no exact fingerprint match may still be a
  // re-detection of an existing thread whose identity drifted — unrelated
  // edits shift its line, or the LLM re-graded its category/severity
  // differently this run. Matching on free-text similarity against bot
  // threads in the same file catches that drift and routes it to a reply
  // instead of a brand-new duplicate thread.
  //
  // Candidates include dismissed (wontfix/fixed) threads, not just active
  // ones: a finding dismissed immediately in the same round it was raised
  // is excluded from *this* round's "still active" pool by the time the
  // *next* round runs, so drift on an already-dismissed finding could never
  // be caught, and reposted as a fresh duplicate every round (game-seahorse
  // PR #47: the same finding reposted 2-3x, dev re-arguing the identical
  // wontfix rationale each time). A fuzzy match here only ever produces a
  // toReply (never toReopen, which stays fingerprint-exact above) — replying
  // on a dismissed thread doesn't flip its status, so this can't resurrect
  // a settled thread. Like the exact-fingerprint path, the reply is suppressed
  // when the bot already has the last word: the drifted re-detection is
  // claimed (no duplicate thread) without re-stating the finding.
  const candidatesByFile = new Map();
  for (const t of existing) {
    if (claimedThreadIds.has(t.id)) continue;
    if (!t.comments.length || !t.comments[0].isBot || !t.marker?.fingerprint) continue;
    const list = candidatesByFile.get(t.filePath) ?? [];
    list.push(t);
    candidatesByFile.set(t.filePath, list);
  }

  for (const f of unmatched) {
    const candidates = candidatesByFile.get(f.filePath) ?? [];
    let best = null;
    let bestScore = 0;
    for (const t of candidates) {
      if (claimedThreadIds.has(t.id)) continue;
      if (Math.abs(t.line - f.line) > FUZZY_LINE_TOLERANCE) continue;
      const score = textSimilarity(stripConfidenceNote(t.comments[0].body), f.body);
      if (score > bestScore) { bestScore = score; best = t; }
    }
    if (best && bestScore >= FUZZY_SIMILARITY_THRESHOLD) {
      claimedThreadIds.add(best.id);
      newFps.add(/** @type {string} */ (best.marker?.fingerprint));
      // Suppress the reply when the bot already has the last word, same as the
      // exact-fingerprint path above. A drifted re-detection is still claimed
      // (no new thread), just not re-stated on every run.
      const lastComment = best.comments[best.comments.length - 1];
      if (lastComment && !lastComment.isBot) {
        toReply.push({ thread: best, finding: f });
      }
    } else {
      toPost.push({ ...f });
    }
  }

  // Only close threads that the bot itself posted: bot-authored first
  // comment AND marker.version truthy (prevents accidental closure of
  // human comments that happen to include a fingerprint-shaped HTML comment).
  //
  // When opts.changedFiles is provided, additionally require diff evidence:
  // the thread's file must appear in the current diff AND the thread's line
  // must be in the changed-lines set. Prevents false-positive close when
  // the LLM omits a finding on a re-run with no code change at that location
  // (e.g. severity-threshold filter, model swap, sampling drift).
  const changedFiles = opts?.changedFiles;
  /** @param {PortThread} t */
  const hasDiffEvidence = (t) => {
    if (!changedFiles) return true;
    const lines = changedFiles.get(t.filePath);
    return !!lines && lines.has(t.line);
  };
  // Defense-in-depth: never auto-close a thread whose latest comment is a
  // human reply the bot has not yet answered. A dev who replied (e.g. to
  // disagree) is owed a verdict from the reply pass (wontfix/active), not a
  // silent "fixed" from fingerprint drift on the next review run. Comments are
  // chronological, so the last entry being non-bot means the dev spoke last.
  /** @param {PortThread} t */
  const botHasLastWord = (t) => t.comments[t.comments.length - 1]?.isBot === true;
  const toClose = existing.filter(
    (t) =>
      t.status === 'active' &&
      t.comments.length > 0 &&
      t.comments[0].isBot &&
      botHasLastWord(t) &&
      t.marker?.version &&
      t.marker?.fingerprint &&
      !newFps.has(t.marker.fingerprint) &&
      !(opts?.suppressClose?.has(t.marker.fingerprint)) &&
      hasDiffEvidence(t),
  );

  // Resolve retry (#105): a thread whose last bot marker says fixed/wontfix but
  // which the platform still shows open. That is the exact shape a failed
  // resolve call leaves behind — the marker is posted first, the resolve after,
  // so a failure between the two is invisible to the merged status and nothing
  // else would ever revisit it. Replays the resolve step alone
  // (skipMarkerReply), because the marker is already correct.
  //
  // A thread being reopened this run flips back to active, so it must not also
  // be resolved; and a thread already closed on the platform is not retried.
  // `platformResolved === false` (not falsy) so a provider that reports nothing
  // never triggers a write.
  //
  // Overlap with `toReply` is left in deliberately: a fuzzy match can route a
  // dismissed thread (marker fixed, platform still open, dev spoke last) into
  // both buckets. That is harmless — the review path's reply is a bare
  // `replyToThread` with no status opt, so it appends no marker and unresolves
  // nothing, and the resolve runs once. Excluding `toReply` would instead
  // leave the thread open on screen for another run after a reply that just
  // proved the reviewer is still looking at it. `toClose` cannot overlap: it
  // requires status `active`, which this filter excludes by construction.
  const reopeningIds = new Set(toReopen.map((r) => r.thread.id));
  const toResolve = existing.filter(
    (t) =>
      (t.status === 'fixed' || t.status === 'wontfix') &&
      t.platformResolved === false &&
      !reopeningIds.has(t.id),
  );

  return { toPost, toReply, toReopen, toClose, toResolve };
}

module.exports = { reconcilePort };

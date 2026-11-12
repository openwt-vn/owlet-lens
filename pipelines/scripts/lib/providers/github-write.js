// @ts-check
'use strict';

const { ProviderError, OrphanCommentError } = require('../errors.js');
const { fingerprint } = require('../fingerprint.js');
const { safeMsg } = require('../log-safe.js');
const { isBotComment } = require('./github-threads.js');

// Write path of the GitHub adapter: batch and single post, reply, resolve /
// unresolve, patchThreadStatus and the summary upsert. Each function takes the
// provider instance `p` (its REST and GraphQL clients, codec and per-run
// caches); github.js keeps a one-line delegator per public method, so the
// adapter's interface is unchanged.

/** @typedef {import('./github.js').GitHubReviewProvider} GitHubProvider */

/**
 * Returns true when a GraphQL error indicates the token lacks the scope
 * required to (un)resolve review threads (FORBIDDEN). Used by
 * patchThreadStatus to soft-skip the resolve/unresolve step instead of
 * counting it as a hard failure.
 *
 * Match rules (any one is sufficient):
 *   - errors[].type === 'FORBIDDEN' (canonical GraphQL signal)
 *   - status === 403 AND message contains "Resource not accessible by integration"
 *
 * The status+message AND-gate prevents future server-side error strings that
 * happen to share the substring from being mis-classified as scope failures.
 *
 * @param {unknown} e
 * @returns {boolean}
 */
function _isScopeError(e) {
  const errors = Array.isArray(e?.errors) ? e.errors : null;
  if (errors?.some((x) => x?.type === 'FORBIDDEN')) return true;
  const msg = String(e?.message ?? '');
  const status = Number(e?.status);
  if (status === 403 && msg.includes('Resource not accessible by integration')) return true;
  return false;
}

/** @param {GitHubProvider} p */
function appendMarkers(p, body, status, fpHash) {
  return p.codec.appendStatus(body, status, fpHash);
}

/**
 * Submit any orphan PENDING reviews owned by the requesting user as
 * `event: COMMENT`. GitHub allows only one PENDING review per user per
 * PR; a stale orphan from a prior crashed run (or from an earlier buggy
 * code path) will otherwise 422 every subsequent atomic `createReview`
 * with "user_id can only have one pending review per pull request".
 *
 * GitHub's REST API exposes PENDING reviews only to their owner, so any
 * `state === 'PENDING'` entry returned to us is ours. Submitting them
 * promotes any leftover comments to the visible timeline and frees the
 * per-user pending slot.
 *
 * All failures are soft — logged and swallowed — so a transient listing
 * or submit error doesn't kill the run. If a real orphan remains, the
 * subsequent atomic createReview will still 422 and the caller will see
 * an honest top-level failure rather than a silent stall.
 *
 * @param {GitHubProvider} p
 * @returns {Promise<void>}
 */
async function clearOwnPendingReviews(p) {
  let reviews;
  try {
    reviews = await p._paginate(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
      p.rest.pulls.listReviews.bind(p.rest.pulls),
      { owner: p.owner, repo: p.repo, pull_number: p.prNumber },
    );
  } catch (e) {
    process.stderr.write(JSON.stringify({
      level: 'warn',
      msg: 'listReviews failed during orphan-pending cleanup; proceeding',
      errName: e?.name,
      errMessage: safeMsg(e),
    }) + '\n');
    return;
  }
  const orphans = reviews.filter((r) => r?.state === 'PENDING');
  for (const orphan of orphans) {
    try {
      await p.rest.pulls.submitReview({
        owner: p.owner,
        repo: p.repo,
        pull_number: p.prNumber,
        review_id: orphan.id,
        event: 'COMMENT',
      });
      process.stderr.write(JSON.stringify({
        level: 'warn',
        msg: 'submitted orphan PENDING review from prior run',
        reviewId: orphan.id,
      }) + '\n');
    } catch (e) {
      process.stderr.write(JSON.stringify({
        level: 'warn',
        msg: 'failed to submit orphan PENDING review',
        reviewId: orphan.id,
        errName: e?.name,
        errMessage: safeMsg(e),
      }) + '\n');
    }
  }
}

/**
 * Post N new threads atomically as a single `event: COMMENT` review.
 *
 * Uses `POST /pulls/{n}/reviews` with `comments: [{ path, line, side,
 * body }, ...]` inline — one request creates and submits the review
 * with all comments attached. This replaces the previous flow which
 * opened a PENDING review and then per-thread POSTed to `/pulls/{n}/
 * comments`; that endpoint accepts no `review_id` and always tries to
 * auto-create a fresh PENDING review as a side effect, 422-ing every
 * comment because one PENDING already exists for the user.
 *
 * Trade-off vs the previous per-comment loop: validation failures are
 * now all-or-nothing — a single bad comment (e.g. line outside the
 * diff) fails the entire batch. This is the correct trade-off because
 * the previous loop's "per-comment isolation" was illusory (every
 * comment failed regardless).
 *
 * Per-comment IDs are recovered after creation via
 * `pulls.listCommentsForReview` and matched back to threads by exact
 * body content (each carries a unique fingerprint marker). If the
 * listing fails, threads are reported as `ok: true` with an empty
 * `id`; downstream marker scanning still recovers them on the next run.
 *
 * @param {GitHubProvider} p
 * @param {Array<import('./provider.types.js').NewThread>} threads
 * @returns {Promise<Array<{ ok: true, value: { id: string } } | { ok: false, error: Error }>>}
 */
async function postThreadsBatch(p, threads) {
  if (threads.length === 0) return [];
  const sha = await p._headSha();

  await clearOwnPendingReviews(p);

  const prepared = threads.map((thread) => {
    const fp = fingerprint(thread.filePath, thread.line, thread.ruleId ?? '');
    const body = appendMarkers(p, thread.body, thread.status, fp);
    return { thread, body };
  });

  let reviewId;
  try {
    const { data } = await p.rest.pulls.createReview({
      owner: p.owner,
      repo: p.repo,
      pull_number: p.prNumber,
      commit_id: sha,
      event: 'COMMENT',
      comments: prepared.map(({ thread, body }) => ({
        path: thread.filePath,
        line: thread.line,
        side: 'RIGHT',
        body,
      })),
    });
    reviewId = data.id;
  } catch (error) {
    p._invalidateThreadMap();
    return prepared.map(() => ({ ok: false, error }));
  }

  let listed = [];
  try {
    listed = await p._paginate(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments',
      p.rest.pulls.listCommentsForReview.bind(p.rest.pulls),
      { owner: p.owner, repo: p.repo, pull_number: p.prNumber, review_id: reviewId },
    );
  } catch (e) {
    process.stderr.write(JSON.stringify({
      level: 'warn',
      msg: 'listCommentsForReview failed after atomic createReview; thread IDs unavailable',
      reviewId,
      errName: e?.name,
      errMessage: safeMsg(e),
    }) + '\n');
  }

  p._invalidateThreadMap();

  return prepared.map(({ thread, body }) => {
    const match = listed.find((c) =>
      typeof c?.body === 'string'
      && c.body === body
      && c.path === thread.filePath
      && c.line === thread.line,
    );
    if (match) return { ok: true, value: { id: String(match.id) } };
    return { ok: true, value: { id: '' } };
  });
}

/** @param {GitHubProvider} p */
async function postThread(p, thread) {
  const sha = await p._headSha();
  const fp = fingerprint(thread.filePath, thread.line, thread.ruleId ?? '');
  const body = appendMarkers(p, thread.body, thread.status, fp);
  const { data } = await p.rest.pulls.createReviewComment({
    owner: p.owner,
    repo: p.repo,
    pull_number: p.prNumber,
    body,
    path: thread.filePath,
    line: thread.line,
    side: 'RIGHT',
    commit_id: sha,
  });
  // Every postThread creates a new review comment, which adds a new
  // databaseId to the underlying thread's comments(...) GraphQL field.
  // Subsequent listThreads() calls join REST comments against this map,
  // so a stale cache would orphan the just-posted comment. Invalidate
  // always — the perf cost (one extra GraphQL fetch on the next caller)
  // is bounded and necessary for correctness.
  p._invalidateThreadMap();
  if (thread.status === 'fixed' || thread.status === 'wontfix') {
    // GitHub REST→GraphQL propagation is eventually consistent; the just-
    // created comment may not appear in reviewThreads on the first try.
    // Bounded retry per `p._resolveDelays`. Total attempts = 1 immediate
    // + p._resolveDelays.length delayed.
    let entry = null;
    let attempts = 0;
    for (let i = 0; i <= p._resolveDelays.length; i++) {
      if (i > 0) {
        p._invalidateThreadMap();
        if (p._resolveDelays[i - 1] > 0) {
          await new Promise((r) => setTimeout(r, p._resolveDelays[i - 1]));
        }
      }
      attempts += 1;
      const map = await p._fetchThreadResolvedMap();
      entry = map.get(data.id);
      if (entry) break;
    }
    if (!entry) {
      // Don't silently leave the thread unresolved — that creates state
      // mismatch (marker says fixed, isResolved=false). Surface as a real
      // error so the caller's failure counter increments and the run exits 6.
      // OrphanCommentError carries commentDbId as a typed field for cleanup.
      throw new OrphanCommentError(
        `Thread for comment ${data.id} not found in GraphQL after ${attempts} attempts; cannot transition to ${thread.status}`,
        { provider: 'github', commentDbId: data.id },
      );
    }
    await setResolved(p, entry.threadGqlId, true);
  }
  return { id: String(data.id) };
}

/**
 * @param {GitHubProvider} p
 * @param {string} threadId
 * @param {string} body
 * @param {{ status?: 'active'|'fixed'|'wontfix'|'resolved'|'closed', fingerprintHash?: string }} [opts]
 */
async function replyToThread(p, threadId, body, opts) {
  const finalBody = opts?.status
    ? p.codec.appendStatus(body, opts.status, opts.fingerprintHash)
    : body;
  const res = await p.graphql(
    `mutation($threadId:ID!,$body:String!) {
       addPullRequestReviewThreadReply(input:{ pullRequestReviewThreadId:$threadId, body:$body }) {
         comment { databaseId }
       }
     }`,
    { threadId, body: finalBody },
  );
  p._invalidateThreadMap();
  return { id: String(res.addPullRequestReviewThreadReply.comment.databaseId) };
}

/** @param {GitHubProvider} p */
async function setResolved(p, threadId, resolved) {
  const mutation = resolved
    ? `mutation($id:ID!) { resolveReviewThread(input:{ threadId:$id }) { thread { id } } }`
    : `mutation($id:ID!) { unresolveReviewThread(input:{ threadId:$id }) { thread { id } } }`;
  // Resolving twice is harmless, so the mutation may repeat (ADR-0013).
  await p.graphqlForResolve(mutation, { id: threadId, request: { idempotent: true } });
  p._invalidateThreadMap();
}

async function logPartialFailure(stage, threadId, e) {
  process.stderr.write(
    JSON.stringify({
      level: 'error',
      msg: `patchThreadStatus.${stage} failed`,
      threadId,
      errName: e?.name,
      errMessage: safeMsg(e),
      errStatus: e?.status,
    }) + '\n',
  );
}

function logScopeWarning(stage, threadId, e) {
  process.stderr.write(
    JSON.stringify({
      level: 'warn',
      msg: `patchThreadStatus.${stage} skipped (token scope insufficient)`,
      threadId,
      errName: e?.name,
      errMessage: safeMsg(e),
      hint: 'GITHUB_TOKEN lacks permission to (un)resolve review threads. Use a PAT with repo scope (resolve-token). Marker reply posted; cross-run reconcile still works, and the resolve retry will warn again on every run until the token has scope.',
    }) + '\n',
  );
}

/** @param {GitHubProvider} p */
async function patchThreadStatus(p, threadId, status, opts) {
  // Run sub-calls independently so a failure in one doesn't skip the other.
  // Collect failures, log each, then throw an aggregated ProviderError at the
  // end so the caller's failure counter increments (the run exits 6 instead
  // of pretending success).
  //
  // Edge case: if one sub-call succeeds and the other fails, the GitHub UI
  // and the marker briefly disagree (e.g. unresolve OK but marker reply
  // failed → thread is unresolved with no `active` marker; reverse case →
  // marker says wontfix but thread still unresolved). The marker direction
  // recovers by itself — the next reconcile reads `latestStatus` from the
  // marker — but the flag does NOT: the merged status then reads as done, so
  // nothing would retry the resolve. reconcile's `toResolve` (see
  // reconcile.js, #105) replays the resolve step alone on a later run for any
  // thread whose marker says fixed/wontfix while `platformResolved` is still
  // false. The exit-6 partial-failure signal here still lets the operator
  // intervene immediately instead of waiting for that run.
  //
  // A 401/403 on resolve is not a failure (setup mistake, warn and repeat), so
  // it never reaches exit 6 — the `toResolve` retry on later runs is the only
  // signal there, and it warns every time until the token has repo scope.
  const failures = [];
  const tryStep = async (stage, fn) => {
    try { await fn(); } catch (e) {
      if ((stage === 'resolve' || stage === 'unresolve') && _isScopeError(e)) {
        logScopeWarning(stage, threadId, e);
        return;
      }
      await logPartialFailure(stage, threadId, e);
      failures.push({ stage, err: e });
    }
  };

  // Both branches now follow the same invariant: marker reply first, then
  // state transition. If the state transition fails after the marker is
  // posted, the next listThreads still derives `latestStatus` from the
  // marker, so reconciliation converges correctly.
  const skipMarkerReply = opts?.skipMarkerReply === true;
  if (status === 'active') {
    if (!skipMarkerReply) {
      await tryStep('reply', () => p.replyToThread(
        threadId,
        p.codec.statusReplyBody('active'),
      ));
    }
    await tryStep('unresolve', () => setResolved(p, threadId, false));
  } else {
    if (!skipMarkerReply) {
      await tryStep('reply', () => p.replyToThread(
        threadId,
        p.codec.statusReplyBody(status),
      ));
    }
    await tryStep('resolve', () => setResolved(p, threadId, true));
  }

  if (failures.length > 0) {
    const stages = failures.map((f) => f.stage).join(', ');
    throw new ProviderError(
      `patchThreadStatus(${threadId}, ${status}) partial failure: ${stages}`,
      { provider: 'github', retryable: false },
    );
  }
}

/**
 * @param {GitHubProvider} p
 * @param {string} markerKey
 * @param {string} body
 * @returns {Promise<import('./provider.types.js').SummaryUpsertResult>}
 */
async function upsertSummaryComment(p, markerKey, body) {
  const comments = await p._paginate(
    'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
    p.rest.issues.listComments.bind(p.rest.issues),
    { owner: p.owner, repo: p.repo, issue_number: p.prNumber },
  );
  // Bot-authored guard prevents marker hijack by malicious commenter. Match
  // the key marker in either wire form via the codec (style-agnostic).
  const existing = comments.find((c) => p.codec.hasKey(c.body ?? '', markerKey) && isBotComment(c));
  if (existing) {
    try {
      await p.rest.issues.updateComment({
        owner: p.owner, repo: p.repo, comment_id: existing.id, body,
      });
      return { id: String(existing.id), action: 'updated' };
    } catch (e) {
      if (e?.status !== 404) throw e;
    }
  }
  const { data } = await p.rest.issues.createComment({
    owner: p.owner, repo: p.repo, issue_number: p.prNumber, body,
  });
  return { id: String(data.id), action: 'created' };
}

/**
 * Delete the bot's own issue comment carrying `markerKey`, if any.
 * @param {GitHubProvider} p
 * @param {string} markerKey
 * @returns {Promise<{ id: string, action: 'deleted'|'absent' }>}
 */
async function deleteBotComment(p, markerKey) {
  const comments = await p._paginate(
    'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
    p.rest.issues.listComments.bind(p.rest.issues),
    { owner: p.owner, repo: p.repo, issue_number: p.prNumber },
  );
  const existing = comments.find((c) => p.codec.hasKey(c.body ?? '', markerKey) && isBotComment(c));
  if (!existing) return { id: '', action: 'absent' };
  try {
    await p.rest.issues.deleteComment({
      owner: p.owner, repo: p.repo, comment_id: existing.id,
    });
    return { id: String(existing.id), action: 'deleted' };
  } catch (e) {
    if (e?.status === 404) return { id: String(existing.id), action: 'absent' };
    throw e;
  }
}

module.exports = {
  postThreadsBatch, postThread, replyToThread, patchThreadStatus,
  upsertSummaryComment, deleteBotComment,
};

// @ts-check
'use strict';

const { ProviderError } = require('../errors.js');
const { safeMsg } = require('../log-safe.js');
const { fingerprint } = require('../fingerprint.js');

// Write path of the Bitbucket Cloud adapter: post, reply, summary upsert, the
// marker-style probe and resolve/unresolve. Each function takes the provider
// instance `p` (its `_api`, codec and per-run state); bitbucket.js keeps a
// one-line delegator per public method, so the adapter's interface is unchanged.

/** @typedef {import('./bitbucket.js').BitbucketCloudReviewProvider} BitbucketProvider */

/** @param {BitbucketProvider} p @param {string} body @param {'active'|'fixed'|'wontfix'|'resolved'|'closed'} status @param {string} [fpHash] */
function appendMarkers(p, body, status, fpHash) {
  return p.codec.appendStatus(body, status, fpHash);
}

/** @param {BitbucketProvider} p @param {any} res */
function recordSelf(p, res) {
  if (res?.user?.account_id && !p._selfAccountId) {
    p._selfAccountId = res.user.account_id;
  }
}

/** @param {string} msg @param {Record<string, any>} [extra] */
function logWarn(msg, extra) {
  process.stderr.write(JSON.stringify({ level: 'warn', msg, ...extra }) + '\n');
}

/**
 * @param {BitbucketProvider} p
 * @param {{ filePath: string, line: number, body: string, status: 'active'|'fixed'|'wontfix'|'resolved'|'closed', ruleId?: string }} thread
 */
async function postThread(p, thread) {
  p._requirePr();
  await p.resolveMarkerStyle();
  const fp = fingerprint(thread.filePath, thread.line, thread.ruleId ?? '');
  const raw = appendMarkers(p, thread.body, thread.status, fp);
  const res = await p._api('POST', `${p._repoPath()}/pullrequests/${p.prId}/comments`, {
    body: { content: { raw }, inline: { path: thread.filePath, to: thread.line } },
  });
  // Learn our own account id from the first comment we post, so subsequent
  // listThreads correctly flags bot-authored comments.
  recordSelf(p, res);
  return { id: String(res.id) };
}

/**
 * @param {BitbucketProvider} p
 * @param {string} threadId
 * @param {string} body
 * @param {{ status?: 'active'|'fixed'|'wontfix'|'resolved'|'closed', fingerprintHash?: string }} [opts]
 */
async function replyToThread(p, threadId, body, opts) {
  p._requirePr();
  const raw = opts?.status
    ? p.codec.appendStatus(body, opts.status, opts.fingerprintHash)
    : body;
  const res = await p._api('POST', `${p._repoPath()}/pullrequests/${p.prId}/comments`, {
    body: { content: { raw }, parent: { id: Number(threadId) } },
  });
  recordSelf(p, res);
  return { id: String(res.id) };
}

/**
 * @param {BitbucketProvider} p
 * @param {string} markerKey
 * @param {string} body
 * @returns {Promise<import('./provider.types.js').SummaryUpsertResult>}
 */
async function upsertSummaryComment(p, markerKey, body) {
  p._requirePr();
  const comments = (await p._fetchAllComments()).filter((c) => !c.deleted);
  p._inferSelfFromComments(comments);
  // Defensive restyle: summary-port now bakes the marker in this provider's
  // style via renderSummaryMarker(), but if a body arrives carrying an HTML
  // marker (Bitbucket renders those as visible text), rewrite it to the
  // resolved wire form. No-op when the probe kept `html` or it's already
  // inline-code.
  const raw = p.codec.restyle(body);
  // Match the summary key marker in either wire form (codec.hasKey applies the
  // `(?![\w-])` boundary so `summary` can't match `summary-extended`).
  // Bot-authored guard prevents marker hijack by a human commenter.
  const existing = comments.find(
    (c) => p.codec.hasKey(c.content?.raw ?? '', markerKey) && p._isSelf(c),
  );
  if (existing) {
    try {
      const updated = await p._api('PUT', `${p._repoPath()}/pullrequests/${p.prId}/comments/${existing.id}`, {
        body: { content: { raw } },
      });
      return { id: String(updated.id ?? existing.id), action: 'updated' };
    } catch (e) {
      if (!(e instanceof ProviderError && e.status === 404)) throw e;
    }
  }
  const created = await p._api('POST', `${p._repoPath()}/pullrequests/${p.prId}/comments`, {
    body: { content: { raw } },
  });
  recordSelf(p, created);
  return { id: String(created.id), action: 'created' };
}

/**
 * Delete the bot's own PR comment carrying `markerKey`, if any.
 * @param {BitbucketProvider} p
 * @param {string} markerKey
 * @returns {Promise<{ id: string, action: 'deleted'|'absent' }>}
 */
async function deleteBotComment(p, markerKey) {
  p._requirePr();
  const comments = (await p._fetchAllComments()).filter((c) => !c.deleted);
  p._inferSelfFromComments(comments);
  const existing = comments.find(
    (c) => p.codec.hasKey(c.content?.raw ?? '', markerKey) && p._isSelf(c),
  );
  if (!existing) return { id: '', action: 'absent' };
  try {
    await p._api('DELETE', `${p._repoPath()}/pullrequests/${p.prId}/comments/${existing.id}`);
    return { id: String(existing.id), action: 'deleted' };
  } catch (e) {
    if (e instanceof ProviderError && e.status === 404) {
      return { id: String(existing.id), action: 'absent' };
    }
    throw e;
  }
}

/**
 * Resolve which marker delimiter to use. Posts a throwaway HTML-comment
 * token, re-reads the comment, and picks `html` ONLY when the token both
 * survives in `content.raw` (so cross-run parsing works) AND is absent from
 * the rendered `content.html` (so it's actually invisible, as on GitHub).
 *
 * Bitbucket Cloud preserves `<!-- … -->` in raw but renders it as *visible*
 * text — and a bare hex fingerprint there gets auto-linked as a commit — so
 * it must fall back to inline-code (`` `ai-review:…` ``), which is tidy and,
 * inside a code span, not auto-linked. Cached for the run; any probe error →
 * safe `bitbucket` fallback. The probe comment is best-effort deleted.
 *
 * @param {BitbucketProvider} p
 * @returns {Promise<'html'|'bitbucket'>}
 */
async function resolveMarkerStyle(p) {
  p._requirePr();
  if (p._markerStyle) return p._markerStyle;
  const token = `<!-- ${p.markerPrefix}:probe -->`;
  /** @type {number|string|null} */
  let commentId = null;
  try {
    const posted = await p._api('POST', `${p._repoPath()}/pullrequests/${p.prId}/comments`, {
      body: { content: { raw: `Marker compatibility probe (auto-deleted).\n\n${token}` } },
    });
    commentId = posted.id;
    recordSelf(p, posted);
    const fetched = await p._api('GET', `${p._repoPath()}/pullrequests/${p.prId}/comments/${commentId}`);
    const survivesRaw = (fetched.content?.raw ?? '').includes(token);
    // If the probe text appears in the rendered HTML at all (literal or
    // HTML-escaped), the comment marker is visible to humans → not usable as
    // an invisible marker. Only GitHub-style hidden HTML comments are absent
    // from the rendered output.
    const visibleInRender = (fetched.content?.html ?? '').includes(`${p.markerPrefix}:probe`);
    p._markerStyle = survivesRaw && !visibleInRender ? 'html' : 'bitbucket';
  } catch (e) {
    p._markerStyle = 'bitbucket';
    const err = /** @type {any} */ (e);
    logWarn('marker-style probe failed; defaulting to inline-code', {
      errName: err?.name,
      errMessage: safeMsg(err),
    });
  } finally {
    if (commentId != null) {
      try {
        await p._api('DELETE', `${p._repoPath()}/pullrequests/${p.prId}/comments/${commentId}`);
      } catch (e) {
        logWarn('failed to delete marker-probe comment', { commentId });
      }
    }
  }
  logWarn('marker-style resolved', { style: p._markerStyle });
  return p._markerStyle;
}

/** @param {BitbucketProvider} p @param {string} threadId @param {boolean} resolved */
async function setResolved(p, threadId, resolved) {
  p._requirePr();
  const url = `${p._repoPath()}/pullrequests/${p.prId}/comments/${threadId}/resolve`;
  try {
    await p._api(resolved ? 'POST' : 'DELETE', url, { idempotent: true });
  } catch (e) {
    // Resolve/unresolve is idempotent in intent: resolving an already-resolved
    // comment returns 409, and unresolving one that isn't resolved returns 404.
    // Both mean the comment is already in the desired state, so treat as
    // success rather than surfacing a partial failure (which would exit 6).
    if (e instanceof ProviderError
      && ((resolved && e.status === 409) || (!resolved && e.status === 404))) {
      return;
    }
    throw e;
  }
}

/**
 * @param {BitbucketProvider} p
 * @param {string} threadId
 * @param {'active'|'fixed'|'wontfix'|'resolved'|'closed'} status
 * @param {{ skipMarkerReply?: boolean }} [opts]
 */
async function patchThreadStatus(p, threadId, status, opts) {
  p._requirePr();
  /** @type {Array<{ stage: string, err: any }>} */
  const failures = [];
  /** @param {string} stage @param {() => Promise<any>} fn */
  const tryStep = async (stage, fn) => {
    try { await fn(); } catch (e) {
      // Catch variable is `unknown` under strict; narrow to `any` for the
      // dynamic error-shape reads below (mirrors github-write.js, which reads
      // these off an untyped helper param).
      const err = /** @type {any} */ (e);
      const scope = e instanceof ProviderError && (e.status === 401 || e.status === 403);
      if ((stage === 'resolve' || stage === 'unresolve') && scope) {
        logWarn(`patchThreadStatus.${stage} skipped (token scope insufficient)`, {
          threadId,
          hint: 'Bitbucket token lacks permission to resolve comments. Marker reply posted; cross-run reconcile still works.',
        });
        return;
      }
      // Log each real failure (error level) before aggregating, so the
      // discarded error detail stays observable — mirrors github-write.js.
      process.stderr.write(JSON.stringify({
        level: 'error',
        msg: `patchThreadStatus.${stage} failed`,
        threadId,
        errName: err?.name,
        errMessage: safeMsg(err),
        errStatus: err?.status,
      }) + '\n');
      failures.push({ stage, err });
    }
  };

  const text = p.codec.statusReplyText(status);
  const skipMarkerReply = opts?.skipMarkerReply === true;

  if (status === 'active') {
    if (!skipMarkerReply) {
      await tryStep('reply', () => p.replyToThread(threadId, text, { status: 'active' }));
    }
    await tryStep('unresolve', () => setResolved(p, threadId, false));
  } else {
    if (!skipMarkerReply) {
      await tryStep('reply', () => p.replyToThread(threadId, text, { status }));
    }
    await tryStep('resolve', () => setResolved(p, threadId, true));
  }

  if (failures.length > 0) {
    const stages = failures.map((f) => f.stage).join(', ');
    throw new ProviderError(
      `patchThreadStatus(${threadId}, ${status}) partial failure: ${stages}`,
      { provider: 'bitbucket', retryable: false },
    );
  }
}

module.exports = {
  postThread, replyToThread, upsertSummaryComment, deleteBotComment,
  resolveMarkerStyle, patchThreadStatus,
};

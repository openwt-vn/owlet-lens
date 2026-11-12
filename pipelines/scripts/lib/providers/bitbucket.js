// @ts-check
'use strict';

const { IReviewProvider, defaultCapabilities, tlPressSet } = require('./provider.types.js');
const { AuthError, ProviderError } = require('../errors.js');
const { splitUnifiedDiff } = require('../unified-diff-split.js');
const { makeMarkerCodec } = require('../marker-codec.js');
const bitbucketThreads = require('./bitbucket-threads.js');
const bitbucketWrite = require('./bitbucket-write.js');
const { httpError } = require('./http-error.js');
const { safeMsg } = require('../log-safe.js');
const { withRetry, requestRetry } = require('../retry.js');

const ORIGIN = { provider: 'bitbucket', label: 'Bitbucket' };
const API_BASE = 'https://api.bitbucket.org/2.0';

class BitbucketCloudReviewProvider extends IReviewProvider {
  /**
   * @param {{
   *   config: any,
   *   env: NodeJS.ProcessEnv,
   *   requirePr?: boolean,
   *   deps?: { fetch?: typeof fetch, sleep?: (ms: number) => Promise<void> },
   * }} opts
   */
  constructor(opts) {
    super();
    const token =
      opts.config?.auth?.bitbucketToken ?? opts.env.BITBUCKET_TOKEN ?? opts.env.AI_REVIEW_TOKEN;
    if (!token) {
      throw new AuthError('Bitbucket token missing (BITBUCKET_TOKEN or auth.bitbucketToken)', {
        provider: 'bitbucket',
        status: 401,
      });
    }

    let workspace = opts.env.BITBUCKET_WORKSPACE ?? '';
    let repo = opts.env.BITBUCKET_REPO_SLUG ?? '';
    if ((!workspace || !repo) && opts.env.BITBUCKET_REPO_FULL_NAME) {
      const [ws, slug] = opts.env.BITBUCKET_REPO_FULL_NAME.split('/');
      workspace = workspace || ws || '';
      repo = repo || slug || '';
    }
    if (!workspace || !repo) {
      throw new ProviderError(
        'Bitbucket workspace/repo missing (BITBUCKET_WORKSPACE + BITBUCKET_REPO_SLUG or BITBUCKET_REPO_FULL_NAME)',
        { provider: 'bitbucket' },
      );
    }

    const requirePr = opts.requirePr !== false;
    const prId = opts.env.BITBUCKET_PR_ID;
    if (requirePr && !prId) {
      throw new ProviderError('Bitbucket PR id missing (BITBUCKET_PR_ID)', { provider: 'bitbucket' });
    }

    this.workspace = workspace;
    this.repo = repo;
    this.env = opts.env ?? process.env;
    this.runId = opts.env.BITBUCKET_BUILD_NUMBER ?? null;
    this.repoSlug = `${workspace}/${repo}`;
    this.prId = prId ? String(prId) : null;
    this.token = token;
    this.markerPrefix = opts.config?.markers?.prefix ?? 'ai-review';
    this._fetch = opts.deps?.fetch ?? globalThis.fetch;
    this._sleep = opts.deps?.sleep;
    /** @type {'html'|'bitbucket'|null} resolved once by resolveMarkerStyle() */
    this._markerStyle = null;
    // Wire style is resolved lazily (after the probe), so the codec reads it via
    // a thunk on each call. All marker rendering goes through this codec.
    this.codec = makeMarkerCodec({ prefix: this.markerPrefix, style: () => this._style() });
    /** @type {string|null} our own account id, learned from a posted comment */
    this._selfAccountId = null;
    /**
     * Memoized raw comment list for this run. Both `listThreads` and
     * `upsertSummaryComment` page through every PR comment; without this they'd
     * each re-paginate. Invalidated by `_api` on any mutating (non-GET) request
     * so a stale list can't mask a freshly posted/edited/resolved comment.
     * @type {any[]|null}
     */
    this._commentsCache = null;
  }

  get capabilities() {
    return { ...defaultCapabilities(), nativeWontFix: false, supportsFileContent: true, canProposeChanges: true };
  }

  _repoPath() {
    return `${API_BASE}/repositories/${this.workspace}/${this.repo}`;
  }

  _requirePr() {
    if (!this.prId) {
      throw new ProviderError('Operation requires a PR id (BITBUCKET_PR_ID not set)', { provider: 'bitbucket' });
    }
    return this.prId;
  }

  /**
   * Core HTTP helper. JSON by default; `raw:true` returns response text.
   * Non-2xx -> ProviderError carrying status so callers can soft-handle.
   * Retried per request (ADR-0013); a POST is repeated only when `idempotent`
   * or when Bitbucket provably did not apply it.
   *
   * @param {string} method
   * @param {string} url
   * @param {{ body?: any, raw?: boolean, idempotent?: boolean }} [opts]
   * @returns {Promise<any>}
   */
  async _api(method, url, opts = {}) {
    return withRetry(
      () => this._apiOnce(method, url, opts),
      requestRetry(method, url, { idempotent: opts.idempotent, sleep: this._sleep }),
    );
  }

  /** @param {string} method @param {string} url @param {{ body?: any, raw?: boolean }} opts */
  async _apiOnce(method, url, opts) {
    /** @type {Record<string, string>} */
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: opts.raw ? 'text/plain' : 'application/json',
    };
    let body;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await this._fetch(url, { method, headers, body });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw httpError(ORIGIN, method, url, res, text);
    }
    // Any mutating request (post/edit/delete/resolve a comment) may change the
    // comment collection, so drop the memoized list — the next read re-fetches.
    if (method !== 'GET') this._commentsCache = null;
    // 204 No Content (e.g. DELETE .../resolve, DELETE a comment) has an empty
    // body; res.json() would throw on the empty string. Return null instead.
    if (res.status === 204) return null;
    return opts.raw ? res.text() : res.json();
  }

  async getPRMetadata() {
    this._requirePr();
    const pr = await this._api('GET', `${this._repoPath()}/pullrequests/${this.prId}`);
    return {
      id: String(pr.id),
      sourceBranch: pr.source?.branch?.name ?? '',
      targetBranch: pr.destination?.branch?.name ?? '',
      sourceSha: pr.source?.commit?.hash ?? '',
      targetSha: pr.destination?.commit?.hash ?? '',
      title: pr.title ?? '',
      description: pr.summary?.raw ?? pr.description ?? '',
      // Bitbucket Cloud does not expose author email; nickname/account_id is the
      // best available identifier (parallels GitHub falling back to login).
      authorEmail: pr.author?.nickname ?? pr.author?.account_id ?? '',
      url: pr.links?.html?.href ?? '',
    };
  }

  async getDiff() {
    this._requirePr();
    const raw = await this._api('GET', `${this._repoPath()}/pullrequests/${this.prId}/diff`, { raw: true });
    return splitUnifiedDiff(raw);
  }

  /**
   * Did a human press the manual step ("Run") on this PR pipeline, and who?
   *
   * `BITBUCKET_STEP_TRIGGERER_UUID` is also set in the *automatic* step, so on
   * its own it cannot tell a button run from a push — live-tested 2026-10-05.
   * The manual step therefore exports `AI_REVIEW_TL_PRESSED` itself, and that
   * variable is what marks the run as a press. The triggerer UUID is the
   * presser's account UUID, which is the form `review.tlGate.leads` uses (the
   * value includes its braces; the gate normalises both sides).
   *
   * @returns {Promise<import('./provider.types.js').TriggerInfo>}
   */
  async getTriggerInfo() {
    const manual = tlPressSet(this.env);
    const uuid = manual ? (this.env.BITBUCKET_STEP_TRIGGERER_UUID ?? null) : null;
    return {
      manual,
      actorId: uuid,
      actorLabel: uuid ? await this._accountDisplayName(uuid) : null,
      howToTurnOn: 'On the PR, press **Run** on the "Turn AI review on (team lead)" step.',
    };
  }

  /**
   * Best-effort display name for an account UUID, so the "AI on" note can name
   * the person rather than only their id. Never fatal: the gate's decision uses
   * the id, so a failed lookup only costs the name.
   * @param {string} uuid
   * @returns {Promise<string|null>}
   */
  async _accountDisplayName(uuid) {
    try {
      const user = await this._api('GET', `${API_BASE}/users/${encodeURIComponent(uuid)}`);
      return user?.display_name ?? user?.nickname ?? null;
    } catch (e) {
      process.stderr.write(JSON.stringify({
        level: 'warn',
        msg: 'tlGate: could not resolve the step triggerer account name',
        errName: e?.name,
        errMessage: safeMsg(e),
      }) + '\n');
      return null;
    }
  }

  /**
   * The bot's own PR comment carrying `markerKey`, or null. `editedByOther` is
   * always false because "You can only edit your own comments" on Bitbucket
   * Cloud, so bot-detection by account is enough here.
   * @param {string} markerKey
   * @returns {Promise<import('./provider.types.js').BotComment|null>}
   */
  async findBotComment(markerKey) {
    this._requirePr();
    const comments = (await this._fetchAllComments()).filter((c) => !c.deleted);
    this._inferSelfFromComments(comments);
    const hit = comments.find(
      (c) => this.codec.hasKey(c.content?.raw ?? '', markerKey) && this._isSelf(c),
    );
    if (!hit) return null;
    return {
      id: String(hit.id),
      body: hit.content?.raw ?? '',
      createdAt: hit.created_on ?? '',
      editedByOther: false,
    };
  }

  /**
   * @param {string} filePath
   * @param {string} ref
   * @returns {Promise<string|null>}
   */
  async getFileContent(filePath, ref) {
    // Encode each path segment individually: slashes must stay literal so the
    // /src/{ref}/{path} endpoint resolves nested files, but spaces / # / ? in a
    // filename must be percent-encoded. `filePath` comes from the PR's own diff
    // (not user input), so this is defensive, not a traversal guard.
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const url = `${this._repoPath()}/src/${encodeURIComponent(ref)}/${encodedPath}`;
    try {
      return await this._api('GET', url, { raw: true });
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) return null;
      throw e;
    }
  }

  /** @param {string} url @param {Record<string,string>} fields */
  async _postForm(url, fields) {
    const body = new URLSearchParams(fields).toString();
    return withRetry(async () => {
      const res = await this._fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw httpError(ORIGIN, 'POST', url, res, text);
      }
      return res;
    }, requestRetry('POST', url, { sleep: this._sleep }));
  }

  /**
   * @param {{ branch: string, filePath: string, newContent: string, baseBranch: string, title: string, body: string }} opts
   * @returns {Promise<{ url: string }>}
   */
  async proposeStandardsChange({ branch, filePath, newContent, baseBranch, title, body }) {
    // 1. Resolve baseBranch head so the new branch forks from baseBranch (not the
    //    repo's default branch, which Bitbucket's /src would otherwise use when the
    //    branch doesn't yet exist). Passing `parents` pins the fork point.
    const ref = await this._api('GET', `${this._repoPath()}/refs/branches/${encodeURIComponent(baseBranch)}`);
    const parentHash = ref?.target?.hash;
    // 2. Commit on a new branch. The file path is the form field NAME; strip a
    //    leading `./` (used for local fs reads) so the committed path is
    //    repo-relative rather than literally `./docs/...`.
    const apiPath = String(filePath).replace(/^\.\//, '').replace(/^\/+/, '');
    const fields = { [apiPath]: newContent, branch, message: title };
    if (parentHash) fields.parents = parentHash;
    await this._postForm(`${this._repoPath()}/src`, fields);
    // 3. Open the PR. Idempotent: if an open PR for this source branch already
    //    exists (a prior same-day run), Bitbucket rejects the create — reuse the
    //    existing PR instead of failing the whole proposal.
    let pr;
    try {
      pr = await this._api('POST', `${this._repoPath()}/pullrequests`, {
        body: {
          title,
          description: body,
          source: { branch: { name: branch } },
          destination: { branch: { name: baseBranch } },
        },
      });
    } catch (e) {
      // Only treat a duplicate-PR rejection as reusable. Bitbucket returns 400
      // (sometimes 409) when an open PR for the source branch already exists.
      // Other failures (401/403 auth, 429 rate-limit, 5xx) must propagate
      // immediately rather than trigger a spurious lookup that could mask the
      // real error by returning an unrelated open PR.
      const status = Number(e?.status);
      if (status !== 400 && status !== 409) throw e;
      const q = encodeURIComponent(`state="OPEN" AND source.branch.name="${branch}"`);
      const found = await this._api('GET', `${this._repoPath()}/pullrequests?q=${q}`);
      pr = (found?.values ?? [])[0];
      if (!pr) throw e;
    }
    return { url: pr.links?.html?.href ?? '' };
  }

  /**
   * Learn the bot's own account id from existing comments (delegates to the
   * pure helper in bitbucket-threads.js), so identity is account-based rather
   * than "any comment with a marker is ours". No-op once known.
   *
   * @param {any[]} comments
   */
  _inferSelfFromComments(comments) {
    if (this._selfAccountId) return;
    const acc = bitbucketThreads.inferSelfAccountId(comments, this.markerPrefix);
    if (acc) this._selfAccountId = acc;
  }

  /**
   * Is this comment authored by our bot? Prefer an account-id match (the bot
   * account is recorded after we post, or inferred via _inferSelfFromComments).
   * Only when the account is still unknown — a first run with no prior bot
   * comments — fall back to marker presence; at that point there are no
   * findings to manipulate, so the residual spoof window is harmless.
   *
   * @param {any} comment
   */
  _isSelf(comment) {
    const acc = comment?.user?.account_id ?? null;
    if (this._selfAccountId !== null) return acc !== null && acc === this._selfAccountId;
    return this.codec.has(comment?.content?.raw ?? '');
  }

  /**
   * Cursor-walk a PR's comments via the `next` link. Cap iterations defensively,
   * and break on a self-referential cursor so a `next` pointing at the current
   * page can't re-fetch and duplicate comments (mirrors the github-threads.js
   * cursor guard).
   * @param {string} prId @returns {Promise<any[]>}
   */
  async _paginateComments(prId) {
    /** @type {any[]} */
    const all = [];
    let url = `${this._repoPath()}/pullrequests/${prId}/comments?pagelen=100`;
    for (let i = 0; i < 1000 && url; i++) {
      const page = await this._api('GET', url);
      for (const c of page.values ?? []) all.push(c);
      const next = page.next ?? null;
      if (next === url) break;
      url = next;
    }
    return all;
  }

  /** @returns {Promise<any[]>} */
  async _fetchAllComments() {
    this._requirePr();
    if (this._commentsCache) return this._commentsCache;
    this._commentsCache = await this._paginateComments(this.prId);
    return this._commentsCache;
  }

  /** @param {string} prId @returns {Promise<any[]>} */
  async _fetchAllCommentsFor(prId) {
    return this._paginateComments(prId);
  }

  /**
   * @param {{ sinceISO: string, limit?: number }} opts
   * @returns {Promise<Array<{ id: string, title: string, mergedAt: string, authorEmail: string, url: string }>>}
   */
  async listMergedPRs({ sinceISO, limit = 200 }) {
    // Bitbucket's PR list exposes no merge timestamp (only created_on/updated_on),
    // so — unlike GitHub, which filters on merged_at — the lookback window is
    // necessarily keyed on updated_on and mergedAt is reported as updated_on.
    // A PR merged before the window but edited inside it is therefore included;
    // the downstream minWontfix/minDistinctAuthors thresholds bound the impact.
    const out = [];
    const q = encodeURIComponent(`updated_on >= "${sinceISO}"`);
    let url = `${this._repoPath()}/pullrequests?state=MERGED&q=${q}&sort=-updated_on&pagelen=50`;
    for (let i = 0; i < 1000 && url && out.length < limit; i++) {
      const page = await this._api('GET', url);
      for (const pr of page.values ?? []) {
        out.push({
          id: String(pr.id),
          title: pr.title ?? '',
          mergedAt: pr.updated_on ?? '',
          authorEmail: pr.author?.nickname ?? pr.author?.account_id ?? '',
          url: pr.links?.html?.href ?? '',
        });
        if (out.length >= limit) break;
      }
      const next = page.next ?? null;
      if (next === url) break;
      url = next;
    }
    return out;
  }

  /** @returns {Promise<string>} */
  async getDefaultBranch() {
    const repo = await this._api('GET', this._repoPath());
    return repo?.mainbranch?.name ?? 'main';
  }

  /** @param {string} prId @returns {Promise<import('./provider.types.js').ReviewThread[]>} */
  async listThreadsForPR(prId) {
    const comments = (await this._fetchAllCommentsFor(prId)).filter((c) => !c.deleted);
    // Infer the bot's account id from these comments and use account-based
    // self-detection (mirrors listThreads), so a malicious commenter who pastes
    // a marker isn't mistaken for the bot. Falls back to marker presence only
    // when the account is still unknown.
    this._inferSelfFromComments(comments);
    return bitbucketThreads.groupThreads({
      comments,
      isSelf: (c) => this._isSelf(c),
      markerPrefix: this.markerPrefix,
    });
  }

  async listThreads() {
    this._requirePr();
    const comments = (await this._fetchAllComments()).filter((c) => !c.deleted);
    this._inferSelfFromComments(comments);
    return bitbucketThreads.groupThreads({
      comments,
      isSelf: (c) => this._isSelf(c),
      markerPrefix: this.markerPrefix,
    });
  }

  /**
   * Resolved marker style. Only `postThread` runs the style probe; reply/
   * summary paths intentionally skip it (no network round-trip on non-posting
   * runs) and fall back to inline-code. This is cosmetic-only — `parseMarkers`
   * reads both wire forms, so cross-run reconcile is unaffected by the mix.
   */
  _style() {
    return this._markerStyle ?? 'bitbucket';
  }

  /** This provider's marker codec (wire style resolved lazily via _style()). */
  get markers() { return this.codec; }

  // Write path: bodies live in bitbucket-write.js.

  /**
   * @param {{ filePath: string, line: number, body: string, status: 'active'|'fixed'|'wontfix'|'resolved'|'closed', ruleId?: string }} thread
   */
  async postThread(thread) { return bitbucketWrite.postThread(this, thread); }

  /**
   * @param {string} threadId
   * @param {string} body
   * @param {{ status?: 'active'|'fixed'|'wontfix'|'resolved'|'closed', fingerprintHash?: string }} [opts]
   */
  async replyToThread(threadId, body, opts) { return bitbucketWrite.replyToThread(this, threadId, body, opts); }

  /**
   * @param {string} markerKey
   * @param {string} body
   * @returns {Promise<import('./provider.types.js').SummaryUpsertResult>}
   */
  async upsertSummaryComment(markerKey, body) { return bitbucketWrite.upsertSummaryComment(this, markerKey, body); }

  /** @param {string} markerKey @returns {Promise<{ id: string, action: 'deleted'|'absent' }>} */
  async deleteBotComment(markerKey) { return bitbucketWrite.deleteBotComment(this, markerKey); }

  /** @returns {Promise<'html'|'bitbucket'>} */
  async resolveMarkerStyle() { return bitbucketWrite.resolveMarkerStyle(this); }

  /**
   * @param {string} threadId
   * @param {'active'|'fixed'|'wontfix'|'resolved'|'closed'} status
   * @param {{ skipMarkerReply?: boolean }} [opts]
   */
  async patchThreadStatus(threadId, status, opts) { return bitbucketWrite.patchThreadStatus(this, threadId, status, opts); }
}

module.exports = { BitbucketCloudReviewProvider };

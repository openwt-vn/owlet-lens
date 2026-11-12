// @ts-check
'use strict';

const { Octokit } = require('@octokit/rest');
const { IReviewProvider, defaultCapabilities } = require('./provider.types.js');
const { AuthError, ProviderError, RateLimitError } = require('../errors.js');
const { httpError } = require('./http-error.js');
const { parseRetryAfter, withRetry, requestRetry } = require('../retry.js');
const { logWarn } = require('../log-helpers.js');
const { redactSecrets } = require('../log-safe.js');
const { makeMarkerCodec } = require('../marker-codec.js');
const { resolvePr } = require('../resolve-pr.js');
const githubThreads = require('./github-threads.js');
const githubWrite = require('./github-write.js');

function mapStatus(restStatus) {
  switch (restStatus) {
    case 'added': return 'add';
    case 'removed': return 'delete';
    case 'renamed': return 'rename';
    default: return 'modify';
  }
}

const ORIGIN = { provider: 'github', label: 'GitHub' };

// Octokit logs every failed request as plain text on stderr. The pipeline logs
// the typed error itself, so only Octokit's warnings (deprecations) surface, as JSON.
const OCTOKIT_LOG = {
  debug() {},
  info() {},
  error() {},
  warn: (/** @type {unknown} */ m) => logWarn('octokit warning', { detail: redactSecrets(m) }),
};

/**
 * GitHub's documented wait before retrying a request already known to be
 * rate-limited (a 429, or a 403 that `toTypedError` recognised as one):
 * `retry-after` seconds, else the `x-ratelimit-reset` epoch once the quota is
 * spent, else one minute, GitHub's minimum for a secondary rate limit.
 * Undefined (plain backoff) when the reset has passed.
 *
 * @param {Record<string, string>} headers
 * @returns {number|undefined}
 */
function rateLimitWaitMs(headers) {
  const retryAfter = parseRetryAfter(headers['retry-after']);
  if (retryAfter !== undefined) return retryAfter;
  if (headers['x-ratelimit-remaining'] !== '0') return 60_000;
  const untilReset = Number(headers['x-ratelimit-reset']) * 1000 - Date.now();
  return untilReset > 0 ? untilReset : undefined;
}

/**
 * Map an Octokit RequestError (name "HttpError") through the shared status
 * table (ADR-0012). GitHub's one quirk is checked first: it can answer a rate
 * limit with a 429, or a 403 carrying `x-ratelimit-remaining: 0`, a
 * `retry-after` header or a "secondary rate limit" message. The network
 * `cause` is kept so the retry can tell a request that never left (ADR-0013).
 * Anything that is not an HTTP error passes through.
 *
 * @param {any} e
 * @returns {Error}
 */
function toTypedError(e) {
  if (e?.name !== 'HttpError') return e;
  /** @type {Record<string, string>} */
  const headers = e.response?.headers ?? {};
  const res = { status: e.status, headers: { get: (/** @type {string} */ h) => headers[h] ?? null } };
  const err = httpError(ORIGIN, e.request?.method ?? '', e.request?.url ?? '', res, String(e.message ?? ''));
  const rateLimited = e.status === 429 || (e.status === 403 && (headers['x-ratelimit-remaining'] === '0'
    || headers['retry-after'] != null || /secondary rate limit/i.test(String(e.message))));
  const typed = rateLimited
    ? new RateLimitError(err.message, { provider: ORIGIN.provider, status: e.status, retryAfterMs: rateLimitWaitMs(headers) })
    : err;
  if (e.cause) typed.cause = e.cause;
  return typed;
}

/**
 * An Octokit client whose REST, pagination and `octokit.graphql` HTTP errors
 * all leave as typed errors, each request retried on its own (ADR-0013). A
 * POST or a GraphQL mutation is a create: it repeats only when GitHub provably
 * did not apply it, unless the call passes `request: { idempotent: true }`.
 * `fetch` and `sleep` are the test seams the other providers have.
 *
 * @param {string} token
 * @param {{ fetch?: typeof fetch, sleep?: (ms: number) => Promise<void> }} [deps]
 */
function makeOctokit(token, deps) {
  // Both logs are needed: the fetch wrapper warns via `request.log` (else console), not `octokit.log`.
  const octokit = new Octokit({
    auth: token, log: OCTOKIT_LOG, request: { fetch: deps?.fetch, log: OCTOKIT_LOG },
  });
  octokit.hook.error('request', (e) => { throw toTypedError(e); });
  // Registered after the error hook, so it wraps it and retries typed errors.
  octokit.hook.wrap('request', (request, options) => {
    const { method, url } = octokit.request.endpoint.parse(options);
    const { query, request: extra } = /** @type {{ query?: unknown, request?: { idempotent?: boolean } }} */ (options);
    const idempotent = extra?.idempotent === true || (typeof query === 'string' && !/\bmutation\b/.test(query));
    return withRetry(() => request(options), requestRetry(method, url, { idempotent, sleep: deps?.sleep }));
  });
  return octokit;
}

class GitHubReviewProvider extends IReviewProvider {
  /**
   * @param {{
   *   config: any,
   *   env: NodeJS.ProcessEnv,
   *   requirePr?: boolean,
   *   deps?: {
   *     fetch?: typeof fetch,
   *     sleep?: (ms: number) => Promise<void>,
   *     restClient?: any,
   *     graphqlClient?: any,
   *     graphqlResolveClient?: any,
   *     resolveDelays?: number[],
   *   },
   * }} opts
   */
  constructor(opts) {
    super();
    const token =
      opts.config?.auth?.token ?? opts.env.GITHUB_TOKEN ?? opts.env.AI_REVIEW_TOKEN;
    if (!token) {
      throw new AuthError('GitHub token missing (GITHUB_TOKEN or auth.token)', {
        provider: 'github',
        status: 401,
      });
    }
    const repo = opts.env.GITHUB_REPOSITORY ?? '';
    const [owner, name] = repo.split('/');
    if (!owner || !name) {
      throw new ProviderError(
        'GITHUB_REPOSITORY env var missing (expected "owner/repo")',
        { provider: 'github' },
      );
    }

    this.owner = owner;
    this.repo = name;
    this.env = opts.env ?? process.env;
    this.runId = opts.env.GITHUB_RUN_ID ?? null;
    this.repoSlug = repo;
    this.markerPrefix = opts.config?.markers?.prefix ?? 'ai-review';
    // GitHub hides HTML-comment markers in rendered markdown, so the wire style
    // is always 'html'. All marker rendering goes through this codec.
    this.codec = makeMarkerCodec({ prefix: this.markerPrefix, style: 'html' });
    // The `learn` command runs off any PR (it mines merged-PR history), so it
    // builds the provider with requirePr:false. Only require a resolvable PR
    // for the review/reply paths that actually operate on one.
    this.prNumber = resolvePr(opts.env, {});
    if (!this.prNumber && opts.requirePr !== false) {
      throw new ProviderError(
        'Cannot resolve PR number from GITHUB_PR_NUMBER, GITHUB_REF, or GITHUB_EVENT_PATH',
        { provider: 'github' },
      );
    }

    const octokit = makeOctokit(token, opts.deps);
    this.rest = opts.deps?.restClient ?? octokit;
    this.graphql = opts.deps?.graphqlClient ?? octokit.graphql;
    const resolveToken =
      opts.config?.auth?.resolveToken ?? opts.env.AI_REVIEW_RESOLVE_TOKEN ?? null;
    this.graphqlForResolve =
      opts.deps?.graphqlResolveClient ??
      (resolveToken ? makeOctokit(resolveToken, opts.deps).graphql : this.graphql);
    /** @type {string|null} populated lazily by _headSha() */
    this._cachedHeadSha = null;
    /** @type {Map<number, {threadGqlId: string, isResolved: boolean}>|null} populated lazily, invalidated on writes */
    this._cachedThreadMap = null;
    /**
     * Bounded retry delays (ms) for the post-create REST→GraphQL propagation
     * window. Configurable so tests can pass `[0]` to skip real setTimeout.
     * @type {number[]}
     */
    this._resolveDelays = opts.deps?.resolveDelays ?? [200, 600, 1200];
  }

  get capabilities() {
    return { ...defaultCapabilities(), nativeWontFix: false, supportsFileContent: true, canProposeChanges: true };
  }

  async getPRMetadata() {
    const { data: pr } = await this.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: this.prNumber,
    });
    return {
      id: String(pr.number),
      sourceBranch: pr.head.ref,
      targetBranch: pr.base.ref,
      sourceSha: pr.head.sha,
      targetSha: pr.base.sha,
      title: pr.title,
      description: pr.body ?? '',
      authorEmail: pr.user?.email ?? pr.user?.login ?? '',
      url: pr.html_url,
    };
  }

  /** Was this run a "Re-run all jobs" press, and who pressed it? @returns {Promise<import('./provider.types.js').TriggerInfo>} */
  async getTriggerInfo() { return githubThreads.triggerInfo(this); }

  /** @param {string} markerKey @returns {Promise<import('./provider.types.js').BotComment|null>} */
  async findBotComment(markerKey) { return githubThreads.findBotComment(this, markerKey); }

  /** @returns {Promise<string>} */
  async getDefaultBranch() {
    const { data } = await this.rest.repos.get({ owner: this.owner, repo: this.repo });
    return data.default_branch ?? 'main';
  }

  async _paginate(route, fnFallback, params) {
    // Use Octokit's Link-header-driven paginator with a route string when
    // available (real Octokit). Fall back to manual page-walking for tests
    // that pass a hand-rolled rest stub which does not have .paginate().
    if (typeof this.rest.paginate === 'function') {
      return this.rest.paginate(route, { ...params, per_page: 100 });
    }
    const all = [];
    let page = 1;
    for (;;) {
      const { data } = await fnFallback({ ...params, per_page: 100, page });
      all.push(...data);
      // < 100 covers both an underfilled final page and the empty case.
      if (data.length < 100) break;
      page += 1;
    }
    return all;
  }

  async getDiff() {
    const files = await this._paginate(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files',
      this.rest.pulls.listFiles.bind(this.rest.pulls),
      { owner: this.owner, repo: this.repo, pull_number: this.prNumber },
    );
    // GitHub's listFiles endpoint caps at 3000 files total per PR. Beyond that
    // the diff is silently truncated server-side. Surface a warning so reviews
    // on giant PRs don't quietly miss findings on un-fetched files.
    if (files.length >= 3000) {
      process.stderr.write(
        JSON.stringify({
          level: 'warn',
          msg: 'PR diff hit GitHub 3000-file cap; later files are missing from the review',
          fileCount: files.length,
        }) + '\n',
      );
    }
    return files.map((f) => ({
      path: f.filename,
      change: mapStatus(f.status),
      patch: f.patch ?? '',
      oldPath: f.previous_filename,
    }));
  }

  /**
   * Fetch file content at a given ref. Returns null when the path is absent
   * at that ref (404), resolves to a directory rather than a file, or exceeds
   * the GitHub REST 1 MB cap (which returns empty `content` with non-base64
   * encoding). Other HTTP errors throw — caller decides soft-fail.
   *
   * @param {string} filePath
   * @param {string} ref
   * @returns {Promise<string|null>}
   */
  async getFileContent(filePath, ref) {
    try {
      const { data } = await this.rest.repos.getContent({
        owner: this.owner, repo: this.repo, path: filePath, ref,
      });
      if (Array.isArray(data) || data.type !== 'file') return null;
      if (data.encoding !== 'base64') return null;
      return Buffer.from(data.content ?? '', 'base64').toString('utf8');
    } catch (e) {
      if (e?.status === 404) return null;
      throw e;
    }
  }

  // Read side: bodies live in github-threads.js.
  /** @param {number} [prNumber] */
  async _fetchThreadResolvedMap(prNumber) { return githubThreads.fetchThreadResolvedMap(this, prNumber); }

  async listThreads() {
    return githubThreads.buildThreads(this, this.prNumber);
  }

  /**
   * Build review threads for an arbitrary PR (used by the learn harvester to
   * read wontfix history off already-merged PRs). Same shape as listThreads.
   * @param {number|string} prId
   * @returns {Promise<import('./provider.types.js').ReviewThread[]>}
   */
  async listThreadsForPR(prId) {
    return githubThreads.buildThreads(this, Number(prId));
  }

  async _headSha() {
    if (this._cachedHeadSha) return this._cachedHeadSha;
    const { data } = await this.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: this.prNumber,
    });
    this._cachedHeadSha = data.head.sha;
    return this._cachedHeadSha;
  }

  /** This provider's marker codec (HTML-comment style). */
  get markers() { return this.codec; }

  _invalidateThreadMap() {
    this._cachedThreadMap = null;
  }

  /**
   * List merged PRs updated at/after sinceISO, newest first (learn harvest).
   * @param {{ sinceISO: string, limit?: number }} opts
   * @returns {Promise<Array<{ id: string, title: string, mergedAt: string, authorEmail: string, url: string }>>}
   */
  async listMergedPRs({ sinceISO, limit = 200 }) {
    // A malformed sinceISO yields NaN; treat that as "no lower bound" (0) so a
    // bad input degrades to "include everything" rather than silently excluding
    // every PR (NaN comparisons are always false) and paging to the hard cap.
    const sinceTs = sinceISO ? new Date(sinceISO).getTime() : 0;
    const since = Number.isNaN(sinceTs) ? 0 : sinceTs;
    const out = [];
    let page = 1;
    // pulls.list lacks a server-side merged/since filter, so page closed PRs
    // sorted by recency and stop once we pass the sinceISO horizon.
    for (let i = 0; i < 1000 && out.length < limit; i++) {
      const { data } = await this.rest.pulls.list({
        owner: this.owner,
        repo: this.repo,
        state: 'closed',
        sort: 'updated',
        direction: 'desc',
        per_page: 100,
        page,
      });
      if (!Array.isArray(data) || data.length === 0) break;
      let crossedHorizon = false;
      for (const pr of data) {
        // Paging horizon is updated_at (the sort key): once a PR was last
        // touched before `since`, every later page is older too — stop.
        const updatedTs = new Date(pr.updated_at).getTime();
        if (!Number.isNaN(updatedTs) && updatedTs < since) { crossedHorizon = true; break; }
        if (!pr.merged_at) continue;
        // updated_at can be newer than merged_at (e.g. a comment edited after
        // merge), so a PR still inside the updated-at window may have merged
        // before `since`. Filter on merged_at independently.
        const mergedTs = new Date(pr.merged_at).getTime();
        if (!Number.isNaN(mergedTs) && mergedTs < since) continue;
        out.push({
          id: String(pr.number),
          title: pr.title ?? '',
          mergedAt: pr.merged_at,
          authorEmail: pr.user?.login ?? '',
          url: pr.html_url ?? '',
        });
        if (out.length >= limit) break;
      }
      if (crossedHorizon || data.length < 100) break;
      page += 1;
    }
    return out;
  }

  /**
   * Open a PR that updates a single file wholesale (learn → standards change).
   * Creates `branch` off `baseBranch` head, commits `newContent` to `filePath`,
   * then opens the PR. Returns the new PR's html url.
   * @param {{ branch: string, filePath: string, newContent: string, baseBranch: string, title: string, body: string }} opts
   * @returns {Promise<{ url: string }>}
   */
  async proposeStandardsChange({ branch, filePath, newContent, baseBranch, title, body }) {
    // codingStandardsPath is often written as `./docs/x.md` for local fs reads,
    // but the GitHub Contents API rejects a leading `./` ("malformed path
    // component", 422). Normalize to a repo-relative path.
    const apiPath = String(filePath).replace(/^\.\//, '').replace(/^\/+/, '');
    // 1. Fork the new branch from baseBranch head (idempotent: a 422 "Reference
    //    already exists" means a prior run created it — reuse it).
    const { data: ref } = await this.rest.git.getRef({
      owner: this.owner, repo: this.repo, ref: `heads/${baseBranch}`,
    });
    const baseSha = ref.object.sha;
    try {
      await this.rest.git.createRef({
        owner: this.owner, repo: this.repo, ref: `refs/heads/${branch}`, sha: baseSha,
      });
    } catch (e) {
      if (e?.status !== 422) throw e;
    }
    // 2. Resolve the file's current blob sha on the branch (required to update
    //    an existing file; absent for a new file).
    let existingSha;
    try {
      const { data: existing } = await this.rest.repos.getContent({
        owner: this.owner, repo: this.repo, path: apiPath, ref: branch,
      });
      existingSha = Array.isArray(existing) ? undefined : existing.sha;
    } catch (e) {
      if (e?.status !== 404) throw e;
    }
    // 3. Commit the new content.
    await this.rest.repos.createOrUpdateFileContents({
      owner: this.owner,
      repo: this.repo,
      path: apiPath,
      message: title,
      content: Buffer.from(newContent, 'utf8').toString('base64'),
      branch,
      ...(existingSha ? { sha: existingSha } : {}),
    });
    // 4. Open the PR. Idempotent: a 422 means a PR for this branch already
    //    exists (a prior same-day run), so reuse it instead of failing.
    let pr;
    try {
      ({ data: pr } = await this.rest.pulls.create({
        owner: this.owner, repo: this.repo, title, body, head: branch, base: baseBranch,
      }));
    } catch (e) {
      if (e?.status !== 422) throw e;
      const { data: open } = await this.rest.pulls.list({
        owner: this.owner, repo: this.repo, state: 'open', head: `${this.owner}:${branch}`,
      });
      pr = Array.isArray(open) ? open[0] : undefined;
      if (!pr) throw e;
    }
    return { url: pr.html_url ?? '' };
  }

  // Write path: bodies live in github-write.js.
  /**
   * @param {Array<import('./provider.types.js').NewThread>} threads
   * @returns {Promise<Array<{ ok: true, value: { id: string } } | { ok: false, error: Error }>>}
   */
  async postThreadsBatch(threads) { return githubWrite.postThreadsBatch(this, threads); }

  async postThread(thread) { return githubWrite.postThread(this, thread); }

  /**
   * @param {string} threadId
   * @param {string} body
   * @param {{ status?: 'active'|'fixed'|'wontfix'|'resolved'|'closed', fingerprintHash?: string }} [opts]
   */
  async replyToThread(threadId, body, opts) { return githubWrite.replyToThread(this, threadId, body, opts); }

  async patchThreadStatus(threadId, status, opts) { return githubWrite.patchThreadStatus(this, threadId, status, opts); }

  /**
   * @param {string} markerKey
   * @param {string} body
   * @returns {Promise<import('./provider.types.js').SummaryUpsertResult>}
   */
  async upsertSummaryComment(markerKey, body) { return githubWrite.upsertSummaryComment(this, markerKey, body); }

  /** @param {string} markerKey @returns {Promise<{ id: string, action: 'deleted'|'absent' }>} */
  async deleteBotComment(markerKey) { return githubWrite.deleteBotComment(this, markerKey); }
}

module.exports = {
  GitHubReviewProvider,
  __test__: { isBotComment: githubThreads.isBotComment, toTypedError },
};

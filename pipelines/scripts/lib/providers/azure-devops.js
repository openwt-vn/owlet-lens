// @ts-check
'use strict';

const { IReviewProvider, defaultCapabilities } = require('./provider.types.js');
const { AuthError, ProviderError } = require('../errors.js');
const { withRetry, requestRetry } = require('../retry.js');
const { makeMarkerCodec } = require('../marker-codec.js');
const { fingerprint } = require('../fingerprint.js');
const { safeMsg } = require('../log-safe.js');
const markers = require('../markers.js');
const { httpError } = require('./http-error.js');
const azureTlGate = require('./azure-tl-gate.js');

const ORIGIN = { provider: 'azure-devops', label: 'Azure DevOps' };
const API_VERSION = '7.1';
const PAGE_SIZE = 200;

/** @param {string} changeType @returns {'add'|'modify'|'delete'|'rename'} */
function mapChangeType(changeType) {
  const t = (changeType ?? '').toLowerCase();
  if (t === 'add') return 'add';
  if (t === 'delete') return 'delete';
  if (t === 'rename') return 'rename';
  return 'modify';
}

/** Azure service identity: a `svc.` descriptor or the `isContainer` system flag. */
function isServiceIdentity(author) {
  const a = author ?? {};
  return (typeof a.descriptor === 'string' && a.descriptor.startsWith('svc.')) || a.isContainer === true;
}

/**
 * Stable identity keys for an Azure comment author / connectionData identity.
 * `id` is the identity GUID, normalized to lowercase because Azure REST
 * endpoints are inconsistent about GUID casing between endpoints (e.g.
 * connectionData vs. thread comment authors); `descriptor` is the wire-safe
 * identity handle and is case-exact.
 * @param {any} identity
 * @returns {string[]}
 */
function identityKeys(identity) {
  const keys = [];
  if (identity && typeof identity.id === 'string' && identity.id) keys.push(`id:${identity.id.toLowerCase()}`);
  if (identity && typeof identity.descriptor === 'string' && identity.descriptor) keys.push(`d:${identity.descriptor}`);
  return keys;
}

/**
 * Is this comment authored by our bot?
 *
 * The service identity is authoritative. Otherwise the author is matched
 * against the token's own identity (`selfKeys`, resolved from connectionData or
 * learned from our own write responses). Only when the identity is unknown
 * (`selfKeys` empty — connectionData unavailable and nothing posted yet) do we
 * degrade to the marker heuristic, using the configured `markerPrefix` so
 * legacy bot comments stay recognisable; a human quoting a marker can only be
 * misattributed in that already-degraded state.
 *
 * This means cross-run recognition assumes the same credential posts and reads
 * (review and learn). If the credential is rotated to a *different* account,
 * its connectionData resolves, `selfKeys` is non-empty, and comments authored
 * by the old account are deliberately NOT recognised — the marker heuristic is
 * not consulted on an identity mismatch, because that is exactly the case a
 * human quoting a marker would exploit. Re-run review under the new credential
 * (its own posts are learned), or treat the old threads as human.
 *
 * @param {any} comment
 * @param {Set<string>} [selfKeys]
 * @param {string} [markerPrefix] consulted only when `selfKeys` is empty
 */
function isBotComment(comment, selfKeys, markerPrefix) {
  const a = comment?.author ?? {};
  if (isServiceIdentity(a)) return true;
  if (selfKeys && selfKeys.size > 0) {
    return identityKeys(a).some((k) => selfKeys.has(k));
  }
  if (typeof markerPrefix === 'string' && markerPrefix) {
    return (comment?.content ?? '').includes(`<!-- ${markerPrefix}:`);
  }
  return false;
}

/** Our status -> Azure native. Azure is the ONLY provider with native wontFix. */
function toAzureStatus(status) {
  if (status === 'wontfix') return 'wontFix';
  if (status === 'resolved') return 'fixed';
  if (status === 'active' || status === 'fixed' || status === 'closed') return status;
  return 'active';
}

/** Azure native -> our canonical status. */
function fromAzureStatus(azureStatus) {
  const s = (azureStatus ?? '').toLowerCase();
  if (s === 'wontfix' || s === 'bydesign') return 'wontfix';
  if (s === 'active' || s === 'fixed' || s === 'closed') return s;
  return 'active';
}

// Azure thread statuses that mean "closed on screen". `active` (and the
// unknown fallback) are the open ones.
const AZURE_TERMINAL_STATUSES = new Set(['fixed', 'closed', 'wontfix']);

class AzureDevOpsReviewProvider extends IReviewProvider {
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
      opts.config?.auth?.azureToken ?? opts.env.AZURE_DEVOPS_TOKEN ?? opts.env.SYSTEM_ACCESSTOKEN ?? opts.env.AI_REVIEW_TOKEN;
    if (!token) {
      throw new AuthError(
        'Azure DevOps token missing (AZURE_DEVOPS_TOKEN, SYSTEM_ACCESSTOKEN, or auth.azureToken)',
        { provider: 'azure-devops', status: 401 },
      );
    }

    const orgUrl = (opts.config?.azure?.orgUrl ?? opts.env.AZURE_DEVOPS_ORG_URL ?? opts.env.SYSTEM_COLLECTIONURI ?? '').replace(/\/+$/, '');
    const project = opts.config?.azure?.project ?? opts.env.SYSTEM_TEAMPROJECT ?? '';
    const repoId = opts.config?.azure?.repoId ?? opts.env.BUILD_REPOSITORY_ID ?? opts.env.BUILD_REPOSITORY_NAME ?? '';

    if (!orgUrl) throw new ProviderError('Azure DevOps orgUrl missing (AZURE_DEVOPS_ORG_URL, SYSTEM_COLLECTIONURI or azure.orgUrl)', { provider: 'azure-devops' });
    if (!project) throw new ProviderError('Azure DevOps project missing (SYSTEM_TEAMPROJECT or azure.project)', { provider: 'azure-devops' });
    if (!repoId) throw new ProviderError('Azure DevOps repoId missing (BUILD_REPOSITORY_ID or azure.repoId)', { provider: 'azure-devops' });

    const requirePr = opts.requirePr !== false;
    const prId = opts.config?.azure?.prId ?? opts.env.SYSTEM_PULLREQUEST_PULLREQUESTID ?? null;
    if (requirePr && !prId) {
      throw new ProviderError('Azure DevOps PR id missing (SYSTEM_PULLREQUEST_PULLREQUESTID or azure.prId)', { provider: 'azure-devops' });
    }

    // PAT uses Basic auth with empty username; System.AccessToken uses Bearer
    const tokenType = opts.config?.azure?.tokenType ?? (opts.env.SYSTEM_ACCESSTOKEN ? 'bearer' : 'pat');

    this.orgUrl = orgUrl;
    this.project = project;
    this.repoId = repoId;
    this.env = opts.env ?? process.env;
    this.prId = prId ? String(prId) : null;
    this.runId = opts.env.BUILD_BUILDID ?? null;
    const repoName = opts.env.BUILD_REPOSITORY_NAME ?? '';
    this.repoSlug = repoName ? `${project}/${repoName}` : null;
    this.token = token;
    this.tokenType = tokenType;
    this.markerPrefix = opts.config?.markers?.prefix ?? 'ai-review';
    this._fetchImpl = opts.deps?.fetch ?? globalThis.fetch;
    this._sleep = opts.deps?.sleep;
    this.codec = makeMarkerCodec({ prefix: this.markerPrefix, style: 'html' });
    /** @type {string|null} cached default branch */
    this._defaultBranch = null;
    /** @type {Set<string>} identity keys of the token's own account (the bot) */
    this._selfKeys = new Set();
    /** @type {boolean} whether we've attempted the connectionData identity lookup */
    this._selfResolved = false;
  }

  get capabilities() {
    return {
      ...defaultCapabilities(),
      nativeWontFix: true,
      supportsFileContent: true,
      canProposeChanges: true,
    };
  }

  /** This provider's marker codec (HTML-comment style, same as GitHub). */
  get markers() { return this.codec; }

  _baseUrl() {
    return `${this.orgUrl}/${this.project}/_apis/git/repositories/${encodeURIComponent(this.repoId)}`;
  }

  _authHeader() {
    return this.tokenType === 'bearer'
      ? `Bearer ${this.token}`
      : `Basic ${Buffer.from(`:${this.token}`).toString('base64')}`;
  }

  /** Append api-version to a path relative to _baseUrl(). */
  _url(path) {
    return `${this._baseUrl()}${path}${path.includes('?') ? '&' : '?'}api-version=${API_VERSION}`;
  }

  /**
   * One API request, retried on its own (ADR-0013): a POST is repeated only
   * when Azure DevOps provably did not apply it.
   * @param {string} method @param {string} url @param {{ body?: any, raw?: boolean }} [opts]
   * @returns {Promise<any>}
   */
  async _api(method, url, opts = {}) {
    return withRetry(() => this._apiOnce(method, url, opts), requestRetry(method, url, { sleep: this._sleep }));
  }

  /** @param {string} method @param {string} url @param {{ body?: any, raw?: boolean }} opts */
  async _apiOnce(method, url, opts) {
    const headers = { Authorization: this._authHeader(), Accept: opts.raw ? 'text/plain' : 'application/json' };
    let body;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await this._fetchImpl(url, { method, headers, body });
    // 203 = invalid/expired PAT (HTML sign-in page, not JSON). It is a 2xx, so
    // it must be caught before the !res.ok mapping below.
    if (res.status === 203) {
      throw new AuthError('Azure DevOps auth failed (203)', { provider: 'azure-devops', status: 203 });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw httpError(ORIGIN, method, url, res, text);
    }
    if (res.status === 204) return null;
    return opts.raw ? res.text() : res.json();
  }

  _requirePr() {
    if (!this.prId) {
      throw new ProviderError('Operation requires a PR id (SYSTEM_PULLREQUEST_PULLREQUESTID not set)', { provider: 'azure-devops' });
    }
    return this.prId;
  }

  _logWarn(msg, extra) {
    process.stderr.write(JSON.stringify({ level: 'warn', msg, ...extra }) + '\n');
  }

  /**
   * Record identity keys for the token's own account. Called with the
   * `authenticatedUser` from connectionData and with the author of every write
   * response, so identity is learned even if connectionData is unavailable.
   * @param {any} identity
   */
  _recordIdentity(identity) {
    for (const key of identityKeys(identity)) this._selfKeys.add(key);
  }

  /**
   * Learn our own identity from a thread or comment write response.
   * @param {any} res
   */
  _recordSelf(res) {
    if (!res) return;
    if (res.author) this._recordIdentity(res.author);
    for (const c of res.comments ?? []) this._recordIdentity(c.author);
  }

  /**
   * Resolve the token's own identity once per run via `connectionData`, so
   * comments are attributed by author rather than by marker text. Retried like
   * every other endpoint (a transient 5xx must not permanently degrade
   * attribution for the run). Non-fatal: on failure we warn and fall back to
   * identities learned from our own writes.
   * @returns {Promise<void>}
   */
  async _ensureSelfIdentity() {
    if (this._selfResolved) return;
    this._selfResolved = true;
    try {
      const data = await this._api('GET', `${this.orgUrl}/_apis/connectionData?api-version=${API_VERSION}`);
      this._recordIdentity(data?.authenticatedUser);
    } catch (e) {
      this._logWarn('could not resolve bot identity from connectionData', { errMessage: safeMsg(e) });
    }
  }

  /** @param {any} comment @returns {boolean} */
  _isBotComment(comment) {
    return isBotComment(comment, this._selfKeys, this.markerPrefix);
  }

  /**
   * OData-style pagination ($skip/$top). Azure DevOps list endpoints return `{ value: T[] }`.
   * @template T @param {string} basePath @param {{ limit?: number }} [opts] @returns {Promise<T[]>}
   */
  async _paginate(basePath, opts = {}) {
    const limit = opts.limit ?? Infinity;
    const all = [];
    for (let skip = 0, i = 0; i < 1000 && all.length < limit; i++, skip += PAGE_SIZE) {
      const sep = basePath.includes('?') ? '&' : '?';
      const page = await this._api('GET', this._url(`${basePath}${sep}$skip=${skip}&$top=${PAGE_SIZE}`));
      const values = page?.value ?? [];
      for (const v of values) { all.push(v); if (all.length >= limit) break; }
      if (values.length < PAGE_SIZE) break;
    }
    return all;
  }

  async getPRMetadata() {
    const prId = this._requirePr();
    const pr = await this._api('GET', this._url(`/pullRequests/${prId}`));
    return {
      id: String(pr.pullRequestId),
      sourceBranch: (pr.sourceRefName ?? '').replace(/^refs\/heads\//, ''),
      targetBranch: (pr.targetRefName ?? '').replace(/^refs\/heads\//, ''),
      sourceSha: pr.lastMergeSourceCommit?.commitId ?? '',
      targetSha: pr.lastMergeTargetCommit?.commitId ?? '',
      title: pr.title ?? '',
      description: pr.description ?? '',
      authorEmail: pr.createdBy?.uniqueName ?? pr.createdBy?.displayName ?? '',
      url: `${this.orgUrl}/${this.project}/_git/${encodeURIComponent(this.repoId)}/pullrequest/${pr.pullRequestId}`,
    };
  }

  /** Was this run a queued "turn the AI on" policy build, and who queued it? @returns {Promise<import('./provider.types.js').TriggerInfo>} */
  async getTriggerInfo() { return azureTlGate.triggerInfo(this); }

  /** @param {string} markerKey @returns {Promise<import('./provider.types.js').BotComment|null>} */
  async findBotComment(markerKey) { return azureTlGate.findBotComment(this, markerKey); }

  async getDiff() {
    const prId = this._requirePr();
    const iterations = await this._api('GET', this._url(`/pullRequests/${prId}/iterations`));
    const iterList = iterations?.value ?? [];
    if (iterList.length === 0) return [];
    const iterationId = iterList[iterList.length - 1].id;
    const changes = await this._api('GET', this._url(`/pullRequests/${prId}/iterations/${iterationId}/changes?$top=1000`));

    // Cache sourceSha once (avoid repeated getPRMetadata inside the loop)
    const meta = await this.getPRMetadata();
    /** @type {import('./provider.types.js').DiffFile[]} */
    const diffs = [];
    for (const entry of (changes?.changeEntries ?? [])) {
      const item = entry.item ?? {};
      if (item.isFolder) continue;
      const filePath = (item.path ?? '').replace(/^\//, '');
      if (!filePath) continue;
      const change = mapChangeType(entry.changeType);
      if (change === 'delete') { diffs.push({ path: filePath, change, patch: '' }); continue; }
      // Azure DevOps has no unified-diff endpoint; synthesise a minimal patch
      // from the file content at the PR source commit. A fetch that still fails
      // after its retries fails the run: an empty patch would hide the file.
      const content = await this.getFileContent(filePath, meta.sourceSha);
      if (content == null) { diffs.push({ path: filePath, change, patch: '' }); continue; }
      const lines = content.split('\n');
      const patch = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');
      const oldPath = entry.sourceServerItem ? entry.sourceServerItem.replace(/^\//, '') : undefined;
      diffs.push({ path: filePath, change, patch, ...(oldPath ? { oldPath } : {}) });
    }
    return diffs;
  }

  /**
   * @param {string} filePath
   * @param {string} ref
   * @returns {Promise<string|null>}
   */
  async getFileContent(filePath, ref) {
    const encodedPath = encodeURIComponent(filePath);
    const url = this._url(
      `/items?path=${encodedPath}&versionDescriptor.version=${encodeURIComponent(ref)}&versionDescriptor.versionType=commit`,
    );
    try {
      return await this._api('GET', url, { raw: true });
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) return null;
      throw e;
    }
  }

  /** @param {any[]} rawThreads @returns {import('./provider.types.js').ReviewThread[]} */
  _mapThreads(rawThreads) {
    const result = [];
    for (const thread of rawThreads) {
      if (thread.isDeleted) continue;
      const comments = (thread.comments ?? []).filter((c) => !c.isDeleted);
      if (comments.length === 0) continue;
      const ctx = thread.threadContext;
      const filePath = ctx?.filePath?.replace(/^\//, '') ?? '';
      const line = ctx?.rightFileStart?.line ?? ctx?.rightFileEnd?.line ?? 0;
      const azureStatus = fromAzureStatus(thread.status);
      const rootParsed = markers.parseMarkers(comments[0]?.content ?? '', this.markerPrefix, 'html');
      let latestStatus = rootParsed.status;
      let latestVersion = rootParsed.version;
      for (let i = comments.length - 1; i >= 0; i--) {
        if (!this._isBotComment(comments[i])) continue;
        const parsed = markers.parseMarkers(comments[i].content ?? '', this.markerPrefix, 'html');
        if (parsed.status) { latestStatus = parsed.status; if (parsed.version) latestVersion = parsed.version; break; }
      }
      result.push({
        id: String(thread.id),
        status: latestStatus ?? azureStatus,
        // Azure's own thread status as resolved/open. Azure has no separate
        // resolve flag, so this reads `azureStatus` — already normalized by
        // fromAzureStatus above, which is why the set holds lowercase values
        // while the raw API tokens are `Fixed`/`WontFix`/`Closed`. Raw
        // `byDesign` normalizes to `wontfix`, so it is covered too.
        platformResolved: AZURE_TERMINAL_STATUSES.has(azureStatus),
        filePath,
        line,
        comments: comments.map((c) => ({
          id: String(c.id),
          authorEmail: c.author?.uniqueName ?? c.author?.displayName ?? '',
          body: c.content ?? '',
          createdAt: c.publishedDate ?? c.lastUpdatedDate ?? '',
          isBot: this._isBotComment(c),
        })),
        marker: { version: latestVersion, fingerprint: rootParsed.fingerprint },
      });
    }
    return result;
  }

  async listThreads() {
    const prId = this._requirePr();
    await this._ensureSelfIdentity();
    const rawThreads = await this._api('GET', this._url(`/pullRequests/${prId}/threads`));
    return this._mapThreads(rawThreads?.value ?? []);
  }

  /** @param {string} prId @returns {Promise<import('./provider.types.js').ReviewThread[]>} */
  async listThreadsForPR(prId) {
    await this._ensureSelfIdentity();
    const rawThreads = await this._api('GET', this._url(`/pullRequests/${prId}/threads`));
    return this._mapThreads(rawThreads?.value ?? []);
  }

  /** @param {import('./provider.types.js').NewThread} thread @returns {Promise<{ id: string }>} */
  async postThread(thread) {
    const prId = this._requirePr();
    const fp = fingerprint(thread.filePath, thread.line, thread.ruleId ?? '');
    const content = this.codec.appendStatus(thread.body, thread.status, fp);
    const payload = { comments: [{ content, commentType: 1 }], status: toAzureStatus(thread.status) };
    if (thread.filePath) {
      payload.threadContext = {
        filePath: `/${thread.filePath}`,
        rightFileStart: { line: thread.line, offset: 1 },
        rightFileEnd: { line: thread.line, offset: 1 },
      };
    }
    const res = await this._api('POST', this._url(`/pullRequests/${prId}/threads`), { body: payload });
    this._recordSelf(res);
    return { id: String(res.id) };
  }

  /**
   * @param {string} threadId
   * @param {string} body
   * @param {{ status?: import('./provider.types.js').ThreadStatus, fingerprintHash?: string }} [opts]
   * @returns {Promise<{ id: string }>}
   */
  async replyToThread(threadId, body, opts) {
    const prId = this._requirePr();
    const content = opts?.status
      ? this.codec.appendStatus(body, opts.status, opts.fingerprintHash)
      : body;

    const res = await this._api(
      'POST',
      this._url(`/pullRequests/${prId}/threads/${threadId}/comments`),
      { body: { content, commentType: 1, parentCommentId: 1 } },
    );
    this._recordSelf(res);
    return { id: String(res.id) };
  }

  /** @param {string} threadId @param {import('./provider.types.js').ThreadStatus} status @param {{ skipMarkerReply?: boolean }} [opts] */
  async patchThreadStatus(threadId, status, opts) {
    const prId = this._requirePr();
    const failures = [];
    const tryStep = async (stage, fn) => {
      try { await fn(); } catch (e) {
        const err = /** @type {any} */ (e);
        if (stage === 'statusPatch' && e instanceof ProviderError && (e.status === 401 || e.status === 403)) {
          this._logWarn(`patchThreadStatus.${stage} skipped (scope insufficient)`, { threadId });
          return;
        }
        process.stderr.write(JSON.stringify({ level: 'error', msg: `patchThreadStatus.${stage} failed`, threadId, errName: err?.name, errMessage: safeMsg(err), errStatus: err?.status }) + '\n');
        failures.push({ stage, err });
      }
    };
    // Marker reply first (canonical for cross-run reconcile), then native patch.
    if (opts?.skipMarkerReply !== true) {
      await tryStep('reply', () => this.replyToThread(threadId, this.codec.statusReplyText(status), { status }));
    }
    await tryStep('statusPatch', () => this._api('PATCH', this._url(`/pullRequests/${prId}/threads/${threadId}`), { body: { status: toAzureStatus(status) } }));
    if (failures.length > 0) {
      throw new ProviderError(`patchThreadStatus(${threadId}, ${status}) partial failure: ${failures.map((f) => f.stage).join(', ')}`, { provider: 'azure-devops', retryable: false });
    }
  }

  /** @param {string} markerKey @param {string} body @returns {Promise<import('./provider.types.js').SummaryUpsertResult>} */
  async upsertSummaryComment(markerKey, body) {
    const prId = this._requirePr();
    await this._ensureSelfIdentity();
    const rawThreads = await this._api('GET', this._url(`/pullRequests/${prId}/threads`));
    // Find existing PR-level (no threadContext) bot-authored summary thread.
    const existing = (rawThreads?.value ?? []).find((t) => {
      if (t.threadContext) return false;
      const root = (t.comments ?? []).filter((c) => !c.isDeleted)[0];
      return root && this.codec.hasKey(root.content ?? '', markerKey) && this._isBotComment(root);
    });
    if (existing) {
      const root = (existing.comments ?? []).filter((c) => !c.isDeleted)[0];
      if (root) {
        try {
          await this._api('PATCH', this._url(`/pullRequests/${prId}/threads/${existing.id}/comments/${root.id}`), { body: { content: body } });
          return { id: String(existing.id), action: 'updated' };
        } catch (e) { if (!(e instanceof ProviderError && e.status === 404)) throw e; }
      }
    }
    const res = await this._api('POST', this._url(`/pullRequests/${prId}/threads`), { body: { comments: [{ content: body, commentType: 1 }], status: 'closed' } });
    this._recordSelf(res);
    return { id: String(res.id), action: 'created' };
  }

  /** @param {string} markerKey @returns {Promise<{ id: string, action: 'deleted'|'absent' }>} */
  async deleteBotComment(markerKey) {
    const prId = this._requirePr();
    await this._ensureSelfIdentity();
    const rawThreads = await this._api('GET', this._url(`/pullRequests/${prId}/threads`));
    const existing = (rawThreads?.value ?? []).find((t) => {
      if (t.threadContext) return false;
      const root = (t.comments ?? []).filter((c) => !c.isDeleted)[0];
      return root && this.codec.hasKey(root.content ?? '', markerKey) && this._isBotComment(root);
    });
    if (!existing) return { id: '', action: 'absent' };
    const root = (existing.comments ?? []).filter((c) => !c.isDeleted)[0];
    if (!root) return { id: String(existing.id), action: 'absent' };
    try {
      // Soft-delete the root comment; Azure keeps the thread shell.
      await this._api(
        'PATCH',
        this._url(`/pullRequests/${prId}/threads/${existing.id}/comments/${root.id}`),
        { body: { isDeleted: true } },
      );
      return { id: String(existing.id), action: 'deleted' };
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) {
        return { id: String(existing.id), action: 'absent' };
      }
      throw e;
    }
  }

  /** @returns {Promise<string>} */
  async getDefaultBranch() {
    if (this._defaultBranch) return this._defaultBranch;
    const repo = await this._api('GET', this._url(''));
    const raw = repo?.defaultBranch ?? 'refs/heads/main';
    this._defaultBranch = raw.replace(/^refs\/heads\//, '');
    return this._defaultBranch;
  }

  /** @param {{ sinceISO: string, limit?: number }} opts */
  async listMergedPRs({ sinceISO, limit = 200 }) {
    const params = `searchCriteria.status=completed&searchCriteria.minTime=${encodeURIComponent(sinceISO)}&$orderby=closedDate desc`;
    const prs = await this._paginate(`/pullRequests?${params}`, { limit });
    return prs.map((pr) => ({
      id: String(pr.pullRequestId),
      title: pr.title ?? '',
      mergedAt: pr.closedDate ?? '',
      authorEmail: pr.createdBy?.uniqueName ?? pr.createdBy?.displayName ?? '',
      url: `${this.orgUrl}/${this.project}/_git/${encodeURIComponent(this.repoId)}/pullrequest/${pr.pullRequestId}`,
    }));
  }

  /** @param {{ branch: string, filePath: string, newContent: string, baseBranch: string, title: string, body: string }} opts */
  async proposeStandardsChange({ branch, filePath, newContent, baseBranch, title, body }) {
    const apiPath = String(filePath).replace(/^\.\//, '').replace(/^\/+/, '');
    // Resolve baseBranch head
    const refs = await this._api('GET', this._url(`/refs?filter=heads/${encodeURIComponent(baseBranch)}`));
    const baseOid = (refs?.value ?? [])[0]?.objectId;
    if (!baseOid) throw new ProviderError(`Cannot resolve head of '${baseBranch}'`, { provider: 'azure-devops' });
    // Determine add vs edit
    let existing = null;
    try {
      existing = await this.getFileContent(apiPath, baseOid);
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) { /* new file */ } else throw e;
    }
    // Atomic push: create branch + commit; retry on 409 (branch already exists from prior run)
    const changeEntry = { changeType: existing !== null ? 'edit' : 'add', item: { path: `/${apiPath}` }, newContent: { content: newContent, contentType: 'rawtext' } };
    let push;
    try {
      push = await this._api('POST', this._url('/pushes'), {
        body: { refUpdates: [{ name: `refs/heads/${branch}`, oldObjectId: baseOid }], commits: [{ comment: title, changes: [changeEntry] }] },
      });
    } catch (e) {
      if (!(e instanceof ProviderError && e.status === 409)) throw e;
      // Branch exists — resolve its current head and force-update
      const branchRefs = await this._api('GET', this._url(`/refs?filter=heads/${encodeURIComponent(branch)}`));
      const existingOid = (branchRefs?.value ?? [])[0]?.objectId;
      if (!existingOid) throw e;
      push = await this._api('POST', this._url('/pushes'), {
        body: { refUpdates: [{ name: `refs/heads/${branch}`, oldObjectId: existingOid }], commits: [{ comment: title, changes: [changeEntry] }] },
      });
    }
    if (!push) throw new ProviderError('Push failed', { provider: 'azure-devops' });
    // Open PR (idempotent: 409 = reuse existing)
    let pr;
    try {
      pr = await this._api('POST', this._url('/pullRequests'), { body: { title, description: body, sourceRefName: `refs/heads/${branch}`, targetRefName: `refs/heads/${baseBranch}` } });
    } catch (e) {
      if (!(e instanceof ProviderError && e.status === 409)) throw e;
      const found = await this._paginate(`/pullRequests?searchCriteria.status=active&searchCriteria.sourceRefName=refs/heads/${encodeURIComponent(branch)}`, { limit: 1 });
      pr = found[0];
      if (!pr) throw e;
    }
    return { url: pr._links?.web?.href ?? `${this.orgUrl}/${this.project}/_git/${encodeURIComponent(this.repoId)}/pullrequest/${pr.pullRequestId}` };
  }
}

module.exports = { AzureDevOpsReviewProvider, __test__: { isBotComment, identityKeys, toAzureStatus, fromAzureStatus, mapChangeType } };

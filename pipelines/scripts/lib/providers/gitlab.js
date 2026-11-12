// @ts-check
'use strict';

const { IReviewProvider, defaultCapabilities } = require('./provider.types.js');
const { AuthError, ProviderError } = require('../errors.js');
const { makeMarkerCodec } = require('../marker-codec.js');
const { fingerprint } = require('../fingerprint.js');
const markers = require('../markers.js');
const { safeMsg } = require('../log-safe.js');
const { withRetry, requestRetry } = require('../retry.js');
const { httpError } = require('./http-error.js');

const ORIGIN = { provider: 'gitlab', label: 'GitLab' };

/** @param {any} note @returns {boolean} */
function isBotNote(note) {
  const author = note?.author;
  if (!author) return false;
  if (author.bot === true) return true;
  const name = (author.username ?? author.name ?? '').toLowerCase();
  return /\bbot\b|ci-token|project_\d+_bot/.test(name);
}

/** @param {boolean} n @param {boolean} d @param {boolean} r @returns {'add'|'modify'|'delete'|'rename'} */
function mapChange(n, d, r) {
  if (n) return 'add';
  if (d) return 'delete';
  if (r) return 'rename';
  return 'modify';
}

class GitLabReviewProvider extends IReviewProvider {
  /**
   * @param {{
   *   config: any, env: NodeJS.ProcessEnv,
   *   requirePr?: boolean,
   *   deps?: { fetch?: typeof fetch, sleep?: (ms: number) => Promise<void> },
   * }} opts
   */
  constructor(opts) {
    super();
    const env = opts.env ?? process.env;
    const token = opts.config?.auth?.gitlabToken ?? env.GITLAB_TOKEN ?? env.CI_JOB_TOKEN ?? env.AI_REVIEW_TOKEN;
    if (!token) throw new AuthError('GitLab token missing (GITLAB_TOKEN, CI_JOB_TOKEN, or auth.gitlabToken)', { provider: 'gitlab', status: 401 });
    const projectId = env.CI_PROJECT_ID ?? opts.config?.gitlab?.projectId ?? '';
    if (!projectId) throw new ProviderError('GitLab project ID missing (CI_PROJECT_ID or gitlab.projectId)', { provider: 'gitlab' });
    const mrIid = env.CI_MERGE_REQUEST_IID ?? env.GITLAB_MR_IID ?? opts.config?.gitlab?.mrIid ?? null;
    if (opts.requirePr !== false && !mrIid) {
      throw new ProviderError('GitLab MR iid missing (CI_MERGE_REQUEST_IID)', { provider: 'gitlab' });
    }
    this.token = token;
    this.env = env;
    this.projectId = encodeURIComponent(String(projectId));
    this.mrIid = mrIid != null ? String(mrIid) : null;
    this.runId = env.CI_PIPELINE_ID ?? null;
    this.repoSlug = env.CI_PROJECT_PATH ?? null;
    const baseUrl = opts.config?.gitlab?.baseUrl ?? env.CI_SERVER_URL ?? 'https://gitlab.com';
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiBase = `${this.baseUrl}/api/v4`;
    this.markerPrefix = opts.config?.markers?.prefix ?? 'ai-review';
    this.codec = makeMarkerCodec({ prefix: this.markerPrefix, style: 'html' });
    this._fetch = opts.deps?.fetch ?? globalThis.fetch;
    this._sleep = opts.deps?.sleep;
    this._authHeader = env.CI_JOB_TOKEN && token === env.CI_JOB_TOKEN ? 'JOB-TOKEN' : 'PRIVATE-TOKEN';
    /** @type {{ base_commit_sha: string, head_commit_sha: string, start_commit_sha: string }|null} */
    this._diffRefs = null;
    /** @type {string|null} */
    this._defaultBranch = null;
  }

  get capabilities() {
    return { ...defaultCapabilities(), nativeWontFix: false, supportsFileContent: true, canProposeChanges: true };
  }
  get markers() { return this.codec; }

  // -- HTTP helpers -----------------------------------------------------------

  /**
   * One API request, retried on its own (ADR-0013): a POST is repeated only
   * when GitLab provably did not apply it.
   * @param {string} path @param {{ method?: string, body?: any, raw?: boolean, headers?: Record<string,string> }} [opts]
   */
  async _api(path, opts = {}) {
    const method = opts.method ?? 'GET';
    const url = `${this.apiBase}${path}`;
    return withRetry(() => this._apiOnce(method, url, opts), requestRetry(method, url, { sleep: this._sleep }));
  }

  /** @param {string} method @param {string} url @param {{ body?: any, raw?: boolean, headers?: Record<string,string> }} opts */
  async _apiOnce(method, url, opts) {
    /** @type {Record<string, string>} */
    const headers = { [this._authHeader]: this.token, Accept: opts.raw ? 'text/plain' : 'application/json', ...opts.headers };
    let body;
    if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
    const res = await this._fetch(url, { method, headers, body });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw httpError(ORIGIN, method, url, res, text);
    }
    if (res.status === 204) return null;
    return opts.raw ? res.text() : res.json();
  }

  /** Paginated GET using GitLab's x-next-page header. @param {string} path @returns {Promise<any[]>} */
  async _paginate(path) {
    const all = [];
    const sep = path.includes('?') ? '&' : '?';
    let url = `${this.apiBase}${path}${sep}per_page=100`;
    for (let i = 0; i < 1000 && url; i++) {
      const { data, nextPage } = await withRetry(async () => {
        const res = await this._fetch(url, {
          method: 'GET', headers: { [this._authHeader]: this.token, Accept: 'application/json' },
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw httpError(ORIGIN, 'GET', url, res, text);
        }
        return { data: await res.json(), nextPage: res.headers.get('x-next-page') };
      }, requestRetry('GET', url, { sleep: this._sleep }));
      if (Array.isArray(data)) for (const item of data) all.push(item);
      if (!nextPage || nextPage === '') break;
      const base = new URL(url);
      base.searchParams.set('page', nextPage);
      const nextUrl = base.toString();
      if (nextUrl === url) break;
      url = nextUrl;
    }
    return all;
  }

  _requireMr(mrIid) {
    const iid = mrIid ?? this.mrIid;
    if (!iid) throw new ProviderError('Operation requires an MR iid (mrIid not set)', { provider: 'gitlab' });
    return iid;
  }
  _mrPath(mrIid) { return `/projects/${this.projectId}/merge_requests/${mrIid ?? this._requireMr()}`; }

  /** @param {string} msg @param {Record<string, any>} [extra] */
  _logWarn(msg, extra) {
    process.stderr.write(JSON.stringify({ level: 'warn', msg, provider: 'gitlab', ...extra }) + '\n');
  }

  // -- IReviewProvider --------------------------------------------------------

  async getPRMetadata() {
    const iid = this._requireMr();
    const mr = await this._api(this._mrPath(iid));
    if (mr.diff_refs) this._diffRefs = mr.diff_refs;
    return {
      id: String(mr.iid), sourceBranch: mr.source_branch ?? '', targetBranch: mr.target_branch ?? '',
      sourceSha: mr.diff_refs?.head_sha ?? mr.sha ?? '', targetSha: mr.diff_refs?.base_sha ?? '',
      title: mr.title ?? '', description: mr.description ?? '',
      authorEmail: mr.author?.email ?? mr.author?.username ?? '', url: mr.web_url ?? '',
    };
  }

  /**
   * Did a human press the manual job ("Play") on this MR pipeline, and who?
   * `CI_JOB_MANUAL` is "true when available", i.e. only on a job a human
   * started, and `GITLAB_USER_ID` is "the ID of the user who started the job" in
   * a manual job — the numeric id `review.tlGate.leads` holds. A pipeline push
   * leaves `CI_JOB_MANUAL` unset, which is what keeps a push from turning the AI
   * on.
   * @returns {Promise<import('./provider.types.js').TriggerInfo>}
   */
  getTriggerInfo() {
    const manual = String(this.env.CI_JOB_MANUAL ?? '').trim().toLowerCase() === 'true';
    return Promise.resolve({
      manual,
      actorId: manual ? (this.env.GITLAB_USER_ID ?? null) : null,
      actorLabel: manual ? (this.env.GITLAB_USER_LOGIN ?? null) : null,
      howToTurnOn: 'On the merge request pipeline, press **Play** on the `owlet-lens-review-tl` job.',
    });
  }

  /**
   * The bot's own MR note carrying `markerKey`, or null. `editedByOther` is
   * always false: GitLab lets Maintainers and Owners "Edit comments posted by
   * other users", and this version does not read who edited a note — an accepted
   * limit, not a claim that edits cannot happen.
   * @param {string} markerKey
   * @returns {Promise<import('./provider.types.js').BotComment|null>}
   */
  async findBotComment(markerKey) {
    const iid = this._requireMr();
    const notes = await this._paginate(`${this._mrPath(iid)}/notes`);
    const hit = notes.find((/** @type {any} */ n) => this.codec.hasKey(n.body ?? '', markerKey) && isBotNote(n));
    if (!hit) return null;
    return {
      id: String(hit.id),
      body: hit.body ?? '',
      createdAt: hit.created_at ?? '',
      editedByOther: false,
    };
  }

  async getDiff() {
    const iid = this._requireMr();
    const diffs = await this._paginate(`${this._mrPath(iid)}/diffs`);
    return diffs.map((d) => {
      /** @type {import('./provider.types.js').DiffFile} */
      const entry = { path: d.new_path ?? d.old_path ?? '', change: mapChange(!!d.new_file, !!d.deleted_file, !!d.renamed_file), patch: d.diff ?? '' };
      if (d.renamed_file && d.old_path && d.old_path !== entry.path) entry.oldPath = d.old_path;
      return entry;
    });
  }

  /** @param {string} filePath @param {string} ref @returns {Promise<string|null>} */
  async getFileContent(filePath, ref) {
    try {
      return await this._api(
        `/projects/${this.projectId}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${encodeURIComponent(ref)}`,
        { raw: true },
      );
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) return null;
      throw e;
    }
  }

  /** @param {string} [mrIid] @returns {Promise<import('./provider.types.js').ReviewThread[]>} */
  async _buildThreads(mrIid) {
    const iid = this._requireMr(mrIid);
    const discussions = await this._paginate(`${this._mrPath(iid)}/discussions`);
    /** @type {import('./provider.types.js').ReviewThread[]} */
    const threads = [];
    for (const disc of discussions) {
      const notes = disc.notes ?? [];
      if (notes.length === 0) continue;
      const root = notes[0];
      if (root.type !== 'DiffNote' && root.position == null) continue;
      const filePath = root.position?.new_path ?? root.position?.old_path ?? '';
      const line = root.position?.new_line ?? root.position?.old_line ?? 0;
      const rootParsed = markers.parseMarkers(root.body ?? '', this.markerPrefix, 'html');
      let latestStatus = rootParsed.status;
      let latestVersion = rootParsed.version;
      for (let i = notes.length - 1; i >= 0; i--) {
        if (!isBotNote(notes[i])) continue;
        const parsed = markers.parseMarkers(notes[i].body ?? '', this.markerPrefix, 'html');
        if (parsed.status) { latestStatus = parsed.status; if (parsed.version) latestVersion = parsed.version; break; }
      }
      const resolved = disc.notes?.some((n) => n.resolved === true) ?? false;
      const status = latestStatus ?? (resolved ? 'resolved' : 'active');
      threads.push({
        id: String(disc.id), status, filePath, line,
        // GitLab's own resolve flag, kept alongside the marker-derived status so
        // a thread whose resolve call failed is detectable on a later run.
        platformResolved: resolved,
        comments: notes.map((n) => ({
          id: String(n.id), authorEmail: n.author?.email ?? n.author?.username ?? '',
          body: n.body ?? '', createdAt: n.created_at ?? '', isBot: isBotNote(n),
        })),
        marker: { version: latestVersion, fingerprint: rootParsed.fingerprint },
      });
    }
    return threads;
  }

  async listThreads() { return this._buildThreads(); }
  /** @param {string} prId */ async listThreadsForPR(prId) { return this._buildThreads(prId); }

  async _ensureDiffRefs() {
    if (this._diffRefs) return this._diffRefs;
    await this.getPRMetadata();
    if (!this._diffRefs) throw new ProviderError('Could not resolve diff_refs from MR metadata', { provider: 'gitlab' });
    return this._diffRefs;
  }

  /** @param {import('./provider.types.js').NewThread} thread @returns {Promise<{ id: string }>} */
  async postThread(thread) {
    const iid = this._requireMr();
    const diffRefs = await this._ensureDiffRefs();
    const fp = fingerprint(thread.filePath, thread.line, thread.ruleId ?? '');
    const body = this.codec.appendStatus(thread.body, thread.status, fp);
    const res = await this._api(`${this._mrPath(iid)}/discussions`, {
      method: 'POST',
      body: {
        body,
        position: {
          position_type: 'text', base_sha: diffRefs.base_sha,
          head_sha: diffRefs.head_sha, start_sha: diffRefs.start_sha,
          new_path: thread.filePath, new_line: thread.line,
        },
      },
    });
    return { id: String(res.id) };
  }

  /** @param {string} threadId @param {string} body @param {{ status?: import('./provider.types.js').ThreadStatus, fingerprintHash?: string }} [opts] */
  async replyToThread(threadId, body, opts) {
    const iid = this._requireMr();
    const raw = opts?.status ? this.codec.appendStatus(body, opts.status, opts.fingerprintHash) : body;
    const res = await this._api(`${this._mrPath(iid)}/discussions/${threadId}/notes`, {
      method: 'POST', body: { body: raw },
    });
    return { id: String(res.id) };
  }

  /** @param {string} threadId @param {import('./provider.types.js').ThreadStatus} status @param {{ skipMarkerReply?: boolean }} [opts] */
  async patchThreadStatus(threadId, status, opts) {
    const iid = this._requireMr();
    /** @type {Array<{ stage: string, err: any }>} */
    const failures = [];
    const tryStep = async (stage, fn) => {
      try { await fn(); } catch (e) {
        const err = /** @type {any} */ (e);
        if ((stage === 'resolve' || stage === 'unresolve')
            && err instanceof ProviderError && (err.status === 401 || err.status === 403)) {
          this._logWarn(`patchThreadStatus.${stage} skipped (token scope insufficient)`, { threadId,
            hint: 'GitLab token lacks permission to resolve discussions. Marker reply posted; cross-run reconcile still works.' });
          return;
        }
        process.stderr.write(JSON.stringify({ level: 'error', msg: `patchThreadStatus.${stage} failed`,
          threadId, errName: err?.name, errMessage: safeMsg(err), errStatus: err?.status }) + '\n');
        failures.push({ stage, err });
      }
    };
    const text = this.codec.statusReplyText(status);
    const skipReply = opts?.skipMarkerReply === true;
    if (status === 'active') {
      if (!skipReply) await tryStep('reply', () => this.replyToThread(threadId, text, { status: 'active' }));
      await tryStep('unresolve', () => this._api(`${this._mrPath(iid)}/discussions/${threadId}`, { method: 'PUT', body: { resolved: false } }));
    } else {
      if (!skipReply) await tryStep('reply', () => this.replyToThread(threadId, text, { status }));
      await tryStep('resolve', () => this._api(`${this._mrPath(iid)}/discussions/${threadId}`, { method: 'PUT', body: { resolved: true } }));
    }
    if (failures.length > 0) {
      throw new ProviderError(`patchThreadStatus(${threadId}, ${status}) partial failure: ${failures.map((f) => f.stage).join(', ')}`,
        { provider: 'gitlab', retryable: false });
    }
  }

  /** @param {string} markerKey @param {string} body @returns {Promise<import('./provider.types.js').SummaryUpsertResult>} */
  async upsertSummaryComment(markerKey, body) {
    const iid = this._requireMr();
    const notes = await this._paginate(`${this._mrPath(iid)}/notes`);
    const existing = notes.find((n) => this.codec.hasKey(n.body ?? '', markerKey) && isBotNote(n));
    if (existing) {
      try {
        const updated = await this._api(`${this._mrPath(iid)}/notes/${existing.id}`, { method: 'PUT', body: { body } });
        return { id: String(updated?.id ?? existing.id), action: 'updated' };
      } catch (e) {
        if (!(e instanceof ProviderError && e.status === 404)) throw e;
      }
    }
    const created = await this._api(`${this._mrPath(iid)}/notes`, { method: 'POST', body: { body } });
    return { id: String(created.id), action: 'created' };
  }

  /** @param {string} markerKey @returns {Promise<{ id: string, action: 'deleted'|'absent' }>} */
  async deleteBotComment(markerKey) {
    const iid = this._requireMr();
    const notes = await this._paginate(`${this._mrPath(iid)}/notes`);
    const existing = notes.find((n) => this.codec.hasKey(n.body ?? '', markerKey) && isBotNote(n));
    if (!existing) return { id: '', action: 'absent' };
    try {
      await this._api(`${this._mrPath(iid)}/notes/${existing.id}`, { method: 'DELETE' });
      return { id: String(existing.id), action: 'deleted' };
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) {
        return { id: String(existing.id), action: 'absent' };
      }
      throw e;
    }
  }

  /** @param {{ sinceISO: string, limit?: number }} opts */
  async listMergedPRs({ sinceISO, limit = 200 }) {
    const since = encodeURIComponent(sinceISO);
    const perPage = Math.min(limit, 100);
    const mrs = await this._paginate(
      `/projects/${this.projectId}/merge_requests?state=merged&merged_after=${since}&order_by=merged_at&sort=desc&per_page=${perPage}`,
    );
    return mrs.slice(0, limit).map((mr) => ({
      id: String(mr.iid), title: mr.title ?? '', mergedAt: mr.merged_at ?? mr.updated_at ?? '',
      authorEmail: mr.author?.email ?? mr.author?.username ?? '', url: mr.web_url ?? '',
    }));
  }

  /** @returns {Promise<string>} */
  async getDefaultBranch() {
    if (this._defaultBranch) return this._defaultBranch;
    const project = await this._api(`/projects/${this.projectId}`);
    this._defaultBranch = project?.default_branch ?? 'main';
    return this._defaultBranch;
  }

  /** @param {{ branch: string, filePath: string, newContent: string, baseBranch: string, title: string, body: string }} opts */
  async proposeStandardsChange({ branch, filePath, newContent, baseBranch, title, body }) {
    const apiPath = String(filePath).replace(/^\.\//, '').replace(/^\/+/, '');
    const ef = encodeURIComponent(apiPath);
    // 1. Create branch (idempotent: 400 = already exists).
    try {
      await this._api(`/projects/${this.projectId}/repository/branches`, { method: 'POST', body: { branch, ref: baseBranch } });
    } catch (e) { if (!(e instanceof ProviderError && e.status === 400)) throw e; }
    // 2. Create or update file. Try update; fall back to create on 404.
    try {
      await this._api(`/projects/${this.projectId}/repository/files/${ef}`, {
        method: 'PUT', body: { branch, content: newContent, commit_message: title, encoding: 'text' },
      });
    } catch (e) {
      if (!(e instanceof ProviderError && (e.status === 404 || e.status === 400))) throw e;
      await this._api(`/projects/${this.projectId}/repository/files/${ef}`, {
        method: 'POST', body: { branch, content: newContent, commit_message: title, encoding: 'text' },
      });
    }
    // 3. Open MR (idempotent: 409/422 = MR already exists).
    let mr;
    try {
      mr = await this._api(`/projects/${this.projectId}/merge_requests`, {
        method: 'POST', body: { source_branch: branch, target_branch: baseBranch, title, description: body },
      });
    } catch (e) {
      if (!(e instanceof ProviderError && (e.status === 409 || e.status === 422))) throw e;
      const existing = await this._paginate(
        `/projects/${this.projectId}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`);
      mr = existing[0];
      if (!mr) throw e;
    }
    return { url: mr.web_url ?? '' };
  }
}

module.exports = { GitLabReviewProvider, __test__: { isBotNote, mapChange } };

// @ts-check
'use strict';

const { makeMarkerCodec } = require('../marker-codec.js');

/**
 * @typedef {Object} PRMetadata
 * @property {string} id
 * @property {string} sourceBranch
 * @property {string} targetBranch
 * @property {string} sourceSha
 * @property {string} targetSha
 * @property {string} title
 * @property {string} description  raw author-written body; '' when empty
 * @property {string} authorEmail
 * @property {string} url
 */

/**
 * @typedef {Object} DiffFile
 * @property {string} path
 * @property {'add'|'modify'|'delete'|'rename'} change
 * @property {string} patch
 * @property {string} [oldPath]
 */

/**
 * @typedef {Object} ThreadComment
 * @property {string} id
 * @property {string} authorEmail
 * @property {string} body
 * @property {string} createdAt
 * @property {boolean} isBot
 */

/**
 * @typedef {'active'|'fixed'|'wontfix'|'resolved'|'closed'} ThreadStatus
 */

/**
 * @typedef {Object} ReviewThread
 * @property {string} id
 * @property {ThreadStatus} status
 * @property {string} filePath
 * @property {number} line
 * @property {ThreadComment[]} comments
 * @property {{ version?: string|null, fingerprint?: string|null }} [marker]
 * @property {boolean} [platformResolved] the platform's own open/resolved flag,
 *   read alongside `status`. `status` is the merge of the bot's last status
 *   marker with that flag, so once the marker says `fixed`/`wontfix` the flag
 *   is the only thing left that says the thread is still open on screen. Absent
 *   (`undefined`) means the provider did not report it; callers must treat that
 *   as unknown, not as open.
 */

/**
 * @typedef {Object} NewThread
 * @property {string} filePath
 * @property {number} line
 * @property {string} body
 * @property {'active'|'fixed'|'wontfix'} status
 * @property {string} ruleId
 */

/**
 * @typedef {Object} SummaryUpsertResult
 * @property {string} id
 * @property {'created'|'updated'} action
 */

/**
 * @typedef {Object} ProviderCapabilities
 * @property {boolean} nativeWontFix
 * @property {boolean} lineLevelThreads
 * @property {boolean} threadStatusPatch
 * @property {boolean} summaryComment
 * @property {boolean} [supportsFileContent]
 * @property {boolean} [canProposeChanges]
 */

/**
 * @typedef {Object} TriggerInfo
 * @property {boolean} manual true when a human pressed this platform's
 *   "turn the AI on" control for this run, rather than the run being started by
 *   a push. Only a manual run can turn the TL gate on — a push never can.
 * @property {string|null} actorId the presser's durable user id, or null when
 *   the platform reports none for this run. This is what
 *   `review.tlGate.leads` holds, so ids and never usernames.
 * @property {string|null} actorLabel a display name for the "AI on" note, or
 *   null when the platform reports none. Presentation only — never the decision.
 * @property {string} howToTurnOn one line telling a team lead how to press the
 *   control on this platform. Quoted verbatim in the gate's comments.
 */

/**
 * @typedef {Object} BotComment
 * @property {string} id
 * @property {string} body
 * @property {string} createdAt ISO 8601, or '' when the platform reports none
 * @property {boolean} editedByOther someone other than the bot has edited the
 *   comment, so its body is no longer the bot's own record and callers must not
 *   treat it as evidence. Platforms that cannot report this always say false.
 */

/**
 * Custom variable a platform's manual "turn the AI on" step sets to mark its own
 * run as a button press. Bitbucket and Azure DevOps have no event that tells a
 * re-run from a push, so their manual step exports this; GitHub and GitLab
 * report the press themselves and ignore it. One name for both, so a template
 * reads the same everywhere.
 */
const TL_PRESS_ENV = 'AI_REVIEW_TL_PRESSED';

/**
 * Is a custom CI variable set to an affirmative value? Shared so the Bitbucket
 * and Azure DevOps manual steps cannot drift on what counts as "pressed".
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
function tlPressSet(env) {
  const v = String(env[TL_PRESS_ENV] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** @returns {ProviderCapabilities} */
function defaultCapabilities() {
  return {
    nativeWontFix: false,
    lineLevelThreads: true,
    threadStatusPatch: true,
    summaryComment: true,
    supportsFileContent: false,
    canProposeChanges: false,
  };
}

class IReviewProvider {
  constructor() {
    /**
     * CI run identifier for this platform (GitHub `GITHUB_RUN_ID`, GitLab
     * `CI_PIPELINE_ID`, Azure DevOps `BUILD_BUILDID`, Bitbucket
     * `BITBUCKET_BUILD_NUMBER`). Null outside CI; the summary falls back to the
     * wall clock so local runs still get a unique append-mode key. Keyed into
     * the summary marker so a re-run updates its own comment.
     * @type {string|null}
     */
    this.runId = null;
    /**
     * Repository slug this run operates on, in the platform's own shape
     * (`owner/repo`, `group/project`, `workspace/slug`, `project/repo`). Null
     * when the environment carries no identifier. Used for audit-log entries
     * and the findings webhook.
     * @type {string|null}
     */
    this.repoSlug = null;
  }

  /** @returns {Promise<PRMetadata>} */
  async getPRMetadata() { throw new Error('IReviewProvider.getPRMetadata not implemented'); }
  /**
   * Did a human press this platform's "turn the AI on" control on this run, and
   * who was it? The TL gate decides on this alone (ADR-0014), so each provider
   * reads its own CI env — ADR-0012.
   * @returns {Promise<TriggerInfo>}
   */
  async getTriggerInfo() { throw new Error('IReviewProvider.getTriggerInfo not implemented'); }
  /**
   * This bot's own comment carrying `markerKey`, or null when there is none.
   * Only the bot's own comment counts: a human pasting a marker, or editing the
   * bot's comment afterwards, must not move the gate (ADR-0001 keeps the PR the
   * single source of truth, so this read is the whole of the gate's memory).
   * @param {string} _markerKey
   * @returns {Promise<BotComment|null>}
   */
  async findBotComment(_markerKey) { throw new Error('IReviewProvider.findBotComment not implemented'); }
  /** @returns {Promise<DiffFile[]>} */
  async getDiff() { throw new Error('IReviewProvider.getDiff not implemented'); }
  /** @returns {Promise<ReviewThread[]>} */
  async listThreads() { throw new Error('IReviewProvider.listThreads not implemented'); }
  /** @param {NewThread} thread @returns {Promise<{ id: string }>} */
  async postThread(thread) { throw new Error('IReviewProvider.postThread not implemented'); }
  /**
   * Batch-post N new threads under a single pending review (when supported)
   * to avoid GitHub's "one pending review per user per PR" 422 race that
   * occurs when N parallel createReviewComment calls each try to auto-create
   * a pending review. Default implementation falls back to N sequential
   * postThread calls — providers without pending-review semantics opt out.
   *
   * @param {NewThread[]} threads
   * @returns {Promise<Array<{ ok: true, value: { id: string } } | { ok: false, error: Error }>>}
   */
  async postThreadsBatch(threads) {
    const results = [];
    for (const t of threads) {
      try {
        const value = await this.postThread(t);
        results.push({ ok: true, value });
      } catch (error) {
        results.push({ ok: false, error });
      }
    }
    return results;
  }
  /** @param {string} threadId @param {string} body @param {{ status?: ThreadStatus, fingerprintHash?: string }} [opts] @returns {Promise<{ id: string }>} */
  async replyToThread(threadId, body, opts) { throw new Error('IReviewProvider.replyToThread not implemented'); }
  /** @param {string} threadId @param {ThreadStatus} status @param {{ skipMarkerReply?: boolean }} [opts] */
  async patchThreadStatus(threadId, status, opts) { throw new Error('IReviewProvider.patchThreadStatus not implemented'); }
  /** @param {string} markerKey @param {string} body @returns {Promise<SummaryUpsertResult>} */
  async upsertSummaryComment(markerKey, body) { throw new Error('IReviewProvider.upsertSummaryComment not implemented'); }
  /**
   * Delete the bot's own PR-level comment carrying `markerKey`, if any.
   * Used by the PR-size advisory to clear the sticky warning when limits no
   * longer apply (ADR-0018). Returns `absent` when nothing matched.
   * @param {string} _markerKey
   * @returns {Promise<{ id: string, action: 'deleted'|'absent' }>}
   */
  async deleteBotComment(_markerKey) { throw new Error('IReviewProvider.deleteBotComment not implemented'); }
  /**
   * This provider's marker codec — the single owner of every on-wire marker
   * form (status, fingerprint, key markers, status-reply prose). Concrete
   * providers override with a codec bound to their resolved wire style; the
   * base returns a GitHub-style (HTML-comment) codec so callers always have
   * one.
   * @returns {ReturnType<typeof makeMarkerCodec>}
   */
  get markers() { return makeMarkerCodec({ prefix: 'ai-review', style: 'html' }); }
  /**
   * The marker stamped into the PR-level summary comment body, rendered in this
   * provider's wire style. Used by summary-port instead of a hardcoded const so
   * the summary marker stays consistent with findings/replies per provider.
   * @returns {string}
   */
  renderSummaryMarker(markerKey = 'summary') { return this.markers.key(markerKey); }
  /**
   * Fetch file content at a given ref. Returns null when the path is absent
   * at that ref (404) or resolves to a directory rather than a file. Other
   * errors throw — caller decides soft-fail.
   *
   * @param {string} filePath repo-relative path
   * @param {string} ref commit SHA or branch name
   * @returns {Promise<string|null>}
   */
  async getFileContent(filePath, ref) { throw new Error('IReviewProvider.getFileContent not implemented'); }
  /**
   * List PRs merged since an ISO timestamp.
   * @param {{ sinceISO: string, limit?: number }} _opts
   * @returns {Promise<Array<{ id: string, title: string, mergedAt: string, authorEmail: string, url: string }>>}
   */
  async listMergedPRs(_opts) { throw new Error('IReviewProvider.listMergedPRs not implemented'); }
  /**
   * List review threads on an arbitrary PR id.
   * @param {string} _prId
   * @returns {Promise<import('./provider.types.js').ReviewThread[]>}
   */
  async listThreadsForPR(_prId) { throw new Error('IReviewProvider.listThreadsForPR not implemented'); }
  /**
   * Push a single-file change on a new branch and open a PR. Outcome-based:
   * adapters own the mechanics. Requires capabilities.canProposeChanges.
   * @param {{ branch: string, filePath: string, newContent: string, baseBranch: string, title: string, body: string }} _opts
   * @returns {Promise<{ url: string }>}
   */
  async proposeStandardsChange(_opts) { throw new Error('IReviewProvider.proposeStandardsChange not implemented'); }
  /**
   * The repository's default branch (e.g. the learn proposal's base). Safe,
   * non-throwing default so callers can resolve a base without provider
   * support; adapters override to query the real default.
   * @returns {Promise<string>}
   */
  async getDefaultBranch() { return 'main'; }
  get capabilities() { return defaultCapabilities(); }
}

module.exports = {
  IReviewProvider, defaultCapabilities, tlPressSet, TL_PRESS_ENV,
};

// @ts-check
'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const { ConfigError } = require('../errors.js');
const { splitUnifiedDiff } = require('../unified-diff-split.js');
const { makeMarkerCodec } = require('../marker-codec.js');
const { IReviewProvider, defaultCapabilities } = require('./provider.types.js');

const defaultExecFile = promisify(execFile);

/**
 * Resolve local-bench options from explicit `local` opts and ReviewBench-style env.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   local?: {
 *     repoDir?: string,
 *     base?: string,
 *     head?: string,
 *     nwo?: string,
 *     prNumber?: number|string,
 *   },
 * }} opts
 */
function resolveLocalOpts(opts) {
  const env = opts.env ?? {};
  const local = opts.local ?? {};
  const repoDir = local.repoDir || env.RB_REPO || process.cwd();
  const base = local.base || env.RB_BASE || '';
  const head = local.head || env.RB_HEAD || '';
  const nwo = local.nwo || env.RB_NWO || 'local/repo';
  const rawPr = local.prNumber ?? env.RB_PR_NUMBER ?? '0';
  const prNumber = Number(rawPr);
  return {
    repoDir: path.resolve(repoDir),
    base,
    head,
    nwo,
    prNumber: Number.isFinite(prNumber) ? prNumber : 0,
  };
}

/**
 * Resolve a repo-relative path and reject anything that escapes repoDir.
 * @param {string} repoDir
 * @param {string} filePath
 * @returns {string|null}
 */
function resolveInsideRepo(repoDir, filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') return null;
  const root = path.resolve(repoDir);
  const full = path.resolve(root, filePath);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (full !== root && !full.startsWith(prefix)) return null;
  return full;
}

class LocalReviewProvider extends IReviewProvider {
  /**
   * @param {{
   *   config?: any,
   *   env?: NodeJS.ProcessEnv,
   *   local?: {
   *     repoDir?: string,
   *     base?: string,
   *     head?: string,
   *     nwo?: string,
   *     prNumber?: number|string,
   *   },
   *   deps?: {
   *     execFile?: (cmd: string, args: string[], opts: object) => Promise<{ stdout: string }>,
   *   },
   * }} opts
   */
  constructor(opts = {}) {
    super();
    const resolved = resolveLocalOpts(opts);
    if (!resolved.base || !resolved.head) {
      throw new ConfigError(
        'local provider requires --base/--head (or RB_BASE/RB_HEAD)',
      );
    }
    this.repoDir = resolved.repoDir;
    this.base = resolved.base;
    this.head = resolved.head;
    this.nwo = resolved.nwo;
    this.prNumber = resolved.prNumber;
    this.env = opts.env ?? process.env;
    this.markerPrefix = opts.config?.markers?.prefix ?? 'ai-review';
    this.codec = makeMarkerCodec({ prefix: this.markerPrefix, style: 'html' });
    this.runId = null;
    this.repoSlug = this.nwo;
    this._execFile = opts.deps?.execFile ?? defaultExecFile;
  }

  get markers() { return this.codec; }

  get capabilities() {
    return {
      ...defaultCapabilities(),
      supportsFileContent: true,
      canProposeChanges: false,
    };
  }

  /** @returns {Promise<import('./provider.types.js').PRMetadata>} */
  async getPRMetadata() {
    return {
      id: String(this.prNumber),
      sourceBranch: 'HEAD',
      targetBranch: 'BASE',
      sourceSha: this.head,
      targetSha: this.base,
      title: `${this.nwo}#${this.prNumber}`,
      description: '',
      authorEmail: '',
      url: `https://github.com/${this.nwo}/pull/${this.prNumber}`,
    };
  }

  /** @returns {Promise<import('./provider.types.js').TriggerInfo>} */
  async getTriggerInfo() {
    return {
      manual: false,
      actorId: null,
      actorLabel: null,
      howToTurnOn: 'Local provider: set review.tlGate.enabled=false or use --force-review.',
    };
  }

  /** @param {string} _markerKey */
  async findBotComment(_markerKey) { return null; }

  /** @returns {Promise<import('./provider.types.js').DiffFile[]>} */
  async getDiff() {
    let text;
    try {
      const result = await this._execFile(
        'git',
        ['-C', this.repoDir, 'diff', `${this.base}...${this.head}`],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
      text = typeof result.stdout === 'string' ? result.stdout : String(result.stdout ?? '');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ConfigError(`local provider git diff failed: ${msg}`);
    }
    return splitUnifiedDiff(text);
  }

  async listThreads() { return []; }

  /** @param {import('./provider.types.js').NewThread} _thread */
  async postThread(_thread) { return { id: 'local-noop' }; }

  /**
   * @param {string} _threadId
   * @param {string} _body
   * @param {{ status?: import('./provider.types.js').ThreadStatus, fingerprintHash?: string }} [_opts]
   */
  async replyToThread(_threadId, _body, _opts) { return { id: 'local-noop' }; }

  /**
   * @param {string} _threadId
   * @param {import('./provider.types.js').ThreadStatus} _status
   * @param {{ skipMarkerReply?: boolean }} [_opts]
   */
  async patchThreadStatus(_threadId, _status, _opts) { /* no-op */ }

  /**
   * @param {string} _markerKey
   * @param {string} _body
   */
  async upsertSummaryComment(_markerKey, _body) {
    return { id: 'local-noop', action: /** @type {'created'} */ ('created') };
  }

  /** @param {string} _markerKey */
  async deleteBotComment(_markerKey) {
    return { id: 'local-noop', action: /** @type {'absent'} */ ('absent') };
  }

  /**
   * @param {string} filePath
   * @param {string} _ref
   */
  async getFileContent(filePath, _ref) {
    const full = resolveInsideRepo(this.repoDir, filePath);
    if (!full) return null;
    try {
      return await fs.promises.readFile(full, 'utf8');
    } catch {
      return null;
    }
  }

  async listMergedPRs() {
    throw new ConfigError('local provider does not support learn (listMergedPRs)');
  }

  async listThreadsForPR() {
    throw new ConfigError('local provider does not support learn (listThreadsForPR)');
  }

  async proposeStandardsChange() {
    throw new ConfigError('local provider does not support learn (proposeStandardsChange)');
  }
}

/**
 * Build `local` makeProvider opts from CLI flags + ReviewBench env.
 * @param {{ base?: string, head?: string, repoDir?: string }} cliFlags
 * @param {NodeJS.ProcessEnv} env
 */
function localProviderOpts(cliFlags, env) {
  return {
    repoDir: cliFlags.repoDir,
    base: cliFlags.base,
    head: cliFlags.head,
    nwo: env.RB_NWO,
    prNumber: env.RB_PR_NUMBER,
  };
}

module.exports = {
  LocalReviewProvider, resolveLocalOpts, localProviderOpts, resolveInsideRepo,
};

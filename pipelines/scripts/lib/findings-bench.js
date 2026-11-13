// @ts-check
'use strict';

/**
 * Map Owlet action-plan posts into ReviewBench agent-contract findings JSON.
 *
 * @typedef {{ filePath: string, line: number, body: string }} BenchPostFinding
 * @typedef {{ repo: string, pr_number: number, base: string, head: string }} BenchPr
 *
 * @param {{
 *   toPost: BenchPostFinding[],
 *   pr: BenchPr,
 *   agent: string,
 * }} opts
 * @returns {{
 *   pr: BenchPr,
 *   agent: string,
 *   findings: Array<{
 *     file: string,
 *     start_line: number,
 *     end_line: number,
 *     message: string,
 *     producer: string,
 *   }>,
 * }}
 */
function toReviewBenchFindings({ toPost, pr, agent }) {
  const posts = Array.isArray(toPost) ? toPost : [];
  return {
    pr,
    agent,
    findings: posts.map((f) => ({
      file: normalizeRepoPath(f.filePath),
      start_line: f.line,
      end_line: f.line,
      message: f.body,
      producer: agent,
    })),
  };
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function normalizeRepoPath(filePath) {
  const s = String(filePath ?? '');
  return s.startsWith('./') ? s.slice(2) : s;
}

/**
 * @param {{ findingsOut?: string }} cliFlags
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function resolveFindingsOut(cliFlags, env) {
  const p = cliFlags.findingsOut || env.RB_OUT || '';
  return typeof p === 'string' ? p.trim() : '';
}

/**
 * @param {{
 *   findingsOut: string,
 *   toPost: BenchPostFinding[],
 *   meta: { id: string|number, sourceSha: string, targetSha: string },
 *   env: NodeJS.ProcessEnv,
 *   repoSlug?: string|null,
 *   agentDefault?: string,
 * }} opts
 * @returns {{ agent: string, findingCount: number }}
 */
function writeReviewBenchFindingsFile(opts) {
  const fs = require('node:fs');
  const path = require('node:path');
  const agent = (opts.env.RB_AGENT && String(opts.env.RB_AGENT).trim())
    || opts.agentDefault
    || 'owlet-lens';
  const nwo = opts.env.RB_NWO || opts.repoSlug || 'local/repo';
  const repoUrl = /^https?:\/\//i.test(String(nwo))
    ? String(nwo)
    : `https://github.com/${nwo}`;
  const doc = toReviewBenchFindings({
    toPost: opts.toPost,
    pr: {
      repo: repoUrl,
      pr_number: Number(opts.meta.id),
      base: opts.meta.targetSha,
      head: opts.meta.sourceSha,
    },
    agent,
  });
  fs.mkdirSync(path.dirname(path.resolve(opts.findingsOut)), { recursive: true });
  fs.writeFileSync(opts.findingsOut, `${JSON.stringify(doc, null, 2)}\n`);
  return { agent, findingCount: doc.findings.length };
}

/**
 * Write the ReviewBench file and print the compact stdout result line.
 * @param {{
 *   findingsOut: string,
 *   toPost: BenchPostFinding[],
 *   meta: { id: string|number, sourceSha: string, targetSha: string },
 *   env: NodeJS.ProcessEnv,
 *   repoSlug?: string|null,
 *   providerName: string,
 *   costUsd: number,
 *   durationMs: number,
 *   strict: { triggered?: boolean },
 *   stdout?: { write: (s: string) => unknown },
 * }} opts
 * @returns {number} process exit code (8 when strict triggers, else 0)
 */
function emitFindingsOutRun(opts) {
  const written = writeReviewBenchFindingsFile(opts);
  const out = opts.stdout ?? process.stdout;
  out.write(JSON.stringify({
    findingsOut: opts.findingsOut,
    provider: opts.providerName,
    prId: opts.meta.id,
    findingCount: written.findingCount,
    costUsd: opts.costUsd,
    durationMs: opts.durationMs,
    strict: opts.strict,
  }) + '\n');
  return opts.strict?.triggered ? 8 : 0;
}

module.exports = {
  toReviewBenchFindings, resolveFindingsOut, writeReviewBenchFindingsFile, emitFindingsOutRun,
};

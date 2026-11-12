#!/usr/bin/env node
// @ts-check
'use strict';

const { loadConfig } = require('./lib/config-loader.js');
const providerIndex = require('./lib/providers/index.js');
const { detectProvider } = providerIndex;
const llmIndex = require('./lib/llm/index.js');
const { runReviewPass } = require('./lib/review-pass.js');
const { loadCodingStandards, loadContextPaths } = require('./lib/context-loader.js');
const { loadReviewContext } = require('./lib/review-context.js');
const { computeReviewFingerprint } = require('./lib/review-fingerprint.js');
const { safeMsg } = require('./lib/log-safe.js');
const { logEvent } = require('./lib/log-helpers.js');
const summaryPort = require('./lib/port/summary-port.js');
const sizeAdvisoryPort = require('./lib/port/size-advisory-port.js');
const replyEvaluator = require('./lib/port/reply-evaluator.js');
const replyContextPort = require('./lib/port/reply-context-port.js');
const {
  emptyReplyUsage, addVerdictUsage, summarizeReplyUsage, recordReplyRun,
} = require('./lib/port/reply-usage.js');
const {
  lastDevReplyIndex, findPostedVerdict, repairVerdictStatus,
} = require('./lib/port/reply-thread-scan.js');
const { strictDecisionFor } = require('./lib/port/strict-port.js');
const { resolvePr } = require('./lib/resolve-pr.js');
const { postFindingsWebhook } = require('./lib/findings-export.js');
const { postActionPlan, logActionFailure } = require('./lib/action-poster.js');
const { runLifecycle } = require('./lib/run-lifecycle.js');
const { guard: tlGuard, report: tlGateReport } = require('./lib/port/tl-gate-run.js');
const { guard: skipGuard, reviewedMarker } = require('./lib/port/skip-unchanged.js');
const { parseArgs } = require('./lib/args.js');
const { runLearn, runLearnWith, learnPrBody } = require('./lib/learn/runner.js');

async function runReview(opts = {}) {
  const { argv = process.argv.slice(2), env = process.env, cwd = process.cwd() } = opts;
  return runLifecycle({ env }, async (life) => {
    const cliFlags = parseArgs(argv);
    const config = loadConfig({ cwd, env, cliFlags });
    if (typeof cliFlags.strict === 'boolean') {
      config.review.strict = cliFlags.strict;
    }
    const providerName = detectProvider({
      env, cliFlag: cliFlags.provider, configValue: config.provider,
    });
    const provider = providerIndex.makeProvider(providerName, { config, env });

    // The TL gate answers "may this run spend a token?" before any LLM client
    // is built, reading its switch off the PR's TARGET branch (ADR-0014).
    const meta = await provider.getPRMetadata();
    const { gate, held, noteFailed } = await tlGuard({ provider, providerName, cwd, cliFlags, meta, life, auditLogPath: config.review.auditLogPath });
    if (held) return 0;

    // The review fingerprint decides "has anything the review depends on
    // changed?" before any LLM client is built (ADR-0015).
    const diffs = await provider.getDiff();
    const promptContext = loadReviewContext({ cwd, config, diffs, log: logEvent });
    const fingerprint = computeReviewFingerprint({
      diffs,
      config,
      standards: [promptContext.codingStandards, promptContext.suppressionContext, promptContext.projectContext],
    });
    const tlGate = tlGateReport(gate, { dryRun: cliFlags.dryRun, noteFailed });
    const skipCode = await skipGuard({ provider, providerName, config, cliFlags, env, meta, fingerprint, tlGate, life });
    if (skipCode !== null) return skipCode;

    const llmName = llmIndex.detectLLMProvider({
      env, configValue: config.review.provider, kind: 'review',
    });
    const llmProvider = llmIndex.makeLLMProvider(llmName, { config, kind: 'review' });

    let replyLlm = null;
    if (config.review.reflection !== false) {
      const replyLlmName = llmIndex.detectLLMProvider({
        env, configValue: config.reply.provider, kind: 'reply',
      });
      replyLlm = llmIndex.makeLLMProvider(replyLlmName, { config, kind: 'reply' });
      logEvent('info', 'reflection.filter.active', {
        msg: 'reflection filter active — disable with review.reflection: false',
        model: config.reply.model,
      });
    }

    const existing = await provider.listThreads();
    const { plan, findings, stats, usage } = await runReviewPass({
      diffs, threads: existing, meta,
      promptContext,
      config: {
        review: config.review,
        excludePaths: config.paths?.exclude,
        markerPrefix: config.markers?.prefix ?? 'ai-review',
      },
    }, {
      llm: llmProvider, llmName, log: logEvent, replyLlm,
      tokenBudget: config.review.tokenBudget,
    });
    const { toPost, toReply, toReopen, toClose } = plan;

    const strict = strictDecisionFor({ review: config.review, plan, threads: existing, log: logEvent });

    const totalUsd = usage.cost;
    const { failedChunks } = stats;

    const nextStateReview = life.appendState({
      prNumber: Number(meta.id),
      enabled: !cliFlags.dryRun,
      invocation: {
        type: 'review', ts: new Date().toISOString(),
        costUsd: totalUsd, model: usage.models.join(',') || config.review.model,
      },
    });

    if (cliFlags.dryRun) {
      const project = (a) => a.map((f) => ({
        filePath: f.filePath ?? f.finding?.filePath,
        line: f.line ?? f.finding?.line,
        severity: f.severity ?? f.finding?.severity,
        category: f.category ?? f.finding?.category,
        ruleId: f.ruleId ?? f.finding?.ruleId,
      }));
      const sizeDry = await sizeAdvisoryPort.sync(provider, diffs, {
        review: config.review, excludePaths: config.paths?.exclude, dryRun: true,
      });
      process.stdout.write(JSON.stringify({
        dryRun: true,
        provider: providerName,
        prId: meta.id,
        wouldPost: project(toPost),
        wouldReply: project(toReply),
        wouldReopen: project(toReopen),
        wouldClose: project(toClose),
        summaryAction: 'would-create',
        ...sizeAdvisoryPort.toResultFields(sizeDry),
        costUsd: totalUsd, durationMs: life.elapsedMs(),
        dismissedContext: { count: stats.dismissedCount },
        strict,
      }) + '\n');
      return strict.triggered ? 8 : 0;
    }

    // Post/reply/reopen/close all live behind one call so a posting bug has
    // one place to hide. Failures are collected, not thrown.
    const ledger = await postActionPlan(plan, provider, { providerName });
    // A lost "AI on" note is the gate's only memory, so it counts as a partial
    // failure like any other write (exit 6) — never more, the review did happen.
    let failures = ledger.failures + (noteFailed ? 1 : 0);

    let summaryAction = 'skipped';
    try {
      const summaryBody = summaryPort.buildBody({
        meta,
        reconcile: {
          posted: ledger.posted, replied: ledger.replied,
          reopened: ledger.reopened, closed: ledger.closed, failures,
        },
        cost: {
          totalUsd,
          byType: { review: { count: 1, totalUsd }, reply: { count: 0, totalUsd: 0 } },
        },
        dismissed: { dismissedCount: stats.dismissedCount },
        securityContext: { enabled: false, degraded: false },
        strict,
        cumulative: nextStateReview ? {
          totalUsd: nextStateReview.cumulativeCostUsd,
          runCount: nextStateReview.invocations.length,
        } : undefined,
        metrics: {
          bySeverity: stats.bySeverity,
          durationMs: life.elapsedMs(),
          filesReviewed: stats.filesReviewed,
          filesSkipped: diffs.length - stats.filesReviewed,
        },
        marker: provider.renderSummaryMarker(),
        // Stamped only when this run reviewed every file and every write landed,
        // so a partial run is retried by the next push rather than skipped.
        reviewedMarker: failures === 0 && failedChunks === 0 ? reviewedMarker(provider, fingerprint) : undefined,
      });
      const r = await summaryPort.upsert(provider, summaryBody, {
        mode: config.review.summary?.mode ?? 'sticky',
        runId: provider.runId,
      });
      summaryAction = r.action;
    } catch (e) {
      failures += 1;
      logActionFailure('upsertSummaryComment failed', e, { prId: meta.id });
    }

    // PR-size advisory (ADR-0018): comment-only; never holds the LLM.
    let sizeAdvisoryAction = 'noop';
    try {
      const sizeSync = await sizeAdvisoryPort.sync(provider, diffs, {
        review: config.review, excludePaths: config.paths?.exclude,
      });
      sizeAdvisoryAction = sizeSync.action;
      if (sizeSync.evaluation.exceeded) {
        logEvent('warn', 'review.sizeAdvisory.exceeded', {
          breaches: sizeSync.evaluation.breaches,
          files: sizeSync.evaluation.metrics.files,
          changedLines: sizeSync.evaluation.metrics.changedLines,
        });
      }
    } catch (e) {
      failures += 1;
      logActionFailure('size-advisory sync failed', e, { prId: meta.id });
    }

    const reviewDurationMs = life.elapsedMs();
    const latencyWarnMs = config.review.latencyWarnMs;
    if (latencyWarnMs && reviewDurationMs > latencyWarnMs) {
      logEvent('warn', 'review.latency.exceeded', {
        durationMs: reviewDurationMs, thresholdMs: latencyWarnMs,
      });
    }

    const result = {
      provider: providerName, prId: meta.id,
      posted: ledger.posted, replied: ledger.replied,
      reopened: ledger.reopened, closed: ledger.closed,
      failures, failedChunks, summaryAction, sizeAdvisoryAction,
      costUsd: totalUsd, durationMs: reviewDurationMs,
      dismissedContext: { count: stats.dismissedCount },
      strict,
      tlGate,
    };

    result.auditLogged = life.writeAudit({
      path: config.review.auditLogPath,
      enabled: !cliFlags.dryRun,
      repo: provider.repoSlug,
      entry: {
        event: 'review', prId: meta.id,
        model: usage.models.join(',') || config.review.model,
        ...result,
      },
    });
    process.stdout.write(JSON.stringify(result) + '\n');

    const webhookUrl = config.review.exportWebhookUrl;
    if (typeof webhookUrl === 'string' && webhookUrl.trim() && !cliFlags.dryRun) {
      const trimmedUrl = webhookUrl.trim();
      const repo = provider.repoSlug ?? '';
      if (!repo) {
        logEvent('warn', 'findings.export.repo_unknown', {
          msg: 'provider reported no repository slug; export payload will have empty repo',
        });
      }
      const exportFindings = findings.map((f) => ({
        filePath: f.filePath, line: f.line, severity: f.severity, category: f.category, body: f.body,
      }));
      const exportResult = await postFindingsWebhook(trimmedUrl, {
        repo,
        prId: meta.id,
        findings: exportFindings,
        costUsd: totalUsd,
        ts: new Date().toISOString(),
      });
      if (!exportResult.ok) {
        const urlOrigin = (() => { try { return new URL(trimmedUrl).origin; } catch { return '[invalid-url]'; } })();
        logEvent('warn', 'findings.export.failed', {
          url: urlOrigin, status: exportResult.status, message: exportResult.message,
        });
      }
    }

    // Strict outranks a write failure: `action-entry.js` fails the job for any
    // code > 1 except 6, so returning 6 here would let a run with a blocking
    // finding slip through the gate. `failures` still lands in the JSON.
    if (strict.triggered) return 8;
    if (failures > 0) return 6;
    const findingActivity = (ledger.posted + ledger.replied + ledger.reopened + ledger.closed) > 0;
    return (findingActivity || sizeAdvisoryPort.wroteAction(sizeAdvisoryAction)) ? 1 : 0;
  });
}

// The prose line that carries a verdict. `runReply` writes it and its repair
// path reads it back, so the two live together here: if the wording changed in
// one without the other, the repair would silently stop finding verdicts and a
// half-applied thread would stay stuck. The value is deliberately not a marker
// - it predates the marker scheme and live threads carry only the prose - so
// reading it back means reading the prose.
const VERDICT_LINE = /_AI verdict:_\s*`([a-z]+)`/;

/**
 * @param {'fixed'|'wontfix'|'active'} verdict
 * @param {string} reasoning
 * @returns {string}
 */
function formatVerdictText(verdict, reasoning) {
  return `_AI verdict:_ \`${verdict}\` — ${reasoning}`;
}

/**
 * Read a verdict back out of a posted reply body. Returns null when there is
 * no recognisable verdict, so the caller can leave the thread alone rather
 * than flip it on a malformed marker.
 *
 * @param {string} body
 * @returns {'fixed'|'wontfix'|'active'|null}
 */
function parseVerdictText(body) {
  const m = VERDICT_LINE.exec(body ?? '');
  if (!m) return null;
  const verdict = m[1];
  if (verdict === 'fixed' || verdict === 'wontfix' || verdict === 'active') return verdict;
  return null;
}

async function runReply(opts = {}) {
  const { argv = process.argv.slice(2), env = process.env, cwd = process.cwd() } = opts;
  return runLifecycle({ env }, async (life) => {
    const cliFlags = parseArgs(argv);
    const config = loadConfig({ cwd, env, cliFlags });
    const providerName = detectProvider({
      env, cliFlag: cliFlags.provider, configValue: config.provider,
    });
    const provider = providerIndex.makeProvider(providerName, { config, env });

    const llmName = llmIndex.detectLLMProvider({
      env, configValue: config.reply.provider, kind: 'reply',
    });
    const llmProvider = llmIndex.makeLLMProvider(llmName, { config, kind: 'reply' });

    const threads = await provider.listThreads();
    const aiThreads = threads.filter(
      (t) => t.status === 'active'
        && t.comments.length > 0
        && t.comments[0].isBot,
    );

    // Reuse review.codingStandardsPath + review.contextPaths as project-wide
    // reference material for verdict reasoning. Both helpers warn-and-fall-back
    // on unreadable entries; never fatal.
    const codingStandards = loadCodingStandards(cwd, config.review.codingStandardsPath);
    const projectContext = loadContextPaths(cwd, config.review.contextPaths);

    let prDiff = [];
    let headSha = '';
    let prMeta = null;
    const fileCache = new Map();
    if (aiThreads.length > 0) {
      try {
        prDiff = await provider.getDiff();
        prMeta = await provider.getPRMetadata();
        headSha = prMeta?.sourceSha ?? '';
      } catch (e) {
        process.stderr.write(JSON.stringify({
          level: 'warn',
          msg: 'reply: PR diff/head fetch failed; proceeding with minimal context',
          errName: e?.name, errMessage: safeMsg(e),
        }) + '\n');
      }
    }

    const wouldReply = [];
    let processed = 0;
    let evalFailures = 0;
    let writeFailures = 0;
    const replyUsage = emptyReplyUsage();
    for (const t of aiThreads) {
      const lastDevIdx = lastDevReplyIndex(t);
      if (lastDevIdx === -1) continue;

      const verdictComment = findPostedVerdict(t, provider.markers, lastDevIdx);
      if (verdictComment) {
        // Verdict already posted, so this thread needs no evaluation — only the
        // status step it may have missed.
        const outcome = await repairVerdictStatus(t, verdictComment, {
          provider, parseVerdictText, dryRun: cliFlags.dryRun === true,
        });
        if (outcome === 'failed') writeFailures += 1;
        continue;
      }

      const findingBody = t.comments[0].body ?? '';
      const devReply = t.comments[lastDevIdx].body ?? '';

      const richCtx = await replyContextPort.assembleReplyContext({
        provider, thread: t, prDiff, headSha, fileCache,
      });
      for (const w of richCtx.warnings) {
        process.stderr.write(JSON.stringify({
          level: 'warn',
          msg: 'reply-context partial',
          threadId: t.id, warning: w,
        }) + '\n');
      }

      let result;
      try {
        result = await replyEvaluator.evaluate({
          findingBody,
          devReply,
          fullThread: richCtx.fullThread,
          codeSnippet: richCtx.codeSnippet,
          diffSlice: richCtx.diffSlice,
          codingStandards,
          projectContext,
          threadId: t.id,
          llmProvider,
          model: config.reply.model,
        });
        addVerdictUsage(replyUsage, result);
      } catch (e) {
        evalFailures += 1;
        process.stderr.write(JSON.stringify({
          level: 'error', msg: 'reply-evaluator failed',
          threadId: t.id, errName: e?.name, errMessage: safeMsg(e),
        }) + '\n');
        continue;
      }

      // Parse-failure fallback: leave the thread untouched (no reply, no marker)
      // so the next run re-evaluates it. Posting a verdict marker here would trip
      // the hasVerdictAfter gate above and suppress the retry permanently.
      if (result.unevaluated) {
        logEvent('warn', 'reply.unevaluated.skipped', { threadId: t.id });
        continue;
      }

      const replyBody = provider.markers.appendKey(
        formatVerdictText(result.verdict, result.reasoning),
        'verdict',
      );
      if (cliFlags.dryRun) {
        wouldReply.push({
          threadId: t.id, filePath: t.filePath, line: t.line,
          verdict: result.verdict, reasoning: result.reasoning,
        });
        processed += 1;
        continue;
      }
      try {
        // Reply first, then status. If the status step fails here the verdict
        // marker is already on the thread, which is what the repair path above
        // keys off on the next run.
        await provider.replyToThread(t.id, replyBody);
        if (result.verdict !== 'active') {
          await provider.patchThreadStatus(t.id, result.verdict);
        }
        processed += 1;
      } catch (e) {
        // Counted, not just logged: a write that failed is a failed item
        // (ADR-0013), so it has to reach the exit code the way `review` does.
        writeFailures += 1;
        process.stderr.write(JSON.stringify({
          level: 'error', msg: 'reply post/patch failed',
          threadId: t.id, errName: e?.name, errMessage: safeMsg(e),
        }) + '\n');
      }
    }

    const report = summarizeReplyUsage(replyUsage, {
      configuredModel: config.reply.model, provider: providerName,
      dryRun: cliFlags.dryRun === true,
      counts: { processed, evalFailures, writeFailures }, wouldReply,
    });
    recordReplyRun(life, {
      prNumber: resolvePr(env, {}) ?? 0,
      prId: prMeta?.id ?? resolvePr(env, {}),
      repo: provider.repoSlug,
      auditPath: config.review.auditLogPath,
      dryRun: cliFlags.dryRun === true,
      processed,
      report,
    });

    process.stdout.write(JSON.stringify(report.result) + '\n');
    if (cliFlags.dryRun) return 0;
    // Both kinds of failure are failed items: one aborted the evaluation, the
    // other aborted a write. Either way CI has to see it.
    return (evalFailures > 0 || writeFailures > 0) ? 6 : 0;
  });
}

if (require.main === module) {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.subcommand === 'reply') {
    runReply().then((c) => process.exit(c ?? 0));
  } else if (flags.subcommand === 'learn') {
    runLearn().then((c) => process.exit(c ?? 0));
  } else if (flags.subcommand === 'init') {
    const { runInit } = require('./lib/init.js');
    runInit().then((c) => process.exit(c ?? 0));
  } else if (flags.subcommand === 'install-hook') {
    const { runInstallHook } = require('./lib/install-hook.js');
    runInstallHook().then((c) => process.exit(c ?? 0));
  } else {
    runReview().then((c) => process.exit(c ?? 0));
  }
}

module.exports = {
  runReview, runReply, runLearn, parseArgs,
  __test__: { runLearnWith, learnPrBody },
};

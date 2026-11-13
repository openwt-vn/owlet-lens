'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runReview } = require('../ai-review.js');

/**
 * @param {string} dir
 * @param {string[]} args
 */
function git(dir, args) {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
}

/** @returns {{ dir: string, base: string, head: string }} */
function makeTwoCommitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owlet-bench-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'src.js'), 'function a() { return 1; }\n');
  git(dir, ['add', 'src.js']);
  git(dir, ['commit', '-m', 'base']);
  const base = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(dir, 'src.js'), 'function a() { return 1; }\nfunction b() { return 2; }\n');
  git(dir, ['add', 'src.js']);
  git(dir, ['commit', '-m', 'head']);
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { dir, base, head };
}

function withConfigCwd(fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'owlet-cfg-'));
  fs.writeFileSync(path.join(cwd, 'ai-review.config.yaml'),
    'provider: local\nauth:\n  anthropicKey: ${ANTHROPIC_API_KEY}\n',
  );
  try { return fn(cwd); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

test('runReview local + findings-out writes ReviewBench JSON and does not post', async () => {
  const { dir, base, head } = makeTwoCommitRepo();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owlet-out-'));
  const findingsPath = path.join(outDir, 'findings.json');

  const llmIndex = require('../lib/llm/index.js');
  const origMakeLLM = llmIndex.makeLLMProvider;
  let posts = 0;
  llmIndex.makeLLMProvider = () => ({
    call: async () => ({
      text: JSON.stringify({
        summary: 's',
        findings: [{
          file: 'src.js', line: 2, severity: 'HIGH', category: 'security',
          message: 'New helper lacks validation',
        }],
      }),
      usage: { inputTokens: 10, outputTokens: 5 },
      cost: { inputCost: 0, outputCost: 0, totalCost: 0.001 },
    }),
  });

  // Spy: local provider already no-ops; assert via wrapping makeProvider.
  const providerIndex = require('../lib/providers/index.js');
  const origMake = providerIndex.makeProvider;
  providerIndex.makeProvider = (name, opts) => {
    const p = origMake(name, opts);
    const wrap = (method) => {
      const orig = p[method].bind(p);
      p[method] = async (...args) => {
        posts += 1;
        return orig(...args);
      };
    };
    wrap('postThread');
    wrap('upsertSummaryComment');
    return p;
  };

  let captured = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { captured += s; return true; };

  let code;
  try {
    await withConfigCwd(async (cwd) => {
      code = await runReview({
        argv: [
          'review', '--provider=local',
          `--repo-dir=${dir}`, `--base=${base}`, `--head=${head}`,
          `--findings-out=${findingsPath}`, '--force-review',
        ],
        env: {
          ANTHROPIC_API_KEY: 'k',
          RB_NWO: 'acme/widgets',
          RB_PR_NUMBER: '99',
          RB_AGENT: 'owlet-lens',
        },
        cwd,
      });
    });
  } finally {
    process.stdout.write = origWrite;
    llmIndex.makeLLMProvider = origMakeLLM;
    providerIndex.makeProvider = origMake;
  }

  assert.equal(code, 0);
  assert.equal(posts, 0, 'must not call post/summary write APIs');
  const doc = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
  assert.equal(doc.pr.pr_number, 99);
  assert.equal(doc.pr.repo, 'https://github.com/acme/widgets');
  assert.equal(doc.pr.base, base);
  assert.equal(doc.pr.head, head);
  assert.equal(doc.agent, 'owlet-lens');
  assert.equal(doc.findings.length, 1);
  assert.equal(doc.findings[0].file, 'src.js');
  assert.equal(doc.findings[0].message, 'New helper lacks validation');
  assert.equal(doc.findings[0].start_line, 2);
  assert.equal(doc.findings[0].end_line, 2);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('runReview local + findings-out writes empty findings array', async () => {
  const { dir, base, head } = makeTwoCommitRepo();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owlet-out-'));
  const findingsPath = path.join(outDir, 'findings.json');

  const llmIndex = require('../lib/llm/index.js');
  const origMakeLLM = llmIndex.makeLLMProvider;
  llmIndex.makeLLMProvider = () => ({
    call: async () => ({
      text: JSON.stringify({ summary: 'clean', findings: [] }),
      usage: { inputTokens: 1, outputTokens: 1 },
      cost: { inputCost: 0, outputCost: 0, totalCost: 0 },
    }),
  });

  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;

  try {
    await withConfigCwd(async (cwd) => {
      const code = await runReview({
        argv: [
          'review', '--provider=local',
          `--repo-dir=${dir}`, `--base=${base}`, `--head=${head}`,
          `--findings-out=${findingsPath}`, '--force-review',
        ],
        env: { ANTHROPIC_API_KEY: 'k', RB_NWO: 'o/r', RB_PR_NUMBER: '1' },
        cwd,
      });
      assert.equal(code, 0);
    });
  } finally {
    process.stdout.write = origWrite;
    llmIndex.makeLLMProvider = origMakeLLM;
  }

  const doc = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
  assert.deepEqual(doc.findings, []);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});

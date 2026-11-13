'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { detectProvider, makeProvider } = require('../../lib/providers/index.js');
const { LocalReviewProvider } = require('../../lib/providers/local.js');
const { ConfigError } = require('../../lib/errors.js');

/**
 * @param {string} dir
 * @param {string[]} args
 */
function git(dir, args) {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
}

/** @returns {{ dir: string, base: string, head: string }} */
function makeTwoCommitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owlet-local-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'a.js'), 'const x = 1;\n');
  git(dir, ['add', 'a.js']);
  git(dir, ['commit', '-m', 'base']);
  const base = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(dir, 'a.js'), 'const x = 1;\nconst y = 2;\n');
  git(dir, ['add', 'a.js']);
  git(dir, ['commit', '-m', 'head']);
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { dir, base, head };
}

test('detectProvider: --provider=local wins', () => {
  assert.equal(detectProvider({ env: {}, cliFlag: 'local' }), 'local');
});

test('detectProvider: still rejects unknown names', () => {
  assert.throws(() => detectProvider({ env: {}, cliFlag: 'fake' }), ConfigError);
});

test('detectProvider: CI auto-detect never picks local', () => {
  assert.equal(detectProvider({ env: { GITHUB_ACTIONS: 'true' } }), 'github');
});

test('makeProvider: local returns LocalReviewProvider without forge token', () => {
  const { dir, base, head } = makeTwoCommitRepo();
  const p = makeProvider('local', {
    config: { auth: {} },
    env: {},
    local: { repoDir: dir, base, head, nwo: 'o/r', prNumber: 7 },
  });
  assert.ok(p instanceof LocalReviewProvider);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('local getDiff returns the three-dot change set', async () => {
  const { dir, base, head } = makeTwoCommitRepo();
  const p = makeProvider('local', {
    config: { auth: {} },
    env: {},
    local: { repoDir: dir, base, head },
  });
  const diffs = await p.getDiff();
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].path, 'a.js');
  assert.match(diffs[0].patch, /\+const y = 2;/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('local listThreads empty; writes are no-ops', async () => {
  const { dir, base, head } = makeTwoCommitRepo();
  const p = makeProvider('local', {
    config: { auth: {} },
    env: { RB_REPO: dir, RB_BASE: base, RB_HEAD: head },
  });
  assert.deepEqual(await p.listThreads(), []);
  assert.equal(await p.findBotComment('summary'), null);
  await assert.doesNotReject(() => p.postThread({
    filePath: 'a.js', line: 1, body: 'x',
  }));
  await assert.doesNotReject(() => p.upsertSummaryComment('summary', 'body'));
  await assert.doesNotReject(() => p.deleteBotComment('summary'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('local getFileContent reads inside the repo and rejects traversal', async () => {
  const { dir, base, head } = makeTwoCommitRepo();
  const p = makeProvider('local', {
    config: { auth: {} },
    env: {},
    local: { repoDir: dir, base, head },
  });
  const body = await p.getFileContent('a.js', head);
  assert.match(body ?? '', /const y = 2/);
  assert.equal(await p.getFileContent('../outside.js', head), null);
  assert.equal(await p.getFileContent('../../etc/passwd', head), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

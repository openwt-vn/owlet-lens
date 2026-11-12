// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { Readable, Writable } = require('node:stream');

const { runInstallHook } = require('../lib/install-hook.js');

function realGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hook-test-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: dir });
  return dir;
}

function fakeStdin(lines) {
  const r = new Readable({ read() {} });
  r.isTTY = true;
  let i = 0;
  const feed = () => {
    if (i < lines.length) { r.push(lines[i++] + '\n'); setTimeout(feed, 5); } else { r.push(null); }
  };
  setTimeout(feed, 5);
  return r;
}

function capture() {
  let buf = '';
  const w = new Writable({ write(chunk, _e, cb) { buf += chunk.toString(); cb(); } });
  return { stream: w, text: () => buf };
}

async function run(dir, answers) {
  const out = capture();
  const code = await runInstallHook({ stdin: fakeStdin(answers), stdout: out.stream, cwd: dir });
  return { code, out };
}

test('install-hook: explains the risk before it asks, then installs on y', async () => {
  const dir = realGitRepo();
  try {
    const { code, out } = await run(dir, ['y']);
    assert.equal(code, 0);
    const text = out.text();
    assert.ok(text.indexOf('the commit is blocked') < text.indexOf('Install the hook?'));
    assert.ok(text.includes('git commit --no-verify'));
    assert.ok(text.includes('git config --unset core.hooksPath'));
    const hook = fs.readFileSync(path.join(dir, '.githooks', 'pre-commit'), 'utf8');
    assert.ok(hook.includes('owlet-lens review --dry-run'));
    assert.ok(!hook.includes('pipelines/scripts'));
    assert.ok(fs.statSync(path.join(dir, '.githooks', 'pre-commit')).mode & 0o100, 'executable');
    const hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: dir }).toString().trim();
    assert.equal(hooksPath, '.githooks');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('install-hook: changes nothing on n', async () => {
  const dir = realGitRepo();
  try {
    const { code, out } = await run(dir, ['n']);
    assert.equal(code, 0);
    assert.ok(out.text().includes('Nothing was changed'));
    assert.ok(!fs.existsSync(path.join(dir, '.githooks')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('install-hook: fails outside a git repository', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hook-nogit-'));
  try {
    const { code } = await run(dir, ['y']);
    assert.equal(code, 2);
    assert.ok(!fs.existsSync(path.join(dir, '.githooks')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('install-hook: never overwrites an existing pre-commit hook', async () => {
  const dir = realGitRepo();
  try {
    fs.mkdirSync(path.join(dir, '.githooks'));
    fs.writeFileSync(path.join(dir, '.githooks', 'pre-commit'), '#!/bin/sh\necho mine\n');
    const { code, out } = await run(dir, ['y']);
    assert.equal(code, 0);
    assert.ok(out.text().includes('already exists'));
    assert.equal(fs.readFileSync(path.join(dir, '.githooks', 'pre-commit'), 'utf8'), '#!/bin/sh\necho mine\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('install-hook: leaves a core.hooksPath that points elsewhere alone', async () => {
  const dir = realGitRepo();
  try {
    execFileSync('git', ['config', 'core.hooksPath', 'other-hooks'], { cwd: dir });
    const { code, out } = await run(dir, ['y']);
    assert.equal(code, 0);
    assert.ok(out.text().includes('other-hooks'));
    assert.ok(!fs.existsSync(path.join(dir, '.githooks')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

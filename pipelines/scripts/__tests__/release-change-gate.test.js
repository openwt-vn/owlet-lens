'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  evaluateReleaseChanges,
  previousVersionTag,
  nextVersion,
  jsonChangedBeyondOwletVersion,
} = require('../lib/release-change-gate.js');

/**
 * @param {string} dir
 * @param {string[]} args
 */
function git(dir, args) {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
}

/** @returns {string} */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owlet-rel-gate-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'one\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@openwt-vn/owlet-lens', version: '1.0.0' }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
    name: '@openwt-vn/owlet-lens',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: { '': { name: '@openwt-vn/owlet-lens', version: '1.0.0' } },
  }, null, 2) + '\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
  git(dir, ['tag', 'v1.0.0']);
  return dir;
}

test('jsonChangedBeyondOwletVersion ignores package version stamps only', () => {
  const a = JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { y: '1' } });
  const b = JSON.stringify({ name: 'x', version: '1.0.1', dependencies: { y: '1' } });
  const c = JSON.stringify({ name: 'x', version: '1.0.1', dependencies: { y: '2' } });
  assert.equal(jsonChangedBeyondOwletVersion(a, b), false);
  assert.equal(jsonChangedBeyondOwletVersion(a, c), true);
});

test('evaluateReleaseChanges: first release (no prev) is ok', () => {
  const dir = makeRepo();
  const r = evaluateReleaseChanges({ prevRef: null, currRef: 'HEAD', cwd: dir });
  assert.equal(r.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('evaluateReleaseChanges: README change is releasable', () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, 'README.md'), 'two\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'docs']);
  const r = evaluateReleaseChanges({ prevRef: 'v1.0.0', currRef: 'HEAD', cwd: dir });
  assert.equal(r.ok, true);
  assert.match(r.reason, /README/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('evaluateReleaseChanges: dependency bump in package.json is releasable', () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: '@openwt-vn/owlet-lens', version: '1.0.0', dependencies: { leftpad: '1.0.0' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
    name: '@openwt-vn/owlet-lens',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: '@openwt-vn/owlet-lens', version: '1.0.0', dependencies: { leftpad: '1.0.0' } },
      'node_modules/leftpad': { version: '1.0.0' },
    },
  }, null, 2) + '\n');
  git(dir, ['add', 'package.json', 'package-lock.json']);
  git(dir, ['commit', '-m', 'deps']);
  const r = evaluateReleaseChanges({ prevRef: 'v1.0.0', currRef: 'HEAD', cwd: dir });
  assert.equal(r.ok, true);
  assert.match(r.reason, /beyond the Owlet version stamp|package/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('evaluateReleaseChanges: only Owlet version stamp is not releasable', () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@openwt-vn/owlet-lens', version: '1.0.1' }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
    name: '@openwt-vn/owlet-lens',
    version: '1.0.1',
    lockfileVersion: 3,
    packages: { '': { name: '@openwt-vn/owlet-lens', version: '1.0.1' } },
  }, null, 2) + '\n');
  git(dir, ['add', 'package.json', 'package-lock.json']);
  git(dir, ['commit', '-m', 'bump']);
  const r = evaluateReleaseChanges({ prevRef: 'v1.0.0', currRef: 'HEAD', cwd: dir });
  assert.equal(r.ok, false);
  assert.match(r.reason, /only Owlet version stamps/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('previousVersionTag returns latest semver tag', () => {
  const dir = makeRepo();
  git(dir, ['tag', 'v1.1.0']);
  git(dir, ['tag', 'v1.0.5']);
  assert.equal(previousVersionTag({ cwd: dir }), 'v1.1.0');
  assert.equal(previousVersionTag({ cwd: dir, exclude: 'v1.1.0' }), 'v1.0.5');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nextVersion bumps patch minor major from base', () => {
  assert.equal(nextVersion('1.7.0', 'patch'), '1.7.1');
  assert.equal(nextVersion('v1.7.0', 'minor'), '1.8.0');
  assert.equal(nextVersion('1.7.9', 'major'), '2.0.0');
  assert.throws(() => nextVersion('1.7', 'patch'));
  assert.throws(() => nextVersion('1.7.0', 'beta'));
});

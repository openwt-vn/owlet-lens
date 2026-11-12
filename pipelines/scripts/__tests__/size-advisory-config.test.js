'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../lib/config-loader.js');
const { ConfigError } = require('../lib/errors.js');

const ENV = { ANTHROPIC_API_KEY: 'k' };

describe('review PR-size advisory config', () => {
  /** @type {string} */
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-size-cfg-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('defaults maxFiles / maxChangedLines / maxChangedLinesPerFile to null', () => {
    const cfg = loadConfig({ cwd: tmp, env: ENV, cliFlags: {} });
    assert.equal(cfg.review.maxFiles, null);
    assert.equal(cfg.review.maxChangedLines, null);
    assert.equal(cfg.review.maxChangedLinesPerFile, null);
  });

  it('accepts positive integers for each advisory key', () => {
    fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), [
      'review:',
      '  maxFiles: 40',
      '  maxChangedLines: 800',
      '  maxChangedLinesPerFile: 200',
      '',
    ].join('\n'));
    const cfg = loadConfig({ cwd: tmp, env: ENV, cliFlags: {} });
    assert.equal(cfg.review.maxFiles, 40);
    assert.equal(cfg.review.maxChangedLines, 800);
    assert.equal(cfg.review.maxChangedLinesPerFile, 200);
  });

  it('rejects non-positive values like maxFileBytes', () => {
    for (const [key, bad] of [
      ['maxFiles', 0],
      ['maxChangedLines', -1],
      ['maxChangedLinesPerFile', 1.5],
      ['maxFiles', true],
    ]) {
      fs.writeFileSync(path.join(tmp, 'ai-review.config.yaml'), `review:\n  ${key}: ${bad}\n`);
      assert.throws(
        () => loadConfig({ cwd: tmp, env: ENV, cliFlags: {} }),
        (err) => err instanceof ConfigError && new RegExp(`review\\.${key}`).test(err.message),
        `expected ConfigError for ${key}=${bad}`,
      );
    }
  });
});

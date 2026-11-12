'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  countChangedLines,
  evaluateSizeAdvisory,
  buildSizeAdvisoryBody,
  SIZE_ADVISORY_KEY,
} = require('../lib/size-advisory.js');

const PATCH_TWO = [
  '--- a/f',
  '+++ b/f',
  '@@ -1,2 +1,3 @@',
  ' context',
  '-old',
  '+new',
  '+extra',
].join('\n'); // 1 removed + 2 added = 3

describe('countChangedLines', () => {
  it('counts added and removed patch lines, skipping file headers', () => {
    assert.equal(countChangedLines(PATCH_TWO), 3);
  });

  it('returns 0 for missing or empty patches', () => {
    assert.equal(countChangedLines(undefined), 0);
    assert.equal(countChangedLines(''), 0);
  });
});

describe('evaluateSizeAdvisory', () => {
  const diffs = [
    { path: 'src/a.js', patch: PATCH_TWO },
    { path: 'src/b.js', patch: PATCH_TWO },
    { path: 'package-lock.json', patch: PATCH_TWO },
    { path: 'dist/out.js', patch: PATCH_TWO },
  ];

  it('is inactive when every limit is null', () => {
    const r = evaluateSizeAdvisory(diffs, {
      maxFiles: null, maxChangedLines: null, maxChangedLinesPerFile: null, skipGeneratedFiles: true,
    }, []);
    assert.equal(r.exceeded, false);
    assert.deepEqual(r.breaches, []);
    assert.equal(r.active, false);
  });

  it('builds the advisory set after exclude and boilerplate, before maxFileBytes', () => {
    const r = evaluateSizeAdvisory(diffs, {
      maxFiles: 1, maxChangedLines: null, maxChangedLinesPerFile: null, skipGeneratedFiles: true,
    }, ['**/package-lock.json']);
    // lock excluded, dist boilerplate-skipped → src/a.js + src/b.js = 2 files
    assert.equal(r.metrics.files, 2);
    assert.equal(r.metrics.changedLines, 6);
    assert.equal(r.exceeded, true);
    assert.equal(r.breaches.some((b) => b.kind === 'maxFiles'), true);
  });

  it('does not drop oversized-by-bytes files from the advisory set', () => {
    const huge = { path: 'src/huge.js', patch: 'x'.repeat(1000) };
    // Even with maxFileBytes in config, evaluate must not apply it (caller passes review slice only).
    const r = evaluateSizeAdvisory([huge, { path: 'src/a.js', patch: PATCH_TWO }], {
      maxFiles: 1, maxChangedLines: null, maxChangedLinesPerFile: null, skipGeneratedFiles: true,
    }, []);
    assert.equal(r.metrics.files, 2);
    assert.equal(r.exceeded, true);
  });

  it('flags maxChangedLines and maxChangedLinesPerFile independently', () => {
    const r = evaluateSizeAdvisory(
      [{ path: 'src/a.js', patch: PATCH_TWO }, { path: 'src/b.js', patch: PATCH_TWO }],
      { maxFiles: null, maxChangedLines: 5, maxChangedLinesPerFile: 2, skipGeneratedFiles: true },
      [],
    );
    assert.equal(r.exceeded, true);
    assert.ok(r.breaches.some((b) => b.kind === 'maxChangedLines' && b.actual === 6 && b.limit === 5));
    const perFile = r.breaches.filter((b) => b.kind === 'maxChangedLinesPerFile');
    assert.equal(perFile.length, 2);
  });

  it('does not exceed when under every set limit', () => {
    const r = evaluateSizeAdvisory(
      [{ path: 'src/a.js', patch: PATCH_TWO }],
      { maxFiles: 10, maxChangedLines: 100, maxChangedLinesPerFile: 10, skipGeneratedFiles: true },
      [],
    );
    assert.equal(r.active, true);
    assert.equal(r.exceeded, false);
    assert.deepEqual(r.breaches, []);
  });
});

describe('buildSizeAdvisoryBody', () => {
  it('lists each breach and embeds the marker', () => {
    const body = buildSizeAdvisoryBody({
      metrics: { files: 12, changedLines: 900 },
      breaches: [
        { kind: 'maxFiles', actual: 12, limit: 10 },
        { kind: 'maxChangedLines', actual: 900, limit: 500 },
        { kind: 'maxChangedLinesPerFile', path: 'src/a.js', actual: 120, limit: 100 },
      ],
      marker: '<!-- ai-review:v1:size-advisory -->',
    });
    assert.match(body, /PR-size advisory/);
    assert.match(body, /maxFiles/);
    assert.match(body, /src\/a\.js/);
    assert.match(body, /<!-- ai-review:v1:size-advisory -->/);
    assert.equal(SIZE_ADVISORY_KEY, 'size-advisory');
  });
});

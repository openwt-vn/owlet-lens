'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { sync, SIZE_ADVISORY_KEY } = require('../../lib/port/size-advisory-port.js');

const PATCH = [
  '--- a/f',
  '+++ b/f',
  '@@ -1 +1,2 @@',
  '-a',
  '+b',
  '+c',
].join('\n'); // 3 changed lines

function fakeProvider(opts = {}) {
  const state = {
    comments: new Map(opts.comments ?? []),
    upserts: [],
    deletes: [],
  };
  return {
    state,
    renderSummaryMarker(key = 'summary') {
      return `<!-- ai-review:v1:${key} -->`;
    },
    async findBotComment(key) {
      const hit = state.comments.get(key);
      return hit ? { id: hit.id } : null;
    },
    async upsertSummaryComment(key, body) {
      state.upserts.push({ key, body });
      const existing = state.comments.get(key);
      if (existing) {
        state.comments.set(key, { id: existing.id, body });
        return { id: existing.id, action: 'updated' };
      }
      state.comments.set(key, { id: 'new-1', body });
      return { id: 'new-1', action: 'created' };
    },
    async deleteBotComment(key) {
      state.deletes.push(key);
      const existing = state.comments.get(key);
      if (!existing) return { id: '', action: 'absent' };
      state.comments.delete(key);
      return { id: existing.id, action: 'deleted' };
    },
  };
}

describe('size-advisory-port.sync', () => {
  it('upserts when a limit is exceeded', async () => {
    const provider = fakeProvider();
    const r = await sync(provider, [{ path: 'a.js', patch: PATCH }, { path: 'b.js', patch: PATCH }], {
      review: { maxFiles: 1, skipGeneratedFiles: true },
      excludePaths: [],
    });
    assert.equal(r.action, 'created');
    assert.equal(r.evaluation.exceeded, true);
    assert.equal(provider.state.upserts.length, 1);
    assert.equal(provider.state.upserts[0].key, SIZE_ADVISORY_KEY);
    assert.match(provider.state.upserts[0].body, /maxFiles/);
  });

  it('deletes the sticky comment when limits clear', async () => {
    const provider = fakeProvider({
      comments: [[SIZE_ADVISORY_KEY, { id: '42', body: 'old' }]],
    });
    const r = await sync(provider, [{ path: 'a.js', patch: PATCH }], {
      review: { maxFiles: 10, skipGeneratedFiles: true },
      excludePaths: [],
    });
    assert.equal(r.action, 'deleted');
    assert.equal(r.id, '42');
    assert.equal(provider.state.comments.has(SIZE_ADVISORY_KEY), false);
  });

  it('noops when inactive and no existing comment', async () => {
    const provider = fakeProvider();
    const r = await sync(provider, [{ path: 'a.js', patch: PATCH }], {
      review: { maxFiles: null, maxChangedLines: null, maxChangedLinesPerFile: null },
      excludePaths: [],
    });
    assert.equal(r.action, 'noop');
    assert.equal(provider.state.upserts.length, 0);
    assert.equal(provider.state.deletes.length, 1); // deleteBotComment still probed
  });

  it('dry-run reports would-upsert without writing', async () => {
    const provider = fakeProvider();
    const r = await sync(provider, [{ path: 'a.js', patch: PATCH }, { path: 'b.js', patch: PATCH }], {
      review: { maxFiles: 1 },
      dryRun: true,
    });
    assert.equal(r.action, 'would-upsert');
    assert.equal(provider.state.upserts.length, 0);
  });

  it('dry-run reports would-delete when a stale comment exists', async () => {
    const provider = fakeProvider({
      comments: [[SIZE_ADVISORY_KEY, { id: '9', body: 'old' }]],
    });
    const r = await sync(provider, [{ path: 'a.js', patch: PATCH }], {
      review: { maxFiles: 10 },
      dryRun: true,
    });
    assert.equal(r.action, 'would-delete');
    assert.equal(provider.state.deletes.length, 0);
  });
});

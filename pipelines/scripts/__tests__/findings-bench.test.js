'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { toReviewBenchFindings } = require('../lib/findings-bench.js');

describe('toReviewBenchFindings', () => {
  const pr = {
    repo: 'https://github.com/owner/repo',
    pr_number: 42,
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
  };

  it('maps toPost findings into ReviewBench shape with message', () => {
    const out = toReviewBenchFindings({
      toPost: [{
        filePath: 'src/a.ts', line: 10, body: 'Race on shared buffer', ruleId: 'security',
      }],
      pr,
      agent: 'owlet-lens',
    });
    assert.deepEqual(out, {
      pr,
      agent: 'owlet-lens',
      findings: [{
        file: 'src/a.ts',
        start_line: 10,
        end_line: 10,
        message: 'Race on shared buffer',
        producer: 'owlet-lens',
      }],
    });
  });

  it('returns empty findings array when toPost is empty', () => {
    const out = toReviewBenchFindings({ toPost: [], pr, agent: 'try-agent' });
    assert.deepEqual(out.findings, []);
    assert.equal(out.agent, 'try-agent');
    assert.deepEqual(out.pr, pr);
  });

  it('strips a leading ./ from file paths', () => {
    const out = toReviewBenchFindings({
      toPost: [{ filePath: './lib/x.js', line: 1, body: 'x', ruleId: 'style' }],
      pr,
      agent: 'owlet-lens',
    });
    assert.equal(out.findings[0].file, 'lib/x.js');
  });
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { llmFetch } = require('../../lib/llm/http.js');

// No fetch stub here: this goes through the bundled undici fetch + Agent for real, so a Node version
// whose built-in fetch cannot work with the bundled dispatcher fails this test (see issue #43).
test('llmFetch POSTs through the bundled undici dispatcher', async (t) => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ echoed: JSON.parse(body) }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());

  const res = await llmFetch(`http://127.0.0.1:${server.address().port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  }, 5000);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { echoed: { hello: 'world' } });
});

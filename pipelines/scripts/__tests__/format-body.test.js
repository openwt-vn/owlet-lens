'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatBody } = require('../lib/format-body.js');

const base = { severity: 'HIGH', category: 'bug', body: 'Missing null check.' };

test('includes suggestion block on github provider', () => {
  const result = formatBody({ ...base, suggestion: 'if (x != null) {' }, 'github');
  assert.ok(result.includes('```suggestion'));
  assert.ok(result.includes('if (x != null) {'));
});

test('omits suggestion block on bitbucket provider', () => {
  const result = formatBody({ ...base, suggestion: 'if (x != null) {' }, 'bitbucket');
  assert.ok(!result.includes('```suggestion'));
});

test('omits suggestion block on unknown provider', () => {
  const result = formatBody({ ...base, suggestion: 'if (x != null) {' }, 'azure');
  assert.ok(!result.includes('```suggestion'));
});

test('drops multi-line suggestion', () => {
  const result = formatBody({ ...base, suggestion: 'line1\nline2' }, 'github');
  assert.ok(!result.includes('```suggestion'));
});

test('drops suggestion containing triple backticks', () => {
  const result = formatBody({ ...base, suggestion: 'wrap in ```code```' }, 'github');
  assert.ok(!result.includes('```suggestion'));
});

test('drops whitespace-only suggestion', () => {
  const result = formatBody({ ...base, suggestion: '   \n  ' }, 'github');
  assert.ok(!result.includes('```suggestion'));
});

test('drops empty string suggestion', () => {
  const result = formatBody({ ...base, suggestion: '' }, 'github');
  assert.ok(!result.includes('```suggestion'));
});

test('keeps leading indentation and trims trailing whitespace', () => {
  const result = formatBody({ ...base, suggestion: '  fix()  ' }, 'github');
  assert.ok(result.includes('```suggestion\n  fix()\n```'));
});

test('keeps a four-space indent on the suggested line', () => {
  const result = formatBody({ ...base, suggestion: '    return a < b;' }, 'github');
  assert.ok(result.includes('```suggestion\n    return a < b;\n```'));
});

test('drops leading blank lines but keeps the indent of the code line', () => {
  const result = formatBody({ ...base, suggestion: '\n\n    return a < b;\n' }, 'github');
  assert.ok(result.includes('```suggestion\n    return a < b;\n```'));
});

test('handles non-string suggestion (number)', () => {
  const result = formatBody({ ...base, suggestion: 42 }, 'github');
  assert.ok(!result.includes('```suggestion'));
});

test('handles undefined suggestion', () => {
  const result = formatBody({ ...base }, 'github');
  assert.ok(!result.includes('```suggestion'));
  assert.ok(result.includes('**[HIGH/bug]**'));
});

test('defaults severity and category when missing', () => {
  const result = formatBody({ body: 'test' }, 'github');
  assert.ok(result.includes('**[UNKNOWN/unknown]**'));
});

test('includes AI Review prefix from CONFIG', () => {
  const result = formatBody({ ...base }, 'github');
  assert.ok(result.startsWith('[Owlet Lens] '));
});

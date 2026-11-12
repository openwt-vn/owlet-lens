// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Readable, Writable } = require('node:stream');

const { runInit } = require('../lib/init.js');

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-init-test-'));
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

function fakeStdin(lines) {
  const r = new Readable({ read() {} });
  r.isTTY = true;
  let i = 0;
  const feed = () => {
    if (i < lines.length) {
      r.push(lines[i++] + '\n');
      setTimeout(feed, 5);
    } else {
      r.push(null);
    }
  };
  setTimeout(feed, 5);
  return r;
}

function captureStdout() {
  let buf = '';
  const w = new Writable({ write(chunk, _enc, cb) { buf += chunk.toString(); cb(); } });
  return { stream: w, text() { return buf; } };
}

test('init: generates config with anthropic defaults', async () => {
  const cwd = makeTmpDir();
  try {
    const out = captureStdout();
    const code = await runInit({
      stdin: fakeStdin(['github', 'anthropic', '', '', '', 'n', 'n']),
      stdout: out.stream,
      cwd,
    });
    assert.equal(code, 0);
    const cfg = fs.readFileSync(path.join(cwd, 'ai-review.config.yaml'), 'utf8');
    assert.ok(cfg.includes('provider: github'));
    assert.ok(cfg.includes('provider: anthropic'));
    assert.ok(cfg.includes('model: claude-sonnet-4-20250514'));
    assert.ok(cfg.includes('model: claude-haiku-4-5-20251001'));
    assert.ok(cfg.includes('anthropicKey: ${ANTHROPIC_API_KEY}'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: generates config with gemini provider', async () => {
  const cwd = makeTmpDir();
  try {
    const out = captureStdout();
    const code = await runInit({
      stdin: fakeStdin(['github', 'gemini', '', '', '', 'n', 'n']),
      stdout: out.stream,
      cwd,
    });
    assert.equal(code, 0);
    const cfg = fs.readFileSync(path.join(cwd, 'ai-review.config.yaml'), 'utf8');
    assert.ok(cfg.includes('provider: gemini'));
    assert.ok(cfg.includes('geminiKey: ${GEMINI_API_KEY}'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: unknown LLM provider falls back to anthropic', async () => {
  const cwd = makeTmpDir();
  try {
    const out = captureStdout();
    const code = await runInit({
      stdin: fakeStdin(['github', 'bogus', '', '', '', 'n', 'n']),
      stdout: out.stream,
      cwd,
    });
    assert.equal(code, 0);
    assert.ok(out.text().includes("Unknown LLM provider 'bogus'"));
    const cfg = fs.readFileSync(path.join(cwd, 'ai-review.config.yaml'), 'utf8');
    assert.ok(cfg.includes('provider: anthropic'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: includes codingStandardsPath when provided', async () => {
  const cwd = makeTmpDir();
  try {
    const out = captureStdout();
    await runInit({
      stdin: fakeStdin(['github', 'anthropic', '', '', './standards.md', 'n', 'n']),
      stdout: out.stream,
      cwd,
    });
    const cfg = fs.readFileSync(path.join(cwd, 'ai-review.config.yaml'), 'utf8');
    assert.ok(cfg.includes('codingStandardsPath: "./standards.md"'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: omits codingStandardsPath when empty', async () => {
  const cwd = makeTmpDir();
  try {
    const out = captureStdout();
    await runInit({
      stdin: fakeStdin(['github', 'anthropic', '', '', '', 'n', 'n']),
      stdout: out.stream,
      cwd,
    });
    const cfg = fs.readFileSync(path.join(cwd, 'ai-review.config.yaml'), 'utf8');
    assert.ok(!cfg.includes('codingStandardsPath'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: backs up existing config on overwrite', async () => {
  const cwd = makeTmpDir();
  try {
    const configPath = path.join(cwd, 'ai-review.config.yaml');
    fs.writeFileSync(configPath, 'old: true\n');
    const out = captureStdout();
    await runInit({
      stdin: fakeStdin(['y', 'github', 'anthropic', '', '', '', 'n', 'n']),
      stdout: out.stream,
      cwd,
    });
    const bakFiles = fs.readdirSync(cwd).filter(f => f.startsWith('ai-review.config.yaml.') && f.endsWith('.bak'));
    assert.ok(bakFiles.length >= 1, 'timestamped backup should exist');
    assert.equal(fs.readFileSync(path.join(cwd, bakFiles[0]), 'utf8'), 'old: true\n');
    const cfg = fs.readFileSync(configPath, 'utf8');
    assert.ok(cfg.includes('provider: anthropic'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: keeps existing config when user declines overwrite', async () => {
  const cwd = makeTmpDir();
  try {
    const configPath = path.join(cwd, 'ai-review.config.yaml');
    fs.writeFileSync(configPath, 'old: true\n');
    const out = captureStdout();
    const code = await runInit({
      stdin: fakeStdin(['n']),
      stdout: out.stream,
      cwd,
    });
    assert.equal(code, 0);
    assert.equal(fs.readFileSync(configPath, 'utf8'), 'old: true\n');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: skips hook when not a git repo', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-init-nogit-'));
  try {
    const out = captureStdout();
    await runInit({
      stdin: fakeStdin(['github', 'anthropic', '', '', '', '']),
      stdout: out.stream,
      cwd,
    });
    assert.ok(out.text().includes('Not a git repository'));
    assert.ok(!fs.existsSync(path.join(cwd, '.githooks')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: prints next steps with correct env var', async () => {
  const cwd = makeTmpDir();
  try {
    const out = captureStdout();
    await runInit({
      stdin: fakeStdin(['github', 'gemini', '', '', '', 'n', 'n']),
      stdout: out.stream,
      cwd,
    });
    assert.ok(out.text().includes('GEMINI_API_KEY'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

async function runWith(answers, setup) {
  const cwd = makeTmpDir();
  if (setup) setup(cwd);
  const out = captureStdout();
  const code = await runInit({ stdin: fakeStdin(answers), stdout: out.stream, cwd });
  return { cwd, out, code };
}

test('init: creates the GitHub workflow when asked', async () => {
  const { cwd, out, code } = await runWith(['github', 'anthropic', '', '', '', 'n', 'y']);
  try {
    assert.equal(code, 0);
    const wf = fs.readFileSync(path.join(cwd, '.github', 'workflows', 'ai-review.yml'), 'utf8');
    assert.ok(wf.includes('ai-review-reusable.yml@v1'));
    assert.ok(wf.includes("runner: '[\"ubuntu-latest\"]'"));
    assert.ok(wf.includes('secrets: inherit'));
    assert.ok(out.text().includes('Created .github/workflows/ai-review.yml'));
    assert.ok(out.text().includes('ANTHROPIC_API_KEY'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: writes no pipeline file when the answer is n', async () => {
  const { cwd } = await runWith(['github', 'anthropic', '', '', '', 'n', 'n']);
  try {
    assert.ok(!fs.existsSync(path.join(cwd, '.github')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: creates a GitLab pipeline that runs reply then review', async () => {
  const { cwd, out } = await runWith(['gitlab', 'deepseek', '', '', '', 'n', 'y']);
  try {
    const ci = fs.readFileSync(path.join(cwd, '.gitlab-ci.yml'), 'utf8');
    assert.ok(ci.includes('npm install -g @openwt-vn/owlet-lens'));
    assert.ok(ci.includes('owlet-lens "$cmd" --provider=gitlab'));
    assert.ok(ci.includes('for cmd in reply review; do'));
    assert.ok(ci.includes('merge_request_event'));
    assert.ok(out.text().includes('DEEPSEEK_API_KEY, GITLAB_TOKEN'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: creates a Bitbucket pipeline with its variables', async () => {
  const { cwd, out } = await runWith(['bitbucket', 'anthropic', '', '', '', 'n', 'y']);
  try {
    const bb = fs.readFileSync(path.join(cwd, 'bitbucket-pipelines.yml'), 'utf8');
    assert.ok(bb.includes('owlet-lens "$cmd" --provider=bitbucket'));
    assert.ok(bb.includes('pull-requests:'));
    assert.ok(out.text().includes('ANTHROPIC_API_KEY, AI_REVIEW_TOKEN'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: never overwrites an existing pipeline file', async () => {
  const { cwd, out } = await runWith(
    ['gitlab', 'anthropic', '', '', '', 'n', 'y'],
    (dir) => fs.writeFileSync(path.join(dir, '.gitlab-ci.yml'), 'mine: true\n'),
  );
  try {
    assert.equal(fs.readFileSync(path.join(cwd, '.gitlab-ci.yml'), 'utf8'), 'mine: true\n');
    assert.ok(fs.existsSync(path.join(cwd, '.gitlab-ci.yml.owlet-lens')));
    assert.ok(out.text().includes('already exists'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: Azure DevOps has no template and says so', async () => {
  const { cwd, out } = await runWith(['azure-devops', 'anthropic', '', '', '', 'n']);
  try {
    assert.ok(out.text().includes('no template yet'));
    assert.ok(!fs.existsSync(path.join(cwd, 'azure-pipelines.yml')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: the pre-commit hook calls the installed CLI, not a repo path', async () => {
  const { cwd } = await runWith(['github', 'anthropic', '', '', '', 'y', 'n']);
  try {
    const hook = fs.readFileSync(path.join(cwd, '.githooks', 'pre-commit'), 'utf8');
    assert.ok(hook.includes('owlet-lens review --dry-run'));
    assert.ok(!hook.includes('pipelines/scripts'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: openrouter writes its key field and requires a model', async () => {
  const bad = await runWith(['github', 'openrouter', '', '', '', 'n', 'n']);
  try {
    assert.equal(bad.code, 2);
  } finally {
    fs.rmSync(bad.cwd, { recursive: true, force: true });
  }
  const ok = await runWith(['github', 'openrouter', 'vendor/model-a', 'vendor/model-b', '', 'n', 'n']);
  try {
    const cfg = fs.readFileSync(path.join(ok.cwd, 'ai-review.config.yaml'), 'utf8');
    assert.ok(cfg.includes('openrouterKey: ${OPENROUTER_API_KEY}'));
  } finally {
    fs.rmSync(ok.cwd, { recursive: true, force: true });
  }
});

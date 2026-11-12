// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Readable, Writable } = require('node:stream');

const { runInit } = require('../lib/init.js');
const { pipelineTemplate, TOOL_VERSION } = require('../lib/init-pipelines.js');
const version = require('../../../package.json').version;

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
      stdin: fakeStdin(['github', 'anthropic', '', '', '', 'n']),
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
      stdin: fakeStdin(['github', 'gemini', '', '', '', 'n']),
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
      stdin: fakeStdin(['github', 'bogus', '', '', '', 'n']),
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
      stdin: fakeStdin(['github', 'anthropic', '', '', './standards.md', 'n']),
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
      stdin: fakeStdin(['github', 'anthropic', '', '', '', 'n']),
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
      stdin: fakeStdin(['y', 'github', 'anthropic', '', '', '', 'n']),
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

test('init: prints next steps with correct env var', async () => {
  const cwd = makeTmpDir();
  try {
    const out = captureStdout();
    await runInit({
      stdin: fakeStdin(['github', 'gemini', '', '', '', 'n']),
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
  const { cwd, out, code } = await runWith(['github', 'anthropic', '', '', '', 'y']);
  try {
    assert.equal(code, 0);
    const wf = fs.readFileSync(path.join(cwd, '.github', 'workflows', 'ai-review.yml'), 'utf8');
    assert.ok(wf.includes(`ai-review-reusable.yml@v${version}`));
    assert.ok(!wf.includes('ai-review-reusable.yml@v1\n'));
    assert.ok(wf.includes("runner: '[\"ubuntu-latest\"]'"));
    assert.ok(wf.includes('secrets: inherit'));
    assert.ok(out.text().includes('Created .github/workflows/ai-review.yml'));
    assert.ok(out.text().includes('ANTHROPIC_API_KEY'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: writes no pipeline file when the answer is n', async () => {
  const { cwd } = await runWith(['github', 'anthropic', '', '', '', 'n']);
  try {
    assert.ok(!fs.existsSync(path.join(cwd, '.github')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: creates a GitLab pipeline that runs reply then review', async () => {
  const { cwd, out } = await runWith(['gitlab', 'deepseek', '', '', '', 'y']);
  try {
    const ci = fs.readFileSync(path.join(cwd, '.gitlab-ci.yml'), 'utf8');
    assert.ok(ci.includes(`npm install -g @openwt-vn/owlet-lens@${version}`));
    assert.ok(ci.includes('owlet-lens "$cmd" --provider=gitlab'));
    assert.ok(ci.includes('for cmd in reply review; do'));
    assert.ok(ci.includes('merge_request_event'));
    assert.ok(out.text().includes('DEEPSEEK_API_KEY, GITLAB_TOKEN'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: creates a Bitbucket pipeline with its variables', async () => {
  const { cwd, out } = await runWith(['bitbucket', 'anthropic', '', '', '', 'y']);
  try {
    const bb = fs.readFileSync(path.join(cwd, 'bitbucket-pipelines.yml'), 'utf8');
    assert.ok(bb.includes(`npm install -g @openwt-vn/owlet-lens@${version}`));
    assert.ok(bb.includes('owlet-lens "$cmd" --provider=bitbucket'));
    assert.ok(bb.includes('pull-requests:'));
    assert.ok(out.text().includes('ANTHROPIC_API_KEY, AI_REVIEW_TOKEN'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: never overwrites an existing pipeline file', async () => {
  const { cwd, out } = await runWith(
    ['gitlab', 'anthropic', '', '', '', 'y'],
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

test('init: openrouter writes its key field and requires a model', async () => {
  const bad = await runWith(['github', 'openrouter', '', '', '', 'n']);
  try {
    assert.equal(bad.code, 2);
  } finally {
    fs.rmSync(bad.cwd, { recursive: true, force: true });
  }
  const ok = await runWith(['github', 'openrouter', 'vendor/model-a', 'vendor/model-b', '', 'n']);
  try {
    const cfg = fs.readFileSync(path.join(ok.cwd, 'ai-review.config.yaml'), 'utf8');
    assert.ok(cfg.includes('openrouterKey: ${OPENROUTER_API_KEY}'));
  } finally {
    fs.rmSync(ok.cwd, { recursive: true, force: true });
  }
});

test('init: pipeline files are pinned to the CLI version, and a given version wins', () => {
  assert.equal(TOOL_VERSION, version);
  assert.match(version, /^\d+\.\d+\.\d+/);
  const gh = pipelineTemplate('github', 'ANTHROPIC_API_KEY');
  assert.ok(gh && gh.content.includes(`ai-review-reusable.yml@v${version}`));
  const pinned = pipelineTemplate('github', 'ANTHROPIC_API_KEY', '9.8.7');
  assert.ok(pinned && pinned.content.includes('ai-review-reusable.yml@v9.8.7'));
  const gl = pipelineTemplate('gitlab', 'ANTHROPIC_API_KEY', '9.8.7');
  assert.ok(gl && gl.content.includes('owlet-lens@9.8.7'));
});

test('init: does not ask about or install a git hook', async () => {
  const { cwd, out } = await runWith(['github', 'anthropic', '', '', '', 'n']);
  try {
    assert.ok(!out.text().includes('Install git pre-commit hook?'));
    assert.ok(out.text().includes('owlet-lens install-hook'), 'only a hint about the separate command');
    assert.ok(!fs.existsSync(path.join(cwd, '.githooks')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: next steps go branch, commit, push and open a pull request, watch, check, hint', async () => {
  const { cwd, out } = await runWith(['github', 'openai', '', '', '', 'y']);
  try {
    const text = out.text();
    const at = (s) => { const i = text.indexOf(s); assert.ok(i >= 0, `missing: ${s}`); return i; };
    const order = [
      'Add to your CI settings',
      'git checkout -b ci/owlet-lens',
      'git add ai-review.config.yaml .github/workflows/ai-review.yml && git commit',
      'Push the branch, then open a pull request from it:  git push -u origin ci/owlet-lens',
      'Finally, watch the review on that pull request',
      'If the review fails, check that OPENAI_API_KEY is set',
      'Hint: to review before each commit as well, run `owlet-lens install-hook`',
    ].map(at);
    assert.deepEqual(order, [...order].sort((p, q) => p - q));
    assert.ok(text.includes('OPENAI_API_KEY'));
    assert.ok(!text.includes('--dry-run'));
    assert.ok(!text.includes('Test locally'));
    assert.ok(!text.includes('Open a pull request from that branch'), 'push and PR are one step');
    assert.equal((text.match(/^  \d\. /gm) || []).length, 4, 'four numbered steps');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: next steps tell the user to check the variable and to open an issue', async () => {
  const { cwd, out } = await runWith(['gitlab', 'deepseek', '', '', '', 'y']);
  try {
    const text = out.text();
    assert.ok(text.includes('If the review fails, check that DEEPSEEK_API_KEY, GITLAB_TOKEN are set'));
    assert.ok(text.includes('https://github.com/openwt-vn/owlet-lens/issues'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: without a pipeline file the next steps do not commit one', async () => {
  const { cwd, out } = await runWith(['github', 'anthropic', '', '', '', 'n']);
  try {
    const text = out.text();
    assert.ok(text.includes('git add ai-review.config.yaml && git commit'));
    assert.ok(text.includes('run init again and answer y'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

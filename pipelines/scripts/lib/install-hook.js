// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');

const HOOKS_DIR = '.githooks';
const HOOK_FILE = 'pre-commit';
const HOOK_CONTENT = '#!/bin/sh\nowlet-lens review --dry-run\n';

/**
 * Value of `git config core.hooksPath` in cwd, or '' when unset or not readable.
 * @param {string} cwd
 * @returns {string}
 */
function currentHooksPath(cwd) {
  try {
    return execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return '';
  }
}

/**
 * `owlet-lens install-hook`: install a git pre-commit hook that runs the review before each
 * commit. It is a separate command, not part of init, because the hook blocks a commit whenever
 * the review fails, and the review needs environment variables a new user has not set yet.
 * @param {{
 *   stdin?: NodeJS.ReadableStream,
 *   stdout?: NodeJS.WritableStream,
 *   cwd?: string,
 * }} [opts]
 * @returns {Promise<number>}
 */
async function runInstallHook(opts = {}) {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const cwd = opts.cwd ?? process.cwd();

  if (!/** @type {any} */ (stdin).isTTY && !opts.stdin) {
    process.stderr.write('Error: install-hook requires an interactive terminal\n');
    return 2;
  }
  if (!fs.existsSync(path.join(cwd, '.git'))) {
    process.stderr.write('Error: this is not a git repository (no .git here). Run install-hook in the repository root.\n');
    return 2;
  }

  const hookPath = path.join(cwd, HOOKS_DIR, HOOK_FILE);
  if (fs.existsSync(hookPath)) {
    stdout.write(`${HOOKS_DIR}/${HOOK_FILE} already exists, so nothing was changed.\n`);
    return 0;
  }
  const other = currentHooksPath(cwd);
  if (other && other !== HOOKS_DIR) {
    stdout.write(`git core.hooksPath is already set to "${other}", so nothing was changed. Add \`owlet-lens review --dry-run\` to the pre-commit hook there if you want it.\n`);
    return 0;
  }

  stdout.write(`
Owlet Lens: pre-commit hook

This adds a git pre-commit hook that runs \`owlet-lens review --dry-run\` before every commit.

Read this before you say yes:
  - The review needs the same environment variables as \`owlet-lens review\`: the token of your
    platform (for example GITHUB_TOKEN), the repository and pull request number
    (GITHUB_REPOSITORY, GITHUB_PR_NUMBER) and the key of your LLM provider.
  - If the review fails, for example because a variable is missing, the commit is blocked.
  - To commit anyway, once:   git commit --no-verify
  - To remove the hook:       delete ${HOOKS_DIR}/${HOOK_FILE} and run  git config --unset core.hooksPath

`);

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await new Promise((resolve) => rl.question('? Install the hook? (y/n) ', resolve));
    if (String(answer).trim().toLowerCase() !== 'y') {
      stdout.write('Nothing was changed.\n');
      return 0;
    }
  } finally {
    rl.close();
  }

  fs.mkdirSync(path.join(cwd, HOOKS_DIR), { recursive: true });
  fs.writeFileSync(hookPath, HOOK_CONTENT, { mode: 0o755 });
  try { fs.chmodSync(hookPath, 0o755); } catch { /* Windows */ }
  stdout.write(`\n✓ Created ${HOOKS_DIR}/${HOOK_FILE}\n`);
  try {
    execFileSync('git', ['config', 'core.hooksPath', HOOKS_DIR], { cwd, stdio: 'ignore' });
    stdout.write(`✓ Set git core.hooksPath to ${HOOKS_DIR}\n`);
  } catch {
    stdout.write(`  Warning: could not set core.hooksPath. Run it yourself: git config core.hooksPath ${HOOKS_DIR}\n`);
  }
  return 0;
}

module.exports = { runInstallHook };

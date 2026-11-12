// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { KNOWN_PROVIDERS } = require('./providers/index.js');
const { KNOWN_LLM_PROVIDERS } = require('./llm/index.js');
const { pipelineTemplate, writePipeline } = require('./init-pipelines.js');

const MODEL_DEFAULTS = {
  anthropic:  { review: 'claude-sonnet-4-20250514', reply: 'claude-haiku-4-5-20251001' },
  openai:     { review: 'gpt-4o',                   reply: 'gpt-4o-mini' },
  gemini:     { review: 'gemini-2.5-flash',          reply: 'gemini-2.5-flash' },
  deepseek:   { review: 'deepseek-chat',             reply: 'deepseek-chat' },
  modelstack: { review: '',                          reply: '' },
  openrouter: { review: '',                          reply: '' },
};

const KEY_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  modelstack: 'MODELSTACK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

const KEY_FIELD = {
  anthropic: 'anthropicKey',
  openai: 'openaiKey',
  gemini: 'geminiKey',
  deepseek: 'deepseekKey',
  modelstack: 'modelstackKey',
  openrouter: 'openrouterKey',
};

/**
 * @param {readline.Interface} rl
 * @param {string} q
 * @returns {Promise<string>}
 */
function ask(rl, q) {
  return new Promise((resolve) => rl.question(q, resolve));
}

/**
 * @param {{
 *   stdin?: NodeJS.ReadableStream,
 *   stdout?: NodeJS.WritableStream,
 *   cwd?: string,
 * }} [opts]
 * @returns {Promise<number>}
 */
async function runInit(opts = {}) {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const cwd = opts.cwd ?? process.cwd();

  if (!/** @type {any} */ (stdin).isTTY && !opts.stdin) {
    process.stderr.write('Error: init requires an interactive terminal\n');
    return 2;
  }

  const configPath = path.join(cwd, 'ai-review.config.yaml');

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const q = (/** @type {string} */ prompt) => ask(rl, prompt);

  try {
    stdout.write('\nOwlet Lens — Setup\n\n');

    if (fs.existsSync(configPath)) {
      const overwrite = (await q('? ai-review.config.yaml already exists. Overwrite? (y/n) ')).trim().toLowerCase();
      if (overwrite !== 'y') {
        stdout.write(`Keeping existing config at ${configPath}\n`);
        return 0;
      }
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const bakPath = `${configPath}.${ts}.bak`;
      fs.copyFileSync(configPath, bakPath);
      stdout.write(`  Backed up existing config to ${path.basename(bakPath)}\n`);
    }

    const providerChoices = KNOWN_PROVIDERS.join(' / ');
    const provider = (await q(`? Review provider: (${providerChoices}) `)).trim().toLowerCase() || KNOWN_PROVIDERS[0];

    const llmChoices = KNOWN_LLM_PROVIDERS.join(' / ');
    let llmProvider = (await q(`? LLM provider: (${llmChoices}) `)).trim().toLowerCase() || 'anthropic';
    if (!KNOWN_LLM_PROVIDERS.includes(llmProvider)) {
      stdout.write(`  Unknown LLM provider '${llmProvider}', defaulting to anthropic\n`);
      llmProvider = 'anthropic';
    }

    const defaults = MODEL_DEFAULTS[llmProvider] || { review: '', reply: '' };

    const reviewModelDefault = defaults.review ? ` (${defaults.review})` : '';
    const reviewModel = (await q(`? Review model:${reviewModelDefault} `)).trim() || defaults.review;
    if (!reviewModel) {
      stdout.write('  Error: review model is required\n');
      return 2;
    }

    const replyModelDefault = defaults.reply ? ` (${defaults.reply})` : '';
    const replyModel = (await q(`? Reply model:${replyModelDefault} `)).trim() || defaults.reply;
    if (!replyModel) {
      stdout.write('  Error: reply model is required\n');
      return 2;
    }

    const codingStandards = (await q('? Coding standards file path: (leave empty to skip) ')).trim();

    let hookInstalled = false;
    let isGitRepo = false;
    try {
      fs.statSync(path.join(cwd, '.git'));
      isGitRepo = true;
    } catch { /* not a git repo */ }

    if (isGitRepo) {
      const installHook = (await q('? Install git pre-commit hook? (y/n) ')).trim().toLowerCase();
      if (installHook === 'y') {
        const hooksDir = path.join(cwd, '.githooks');
        if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });
        const hookContent = '#!/bin/sh\nowlet-lens review --dry-run\n';
        const hookPath = path.join(hooksDir, 'pre-commit');
        fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
        try { fs.chmodSync(hookPath, 0o755); } catch { /* Windows */ }
        try {
          const { execSync } = require('node:child_process');
          execSync('git config core.hooksPath .githooks', { cwd });
          hookInstalled = true;
        } catch {
          stdout.write('  Warning: could not set core.hooksPath — run manually: git config core.hooksPath .githooks\n');
        }
      }
    } else {
      stdout.write('  Not a git repository — skipping hook installation\n');
    }

    const keyField = KEY_FIELD[llmProvider] || 'anthropicKey';
    const keyEnv = KEY_ENV[llmProvider] || 'ANTHROPIC_API_KEY';

    const template = pipelineTemplate(provider, keyEnv);
    /** @type {{ path: string, merged: boolean } | null} */
    let pipeline = null;
    if (template) {
      const createPipeline = (await q(`? Create the ${provider} pipeline file (${template.file})? (y/n) `)).trim().toLowerCase();
      if (createPipeline === 'y') pipeline = writePipeline(cwd, template);
    }

    let configContent = `# ai-review.config.yaml — generated by \`owlet-lens init\`\n\n`;
    configContent += `provider: ${provider}\n\n`;
    configContent += `review:\n`;
    configContent += `  provider: ${llmProvider}\n`;
    configContent += `  model: ${reviewModel}\n`;
    if (codingStandards) {
      configContent += `  codingStandardsPath: "${codingStandards}"\n`;
    }
    configContent += `\nreply:\n`;
    configContent += `  provider: ${llmProvider}\n`;
    configContent += `  model: ${replyModel}\n`;
    configContent += `\nauth:\n`;
    configContent += `  ${keyField}: \${${keyEnv}}\n`;

    fs.writeFileSync(configPath, configContent, 'utf8');
    stdout.write(`\n✓ Created ai-review.config.yaml\n`);
    if (hookInstalled) {
      stdout.write('✓ Installed .githooks/pre-commit\n');
      stdout.write('✓ Set git core.hooksPath to .githooks\n');
    }

    if (pipeline) {
      stdout.write(`✓ Created ${pipeline.path}\n`);
      if (pipeline.merged) {
        stdout.write(`  ${template ? template.file : 'The pipeline file'} already exists, so it was left alone. Merge ${pipeline.path} into it by hand.\n`);
      }
    }

    stdout.write(`\nNext steps:\n`);
    let step = 1;
    if (pipeline && template) {
      stdout.write(`  ${step++}. Add to your CI settings: ${template.variables.join(', ')}\n`);
    } else {
      stdout.write(`  ${step++}. Add ${keyEnv} to your CI secrets\n`);
      if (template) {
        stdout.write(`  ${step++}. Add the pipeline: re-run init and answer y, or copy ${template.file} from https://github.com/openwt-vn/owlet-lens#other-platforms\n`);
      } else {
        stdout.write(`  ${step++}. Add a pull request pipeline for ${provider} (no template yet): https://github.com/openwt-vn/owlet-lens#other-platforms\n`);
      }
    }
    stdout.write(`  ${step++}. Commit ai-review.config.yaml${pipeline ? ' and the pipeline file' : ''}\n`);
    stdout.write(`  ${step}. Test locally: owlet-lens review --dry-run\n\n`);

    return 0;
  } finally {
    rl.close();
  }
}

module.exports = { runInit };

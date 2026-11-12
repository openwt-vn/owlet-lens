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

const ISSUES_URL = 'https://github.com/openwt-vn/owlet-lens/issues';
const BRANCH = 'ci/owlet-lens';

/**
 * The text printed at the end of init: what to do next, in order.
 * @param {{
 *   provider: string,
 *   keyEnv: string,
 *   template: import('./init-pipelines.js').PipelineTemplate | null,
 *   pipeline: { path: string, merged: boolean } | null,
 * }} o
 * @returns {string}
 */
function nextSteps({ provider, keyEnv, template, pipeline }) {
  const variables = pipeline && template ? template.variables : [keyEnv];
  const files = ['ai-review.config.yaml'];
  if (pipeline) files.push(pipeline.path);

  const lines = ['', 'Next steps:'];
  let n = 1;
  lines.push(`  ${n++}. Add to your CI settings (secrets or variables, with exactly these names): ${variables.join(', ')}`);
  if (pipeline && pipeline.merged && template) {
    lines.push(`  ${n++}. ${template.file} already exists and was left alone: merge ${pipeline.path} into it by hand`);
  } else if (!pipeline) {
    if (template) {
      lines.push(`  ${n++}. Add the pipeline: run init again and answer y, or copy ${template.file} from https://github.com/openwt-vn/owlet-lens#other-platforms`);
    } else {
      lines.push(`  ${n++}. Add a pull request pipeline for ${provider} (no template yet): https://github.com/openwt-vn/owlet-lens#other-platforms`);
    }
  }
  lines.push(`  ${n++}. Create a new branch:  git checkout -b ${BRANCH}`);
  lines.push(`  ${n++}. Commit the change:    git add ${files.join(' ')} && git commit -m "ci: add Owlet Lens"`);
  lines.push(`  ${n}. Push the branch, then open a pull request from it:  git push -u origin ${BRANCH}`);
  lines.push('');
  lines.push('Finally, watch the review on that pull request: the findings appear there as comments within a minute or two.');
  lines.push(`If the review fails, check that ${variables.join(', ')} ${variables.length > 1 ? 'are' : 'is'} set in your CI settings, with exactly ${variables.length > 1 ? 'those names' : 'that name'}.`);
  lines.push(`If something else looks wrong, please open an issue: ${ISSUES_URL}`);
  lines.push('');
  lines.push('Hint: to review before each commit as well, run `owlet-lens install-hook` to add a git pre-commit hook. Read its warning first: it needs environment variables, and a failing review blocks the commit.');
  lines.push('');
  return lines.join('\n');
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

    if (pipeline) {
      stdout.write(`✓ Created ${pipeline.path}\n`);
    }

    stdout.write(nextSteps({ provider, keyEnv, template, pipeline }));

    return 0;
  } finally {
    rl.close();
  }
}

module.exports = { runInit };

// @ts-check
'use strict';

// CLI argument parsing for the ai-review entrypoint. Kept out of ai-review.js
// so the subcommand runners stay focused on orchestration.

const { ConfigError } = require('./errors.js');

/**
 * @param {string[]} argv
 * @returns {{
 *   subcommand: string,
 *   provider?: string,
 *   configPath?: string,
 *   dryRun?: boolean,
 *   strict?: boolean,
 *   forceReview?: boolean,
 *   base?: string,
 *   head?: string,
 *   repoDir?: string,
 *   findingsOut?: string,
 * }}
 */
function parseArgs(argv) {
  const flags = { subcommand: 'review' };
  const requireValue = (flag, idx) => {
    if (idx >= argv.length) throw new ConfigError(`flag ${flag} requires a value`);
    return argv[idx];
  };
  let i = 0;
  if (argv[0] && !argv[0].startsWith('--')) flags.subcommand = argv[i++];
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--provider=')) flags.provider = a.slice('--provider='.length);
    else if (a === '--provider') flags.provider = requireValue('--provider', ++i);
    else if (a.startsWith('--config=')) flags.configPath = a.slice('--config='.length);
    else if (a === '--config') flags.configPath = requireValue('--config', ++i);
    else if (a.startsWith('--base=')) flags.base = a.slice('--base='.length);
    else if (a === '--base') flags.base = requireValue('--base', ++i);
    else if (a.startsWith('--head=')) flags.head = a.slice('--head='.length);
    else if (a === '--head') flags.head = requireValue('--head', ++i);
    else if (a.startsWith('--repo-dir=')) flags.repoDir = a.slice('--repo-dir='.length);
    else if (a === '--repo-dir') flags.repoDir = requireValue('--repo-dir', ++i);
    else if (a.startsWith('--findings-out=')) flags.findingsOut = a.slice('--findings-out='.length);
    else if (a === '--findings-out') flags.findingsOut = requireValue('--findings-out', ++i);
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--force-review') flags.forceReview = true;
    else if (a === '--strict') flags.strict = true;
    else if (a.startsWith('--strict=')) flags.strict = a.slice('--strict='.length).toLowerCase() === 'true';
  }
  return flags;
}

module.exports = { parseArgs };

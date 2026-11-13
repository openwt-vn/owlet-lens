// @ts-check
'use strict';

/**
 * Release change gate: is there a meaningful tree difference between two git
 * refs (typically the previous version tag and main / the tag being released)?
 *
 * Owlet's own version stamp in package.json / package-lock.json alone does
 * not count. Dependency upgrades and any other file changes do.
 */

const { execFileSync } = require('node:child_process');

/**
 * @param {string[]} args
 * @param {{ cwd?: string, execFileSync?: typeof execFileSync }} [opts]
 * @returns {string}
 */
function git(args, opts = {}) {
  const run = opts.execFileSync ?? execFileSync;
  return run('git', args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).trimEnd();
}

/**
 * @param {string} ref
 * @param {string} filePath
 * @param {{ cwd?: string, execFileSync?: typeof execFileSync }} [opts]
 * @returns {string|null}
 */
function showFile(ref, filePath, opts = {}) {
  try {
    return git(['show', `${ref}:${filePath}`], opts);
  } catch {
    return null;
  }
}

/**
 * Drop only Owlet's own version stamp. Dependency package versions stay so a
 * security bump in package-lock.json still counts as a releasable change.
 * @param {unknown} value
 * @returns {unknown}
 */
function stripOwletVersionFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  /** @type {Record<string, unknown>} */
  const out = { .../** @type {Record<string, unknown>} */ (value) };
  delete out.version;
  if (out.packages && typeof out.packages === 'object' && !Array.isArray(out.packages)) {
    const pkgs = /** @type {Record<string, unknown>} */ (out.packages);
    const rootPkg = pkgs[''];
    if (rootPkg && typeof rootPkg === 'object' && !Array.isArray(rootPkg)) {
      /** @type {Record<string, unknown>} */
      const root = { .../** @type {Record<string, unknown>} */ (rootPkg) };
      delete root.version;
      out.packages = { ...pkgs, '': root };
    }
  }
  return out;
}

/**
 * @param {string|null} prevText
 * @param {string|null} currText
 * @returns {boolean}
 */
function jsonChangedBeyondOwletVersion(prevText, currText) {
  if (prevText === currText) return false;
  if (prevText == null || currText == null) return prevText !== currText;
  let prev;
  let curr;
  try {
    prev = JSON.parse(prevText);
    curr = JSON.parse(currText);
  } catch {
    return prevText !== currText;
  }
  return JSON.stringify(stripOwletVersionFields(prev)) !== JSON.stringify(stripOwletVersionFields(curr));
}

/**
 * @param {{
 *   prevRef: string|null|undefined,
 *   currRef: string,
 *   cwd?: string,
 *   execFileSync?: typeof execFileSync,
 * }} opts
 * @returns {{ ok: true, reason: string } | { ok: false, reason: string }}
 */
function evaluateReleaseChanges(opts) {
  const prev = opts.prevRef && String(opts.prevRef).trim() ? String(opts.prevRef).trim() : null;
  const curr = String(opts.currRef || '').trim();
  if (!curr) return { ok: false, reason: 'current ref is empty' };

  // First release: nothing to compare against.
  if (!prev) return { ok: true, reason: 'no previous version tag' };

  let names;
  try {
    const out = git(['diff', '--name-only', `${prev}..${curr}`], opts);
    names = out ? out.split('\n').filter(Boolean) : [];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `git diff failed: ${msg}` };
  }

  if (names.length === 0) {
    return { ok: false, reason: `no diff between ${prev} and ${curr}` };
  }

  const versionFiles = new Set(['package.json', 'package-lock.json']);
  const other = names.filter((n) => !versionFiles.has(n));
  if (other.length > 0) {
    return { ok: true, reason: `changed files beyond version stamps: ${other.join(', ')}` };
  }

  for (const file of names) {
    const prevText = showFile(prev, file, opts);
    const currText = showFile(curr, file, opts);
    if (jsonChangedBeyondOwletVersion(prevText, currText)) {
      return { ok: true, reason: `${file} changed beyond the Owlet version stamp` };
    }
  }

  return {
    ok: false,
    reason: `only Owlet version stamps differ between ${prev} and ${curr}`,
  };
}

/**
 * Latest semver tag vX.Y.Z, or null.
 * @param {{ cwd?: string, execFileSync?: typeof execFileSync, exclude?: string }} [opts]
 * @returns {string|null}
 */
function previousVersionTag(opts = {}) {
  const list = git(['tag', '-l', 'v[0-9]*.[0-9]*.[0-9]*', '--sort=v:refname'], opts);
  const tags = list ? list.split('\n').filter(Boolean) : [];
  const exclude = opts.exclude ? String(opts.exclude).trim() : '';
  const filtered = exclude ? tags.filter((t) => t !== exclude) : tags;
  return filtered.length ? filtered[filtered.length - 1] : null;
}

/**
 * Next semver from a base version and bump kind. Base may be "1.2.3" or "v1.2.3".
 * @param {string} baseVersion
 * @param {'patch'|'minor'|'major'|string} bump
 * @returns {string}
 */
function nextVersion(baseVersion, bump) {
  const raw = String(baseVersion || '').trim().replace(/^v/, '');
  const parts = raw.split('.').map((p) => Number(p));
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`invalid semver base: ${baseVersion}`);
  }
  let [maj, min, pat] = parts;
  const kind = String(bump || '').trim();
  if (kind === 'major') {
    maj += 1;
    min = 0;
    pat = 0;
  } else if (kind === 'minor') {
    min += 1;
    pat = 0;
  } else if (kind === 'patch') {
    pat += 1;
  } else {
    throw new Error(`invalid bump: ${bump}`);
  }
  return `${maj}.${min}.${pat}`;
}

module.exports = {
  evaluateReleaseChanges,
  previousVersionTag,
  nextVersion,
  stripOwletVersionFields,
  jsonChangedBeyondOwletVersion,
};

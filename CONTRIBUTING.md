# Contributing

Start here if you maintain or change this project. User-facing setup is in the [README](./README.md).

## 1. What this is

A CLI and GitHub Action that reviews pull requests with an LLM. Three subcommands: `review`, `reply`, `learn`. Four platforms (GitHub, Bitbucket Cloud, GitLab, Azure DevOps) and several LLM providers sit behind two interfaces. Cross-run state lives in comment markers, not a database ([ADR-0001](./docs/adr/0001-marker-based-state-no-state-file.md)).

## 2. Run it locally

```bash
npm install            # Node >= 20.10
npm test               # full suite (node:test, ~15s)
node --test pipelines/scripts/__tests__/<file>.test.js   # one file
npm run build          # ncc bundles into dist/ (gitignored, never commit)

GITHUB_TOKEN=... ANTHROPIC_API_KEY=... GITHUB_REPOSITORY=owner/repo GITHUB_PR_NUMBER=42 \
  npm run review -- --dry-run
```

`--dry-run` prints what would be posted. Env vars for other platforms: [docs/usage.md](./docs/usage.md).

## 3. Read in this order

1. [`CONTEXT.md`](./CONTEXT.md): the vocabulary (Review pass, Coverage, Action plan). Code, tests and issues use these words exactly.
2. [`CLAUDE.md`](./CLAUDE.md): architecture, layering rule, conventions, exit codes. Also the briefing for AI agents.
3. [`docs/adr/`](./docs/adr/) (index in [`docs/README.md`](./docs/README.md)): why things are the way they are. Read the ones touching your area **before** changing it. Especially [ADR-0002](./docs/adr/0002-asymmetric-reconcile-guards.md) before touching reconcile.
4. [`docs/config.md`](./docs/config.md): every config key.

## 4. Map of the code

Everything is under `pipelines/scripts/`.

| Path | Role |
|---|---|
| `ai-review.js`, `action-entry.js` | CLI entrypoint; GitHub Action entrypoint |
| `lib/review-pass.js` | diffs + threads → action plan (the core; tested with a fake LLM) |
| `lib/action-poster.js` | executes the plan: post / reply / reopen / close |
| `lib/reconcile.js` | decides which findings match which threads |
| `lib/review-llm.js`, `lib/prompt-builder.js` | the LLM call and its prompt |
| `lib/llm/` | one adapter per LLM provider, plus pricing and model failover |
| `lib/providers/` | **the only place that knows a platform API** (github, bitbucket, gitlab, azure-devops) |
| `lib/port/` | cross-cutting wrappers over providers: summary comment, replies, strict gate, state |
| `lib/learn/` | `learn` subcommand: mines `wontfix` verdicts into coding-standards rules |
| `lib/config-*.js` | load → merge defaults/env/CLI → validate |
| `lib/markers.js`, `fingerprint.js` | the hidden markers that carry cross-run identity |
| `__tests__/` | tests, mirroring `lib/` |

Layering: `ai-review.js` orchestrates, `port/` wraps, `providers/` talks to platforms. Don't leak Octokit/Bitbucket/GitLab/Azure types upward ([ADR-0012](./docs/adr/0012-providers-own-platform-concerns.md)).

## 5. Making a change

- Branch off `main`, keep files under 500 lines, no `console.log` (structured JSON to stderr), no tokens in logs.
- Never mutate findings or threads in place.
- `npm test` must be green. CI also runs `npm run coverage:gate`.
- Decision that is hard to reverse, surprising, and a real trade-off? Add an ADR (next free number in `docs/adr/`).
- Never commit `dist/` ([ADR-0006](./docs/adr/0006-dist-built-only-by-release.md)).
- Enable the pre-commit hook: `chmod +x .githooks/pre-commit`.

## 6. Releasing

Version bumps are deliberate, never automatic on merge. Preferred path: GitHub Actions → **Release** → Run workflow → `patch` / `minor` / `major`. That tags `main` HEAD (no direct push to protected `main`), publishes on the tag, then opens a version-sync PR ([ADR-0022](./docs/adr/0022-manual-release-change-gate.md)).

Local tag-only path (still subject to the release change gate):

```bash
git fetch --tags
git tag vX.Y.Z          # next version from the previous tag; tip should be main
git push origin vX.Y.Z
```

The Release workflow builds `dist/`, commits it to the tag, force-moves the major tag (`v1`) and publishes `@openwt-vn/owlet-lens` to npm. Consumers use `openwt-vn/owlet-lens@v1`. When the major changes, update the `@vN` references in `README.md` and `.github/workflows/ai-review-reusable.yml`.

The npm publish uses [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), so no npm token is stored here. On npmjs.com, the package settings must list the repository `openwt-vn/owlet-lens` and the workflow file `release.yml` as the trusted publisher. A version already on npm is skipped, so re-running a release is safe.

CI and the AI review of this repository take their runner from the repository variable `CI_RUNNER` (`self-hosted` while the repository is private) and default to GitHub-hosted `ubuntu-latest`, which is what a public repository should use. That line is not a security boundary: a pull request from a fork brings its own workflow file and can change it. Keep runner groups closed to public repositories and require approval for workflows from outside contributors. The Release job follows the same variable. It has write access, so it must run on GitHub-hosted runners once the repository is public: unset `CI_RUNNER` before that.

## 7. License of contributions

The project is licensed under the [Apache License 2.0](./LICENSE). Unless you state otherwise, a contribution you submit for inclusion is licensed under the same terms (section 5 of the license), so no separate agreement is needed.

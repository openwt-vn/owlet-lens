<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo/owlet-lens-dark.svg">
    <img src="docs/assets/logo/owlet-lens.svg" alt="Owlet Lens" height="72">
  </picture>
</h1>

<p align="center">
  <img src="docs/assets/hero.png" alt="A review thread in a pull request: the tool flags a bug, the developer replies, and the thread is marked as fixed and closed" width="100%">
</p>

[![CI](https://github.com/openwt-vn/owlet-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/openwt-vn/owlet-lens/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@openwt-vn/owlet-lens)](https://www.npmjs.com/package/@openwt-vn/owlet-lens)
![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)
![Node 20.10+](https://img.shields.io/badge/node-%E2%89%A520.10-339933)
![Platforms](https://img.shields.io/badge/platforms-GitHub%20%C2%B7%20GitLab%20%C2%B7%20Bitbucket%20%C2%B7%20Azure%20DevOps-c43727)

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#command-line">Command line</a> ·
  <a href="#github-action">GitHub Action</a> ·
  <a href="#other-platforms">GitLab · Bitbucket · Azure DevOps</a> ·
  <a href="#choose-an-llm-provider">LLM providers</a> ·
  <a href="#privacy-and-security">Privacy</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="#faq">FAQ</a>
</p>

AI code review for pull requests. It posts findings as inline review threads, reads developer replies, and closes threads that are fixed or declined. Runs on GitHub ([setup](./docs/github-action.md)), plus Bitbucket Cloud (Cloud only), GitLab ([setup](./docs/gitlab-setup.md)) and Azure DevOps ([setup](./docs/usage.md#review-provider-github-bitbucket-gitlab-or-azure-devops)).

## Why

- **It talks back.** It reads each developer reply and decides: fixed, will not fix, or still open.
- **It cleans up after itself.** Fixed threads close and regressions reopen, so the thread list matches the code.
- **It learns.** Findings your team keeps declining become proposed coding-standards rules, in a pull request that a person approves.
- **It runs where you are.** Four platforms, several AI providers (including local models), and nothing to host: no database, no server.

## How it works

![The flow: open a pull request, findings become threads, reply in the thread, threads close themselves](docs/assets/how-it-works.png)

1. **Review** (PR opened / pushed): sends the diff to an LLM, posts new findings, replies on ones still open, reopens regressions, closes fixed ones, and keeps one summary comment up to date.
2. **Reply** (developer answers in a review thread): an LLM reads the conversation and decides `fixed`, `wontfix` or `active`, then updates the thread.
3. **Learn** (on a schedule, optional): finds findings your team keeps declining and proposes new coding-standards rules in a pull request. A person always approves it; nothing merges by itself.

No database: review state lives in hidden markers inside the comments, and learned rules live in a file in your repo.

## Quick start

### Command line

Run it from a terminal or from any CI. It is on [npm](https://www.npmjs.com/package/@openwt-vn/owlet-lens) (Node 20.10 or newer):

```bash
npm install -g @openwt-vn/owlet-lens
GITHUB_TOKEN=... ANTHROPIC_API_KEY=... GITHUB_REPOSITORY=owner/repo GITHUB_PR_NUMBER=42 \
  owlet-lens review --dry-run     # print what it would post, post nothing
```

Or run it without installing: `npx @openwt-vn/owlet-lens review --dry-run`.

| Command | What it does |
|---|---|
| `owlet-lens review` | Review a pull request |
| `owlet-lens reply` | Judge developer replies in AI threads |
| `owlet-lens learn` | Propose coding-standards rules from declined findings |
| `owlet-lens init` | Ask a few questions and create `ai-review.config.yaml` |

Useful flags: `--dry-run`, `--strict` (exit code 8 on blocking findings), `--config=<path>`, `--provider=<github|bitbucket|gitlab|azure-devops>`, `--force-review`. Environment variables for the other platforms, flags and exit codes: [Usage reference](./docs/usage.md). To work on the code from a clone instead, see [CONTRIBUTING.md](./CONTRIBUTING.md).

### GitHub Action

To review every pull request automatically, add one secret (`ANTHROPIC_API_KEY`; other providers: [below](#choose-an-llm-provider)) and a workflow that calls `openwt-vn/owlet-lens@v1`. Step by step, with the reusable workflow and reading replies from the conversation tab: [GitHub Action setup](./docs/github-action.md). For GitLab, Bitbucket Cloud and Azure DevOps, see [Other platforms](#other-platforms).

## Other platforms

The GitHub Action wraps a command-line tool with two commands, `review` and `reply`. On the other platforms a pipeline clones this repo and runs those commands with Node; the templates below do that. You can also install the tool from npm instead of cloning (see [Command line](#command-line)). Each platform needs its own token plus one LLM key, and the tool detects the platform from the CI environment.

<details>
<summary><b>GitLab</b> (GitLab.com and self-hosted)</summary>

Review and reply run on merge request pipelines; learn runs on a pipeline schedule. Get the template in one of two ways: copy [`examples/gitlab-ci.yml`](./examples/gitlab-ci.yml) into your project as `.gitlab-ci.yml`, or include it from a mirror of this repo on your GitLab (`include:` only reads projects on the same GitLab, so push a copy of this repo there first):

```yaml
include:
  - project: '<group>/owlet-lens'
    ref: main
    file: '/examples/gitlab-ci.yml'
```

Either way, then set `AI_REVIEW_REPO` (the clone URL of your Owlet Lens mirror) and `AI_REVIEW_REF` (the tag to pin) in the template, add the CI/CD variables `ANTHROPIC_API_KEY` (or another LLM key) and `GITLAB_TOKEN` (`api` scope), and copy [`examples/ai-review.gitlab.yaml`](./examples/ai-review.gitlab.yaml) to `ai-review.config.yaml`. Full steps: [GitLab setup](./docs/gitlab-setup.md).
</details>

<details>
<summary><b>Bitbucket Cloud</b></summary>

Add a pull request pipeline step that runs `reply` and then `review` with `--provider=bitbucket`. Reply goes first so that the review sees the developers' latest answers. This repo's [`bitbucket-pipelines.yml`](./bitbucket-pipelines.yml) is a template with the install and run lines; it needs two secured repository variables, `AI_REVIEW_TOKEN` (an access token with `pullrequest:write`) and the LLM key named in your config (`DEEPSEEK_API_KEY` in the template). Bitbucket Pipelines has no comment trigger, so developer replies are read on the next push. Bitbucket Server and Data Center are not supported. Environment variables: [review provider](./docs/usage.md#review-provider-github-bitbucket-gitlab-or-azure-devops).
</details>

<details>
<summary><b>Azure DevOps</b></summary>

There is no pipeline template yet. In a pull request validation build, run the same two commands as the Bitbucket template with `--provider=azure-devops`, with a personal access token (PAT) in `AZURE_DEVOPS_TOKEN` or the pipeline's `System.AccessToken`, plus the LLM key named in your config (for example `ANTHROPIC_API_KEY`). The platform is detected on Azure Pipelines. Required variables and the `azure.*` config keys: [review provider](./docs/usage.md#review-provider-github-bitbucket-gitlab-or-azure-devops).
</details>


## Choose an LLM provider

Review and reply each pick a provider, so you can use a stronger model for review and a cheaper one for replies.

| Provider | Action input | Notes |
|---|---|---|
| Anthropic (default) | `anthropic-api-key` | Defaults: review `claude-opus-4-7`, reply `claude-haiku-4-5-20251001` |
| Gemini | `gemini-api-key` | Set `review-provider: gemini` |
| DeepSeek | `deepseek-api-key` | Set `review-provider: deepseek` |
| ModelStack (OpenAI-compatible gateway) | `modelstack-api-key` | No built-in price table: cost shows as `$0` unless you add a `pricing:` block |
| Any OpenAI-compatible endpoint, including local models | config `review.apiBaseUrl` | The key may be empty for local models |

To use a non-default provider, replace `anthropic-api-key` in **both** jobs and name the models:

```yaml
        with:
          gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
          review-provider: gemini
          reply-provider: gemini
          review-model: <a model your provider offers>
          reply-model: <a model your provider offers>
          subcommand: review   # or reply
```

A model name your provider does not accept makes every call fail. Fallback models, pricing and every other key are in the [configuration reference](./docs/config.md#llm-providers).

## Privacy and security

The tool sends your code to the LLM provider you choose, so decide with care.

- **Sent:** the diff of the pull request, the files the diff imports, the files you list in `review.contextPaths` and `review.codingStandardsPath`, and the developer replies it has to judge.
- **Scrubbed:** secret-shaped text (API keys, tokens, passwords, connection strings, private keys) is replaced with `[REDACTED]` in diffs, imported files, replies and learn input before sending. This is pattern matching, not a guarantee: a secret in an unusual shape still goes through.
- **Not scrubbed:** the contents of `contextPaths` and coding-standards files are sent as they are. Keep secrets out of them.
- **Fallback models** can route your code to another provider. Review every model you list.

Details per provider: [LLM data policy](./docs/llm-data-policy.md). To report a vulnerability, see [SECURITY.md](./SECURITY.md).

## Documentation

| Topic | Read |
|---|---|
| GitHub Action setup: the workflow file, replies from the conversation tab, the reusable workflow | [docs/github-action.md](./docs/github-action.md) |
| Action inputs and outputs, exit codes, strict mode (fail CI on serious findings), token permissions, version pinning | [docs/usage.md](./docs/usage.md) |
| Every `ai-review.config.yaml` key | [docs/config.md](./docs/config.md) |
| What is sent to each LLM provider | [docs/llm-data-policy.md](./docs/llm-data-policy.md) |
| GitLab setup | [docs/gitlab-setup.md](./docs/gitlab-setup.md) |
| Team lead gate (optional): hold the AI back on a pull request until a named lead starts it, for teams that want a person to decide which PRs get reviewed | [GitHub](./docs/tl-gate-github-setup.md) · [GitLab](./docs/tl-gate-gitlab-setup.md) · [Bitbucket](./docs/tl-gate-bitbucket-setup.md) · [Azure DevOps](./docs/tl-gate-azure-devops-setup.md) |
| Example configs and pipelines | [examples/](./examples/) |
| Run it locally, code map, releasing | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Full index, including architecture decisions | [docs/README.md](./docs/README.md) |

## How it compares

Based on each project's public documentation, checked 10 November 2026.

| | Owlet Lens | [CodeRabbit](https://docs.coderabbit.ai/platforms/overview.md) | [PR-Agent](https://github.com/qodo-ai/pr-agent) | [Copilot code review](https://docs.github.com/en/copilot/concepts/agents/code-review) |
|---|---|---|---|---|
| License | Apache-2.0 | Hosted service | MIT | Part of GitHub Copilot |
| Runs | In your CI | Their cloud; self-hosted for Enterprise | CLI, Action, Docker | GitHub |
| Platforms | GitHub, GitLab, Bitbucket Cloud, Azure DevOps | GitHub, GitLab, Bitbucket, Azure DevOps | GitHub, GitLab, Bitbucket, Azure DevOps, Gitea | GitHub, Azure DevOps (preview) |
| Your own AI model | ✅ Incl. local models | ❌ | ✅ Incl. local models | ❌ |
| Cost | LLM usage only | Per-developer plans | LLM usage only | Copilot plan |
| Reads replies, closes fixed threads | ✅ | ❌ | ❌ | ❌ |
| Learns rules from declined findings | ✅ | ❌ | ❌ | ❌ |

## What a run looks like

**A finding on a real pull request.** The tool posts each finding as a review thread on the line it is about, with a severity and a category. The developer can reply in the thread or resolve it.

![A review thread on a real pull request: the bot flags a CRITICAL bug on the changed line in e2e/run.ts and explains why](docs/assets/examples/finding-thread.png)

**The summary comment.** The bot keeps one summary comment per pull request and updates it on every push: what was found, replied to, reopened or closed, the cost of the run, the severity counts and how long it took.

![The Owlet Lens summary comment of the same pull request: 1 new finding, cost $0.0087, 1 file reviewed, duration 190.2s](docs/assets/examples/summary-comment.png)

## FAQ

Common questions (data and privacy, local models, cost, languages, forks, strict mode): see the [FAQ](./docs/faq.md).

## Customising

Optional: add `ai-review.config.yaml` at the repo root (models, severity threshold, paths to skip, coding standards). Start from the [example config](./examples/ai-review.config.yaml). Every key is in the [configuration reference](./docs/config.md).

| Want to… | Where |
|---|---|
| Fail CI on serious findings (`strict`) | [Usage reference](./docs/usage.md#strict-mode) |
| Let the bot flip GitHub's "Resolved" button | [Token permissions](./docs/usage.md#limitations--token-permissions) |
| All Action inputs and outputs, version pinning | [Usage reference](./docs/usage.md#inputs) |

## Team lead gate (optional)

By default the tool reviews every push. With the team lead gate (TL gate) on, a pull request gets **no AI review** until a team lead you name presses the platform's "turn the AI on" button for that PR. After that it reviews every push as usual. It keeps cost and noise down on repositories where you want a person to decide first.

```yaml
# ai-review.config.yaml, on the pull request's TARGET branch
review:
  tlGate:
    enabled: true
    leads: ["12345", "67890"]   # numeric user ids, not usernames
```

On GitHub the button is **Re-run all jobs** on the PR's review run; no workflow change is needed. The switch and the list are read from the target branch, so a pull request cannot turn its own gate off. Setup per platform: [GitHub](./docs/tl-gate-github-setup.md) · [GitLab](./docs/tl-gate-gitlab-setup.md) · [Bitbucket](./docs/tl-gate-bitbucket-setup.md) · [Azure DevOps](./docs/tl-gate-azure-devops-setup.md). Design: [ADR-0014](./docs/adr/0014-tl-gate-reads-the-target-branch.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Documentation index: [docs/README.md](./docs/README.md).

## License

Licensed under the [Apache License 2.0](./LICENSE). Copyright 2026 Open Web Technology Vietnam LLC.

The name Owlet Lens and its logo are not covered by the license: see [TRADEMARKS.md](./TRADEMARKS.md) and [NOTICE](./NOTICE).

<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo/owlet-lens-dark.svg">
    <img src="docs/assets/logo/owlet-lens.svg" alt="Owlet Lens" height="72">
  </picture>
</h1>

**English** · [Tiếng Việt](./README.vi.md)

<p align="center">
  <img src="docs/assets/hero.png" alt="A review thread in a pull request: the tool flags a bug, the developer replies, and the thread is marked as fixed and closed" width="100%">
</p>

[![CI](https://github.com/openwt-vn/owlet-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/openwt-vn/owlet-lens/actions/workflows/ci.yml)
![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)
![Node 20.10+](https://img.shields.io/badge/node-%E2%89%A520.10-339933)
![Platforms](https://img.shields.io/badge/platforms-GitHub%20%C2%B7%20GitLab%20%C2%B7%20Bitbucket%20%C2%B7%20Azure%20DevOps-c43727)

AI code review for pull requests. It posts findings as inline review threads, reads developer replies, and closes threads that are fixed or declined. Runs on GitHub (this page), plus Bitbucket Cloud, GitLab and Azure DevOps ([supported platforms](#supported-platforms)).

Built and used at OpenWT Vietnam.

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

## Quick start (GitHub)

**1. Add a secret.** Repo → Settings → Secrets and variables → Actions → `ANTHROPIC_API_KEY` (other providers: [below](#choose-an-llm-provider)).

**2. Add `.github/workflows/ai-review.yml`:**

```yaml
name: Owlet Lens
on:
  pull_request:
    types: [opened, synchronize, reopened]
  pull_request_review_comment:
    types: [created]

jobs:
  review:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest   # or self-hosted
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }   # the review needs full history to diff
      - uses: openwt-vn/owlet-lens@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          subcommand: review

  reply:
    if: github.event_name == 'pull_request_review_comment' && github.event.comment.user.type != 'Bot'
    runs-on: ubuntu-latest   # or self-hosted
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: openwt-vn/owlet-lens@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          subcommand: reply
```

Replies are read from comments **inside review threads** (`pull_request_review_comment`), not from the PR conversation tab.

**3. Open a pull request.** Findings appear as review threads within a minute or two. Reply to a thread to discuss it.

**Try it without touching your pull requests.** Add `dry-run: 'true'` under `with:` and the run prints what it would post, without posting anything. Remove it when you are happy.

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

## Good to know

- **Pull requests from forks get no secrets.** GitHub does not pass repository secrets to workflows triggered by a fork, so the review will not run for external contributors. Do not work around this with `pull_request_target` unless you understand the risk of running untrusted code with your secrets.
- **Cost.** A typical pull request takes about two model calls, and a push that does not change the reviewed content is skipped. The real cost depends on the model and the size of the diff; the summary comment reports it.
- **Pinning.** `@v1` follows the latest 1.x release. For reproducible runs pin an exact tag such as `@v1.0.0`, or a full commit SHA.

## Privacy and security

The tool sends your code to the LLM provider you choose, so decide with care.

- **Sent:** the diff of the pull request, the files the diff imports, the files you list in `review.contextPaths` and `review.codingStandardsPath`, and the developer replies it has to judge.
- **Scrubbed:** secret-shaped text (API keys, tokens, passwords, connection strings, private keys) is replaced with `[REDACTED]` in diffs, imported files, replies and learn input before sending. This is pattern matching, not a guarantee: a secret in an unusual shape still goes through.
- **Not scrubbed:** the contents of `contextPaths` and coding-standards files are sent as they are. Keep secrets out of them.
- **Fallback models** can route your code to another provider. Review every model you list.

Details per provider: [LLM data policy](./docs/llm-data-policy.md). To report a vulnerability, see [SECURITY.md](./SECURITY.md).

## Supported platforms

| Platform | Notes | Guide |
|---|---|---|
| GitHub | GitHub Action, full feature set | this page |
| GitLab | GitLab.com and self-hosted, CI template | [docs/gitlab-setup.md](./docs/gitlab-setup.md) |
| Bitbucket Cloud | Cloud only; Server and Data Center are not supported | [Provider setup](./docs/usage.md#review-provider-github-bitbucket-gitlab-or-azure-devops) |
| Azure DevOps | Services and Server | [Provider setup](./docs/usage.md#review-provider-github-bitbucket-gitlab-or-azure-devops) |

## What a run looks like

<details>
<summary>Example summary comment (illustrative numbers)</summary>

```
### [Owlet Lens] Summary

PR: #42 - Add refund endpoint
Findings: 3 new · 1 replied · 0 reopened · 1 closed
Cost: $0.0812 (1 call(s))
Severity: 1 HIGH · 2 MEDIUM
Files: 6 reviewed
```

The bot keeps one summary comment per pull request and updates it on every push. Each finding is its own thread on the line it is about.

</details>

## FAQ

- **Does it replace human review?** No. It is a first pass that catches routine problems, so reviewers can spend their time on design and business logic. People still approve and merge.
- **Is my code safe?** See [Privacy and security](#privacy-and-security): you choose the provider, secret-shaped text is scrubbed, and the details are in the [LLM data policy](./docs/llm-data-policy.md).
- **Can I use a local model?** Yes. Any OpenAI-compatible endpoint works, including local ones such as Ollama ([configuration reference](./docs/config.md#llm-providers)).
- **How much does it cost?** See [Good to know](#good-to-know). The summary comment shows the cost of each run.

## Customising

Optional: add `ai-review.config.yaml` at the repo root (models, severity threshold, paths to skip, coding standards). Start from the [example config](./examples/ai-review.config.yaml). Every key is in the [configuration reference](./docs/config.md).

| Want to… | Where |
|---|---|
| Fail CI on serious findings (`strict`) | [Usage reference](./docs/usage.md#strict-mode) |
| Let the bot flip GitHub's "Resolved" button | [Token permissions](./docs/usage.md#limitations--token-permissions) |
| All Action inputs and outputs, version pinning | [Usage reference](./docs/usage.md#inputs) |
| Use another LLM or tune noise | [docs/config.md](./docs/config.md) |
| Know what is sent to the LLM | [LLM data policy](./docs/llm-data-policy.md) |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Documentation index: [docs/README.md](./docs/README.md).

## License

Licensed under the [Apache License 2.0](./LICENSE). Copyright 2026 Open Web Technology Vietnam LLC.

The name Owlet Lens and its logo are not covered by the license (see section 6 of the license and [TRADEMARKS.md](./TRADEMARKS.md)). Platform names and logos belong to their owners and are used only to show compatibility; see [NOTICE](./NOTICE).

<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo/owlet-lens-dark.svg">
    <img src="docs/assets/logo/owlet-lens.svg" alt="Owlet Lens" height="72">
  </picture>
</h1>

<p align="center"><b>The AI code reviewer that reads your replies and closes its own threads.</b></p>

<p align="center">
  <img src="docs/assets/hero.png" alt="A review thread in a pull request: the tool flags a bug, the developer replies, and the thread is marked as fixed and closed" width="100%">
</p>

<p align="center">
  <a href="https://github.com/openwt-vn/owlet-lens/actions/workflows/ci.yml"><img src="https://github.com/openwt-vn/owlet-lens/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@openwt-vn/owlet-lens"><img src="https://img.shields.io/npm/v/@openwt-vn/owlet-lens" alt="npm"></a>
  <img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0">
  <img src="https://img.shields.io/badge/platforms-GitHub%20%C2%B7%20GitLab%20%C2%B7%20Bitbucket%20%C2%B7%20Azure%20DevOps-c43727" alt="Platforms">
  <a href="https://github.com/openwt-vn/owlet-lens/discussions"><img src="https://img.shields.io/github/discussions/openwt-vn/owlet-lens" alt="Discussions"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#other-platforms">Other platforms</a> ·
  <a href="#llm-providers">LLM providers</a> ·
  <a href="#privacy">Privacy</a> ·
  <a href="#how-it-compares">Compare</a> ·
  <a href="./docs/README.md">Docs</a> ·
  <a href="#community">Community</a>
</p>

Most AI reviewers post comments and walk away. Owlet Lens stays in the conversation: it posts findings as inline review threads, reads what the developer answers, and closes the thread when the code is fixed. The thread list always matches the code.

- **It talks back.** Reply in a thread and it decides: fixed, won't fix, or still open.
- **It cleans up after itself.** Fixed threads close. Regressions reopen. One summary comment stays up to date.
- **It learns.** Findings your team keeps declining become proposed coding-standards rules, in a pull request a person approves.
- **It runs where you are.** GitHub, GitLab, Bitbucket Cloud and Azure DevOps. Your own LLM key, including local models. No server, no database.

<!-- TODO: replace with docs/assets/demo.gif (10-15 s: finding appears, dev replies, "Marked as fixed") once recorded -->
![The flow: open a pull request, findings become threads, reply in the thread, threads close themselves](docs/assets/how-it-works.png)

**See it live:** this repo reviews its own pull requests. Open [any recent pull request](https://github.com/openwt-vn/owlet-lens/pulls?q=is%3Apr) to watch the threads and the summary comment. Small pull requests we measured cost under $0.01 each ([FAQ: cost](./docs/faq.md#what-does-a-review-cost)).

## Quick start

### GitHub (2 minutes)

**1. Add a secret.** Repo, Settings, Secrets and variables, Actions: add `ANTHROPIC_API_KEY`. Other providers: [LLM providers](#llm-providers).

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
    runs-on: ubuntu-latest
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
    runs-on: ubuntu-latest
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

**3. Open a pull request.** Findings appear as review threads within a minute or two. Reply in a thread to discuss a finding.

Reading replies from the conversation tab, the one-job reusable workflow, and every input: [GitHub Action setup](./docs/github-action.md).

### Any platform: let `init` write it

```bash
npx @openwt-vn/owlet-lens init
```

It asks for your platform, LLM provider and models, then writes `ai-review.config.yaml` and the pipeline file for GitHub, GitLab or Bitbucket Cloud. It never writes keys, and it never overwrites an existing pipeline file. At the end it prints the secrets to add and the git commands to commit. Details: [`owlet-lens init`](./docs/usage.md#owlet-lens-init).

### Try it from your terminal

Print what it would post on a pull request, and post nothing (Node 20.10+; LLM calls are checked on Node 20, 22, 24 and 26):

```bash
GITHUB_TOKEN=... ANTHROPIC_API_KEY=... GITHUB_REPOSITORY=owner/repo GITHUB_PR_NUMBER=42 \
  npx @openwt-vn/owlet-lens review --dry-run
```

All commands, flags and exit codes: [Usage reference](./docs/usage.md).

## Other platforms

Each platform needs its own access token plus one LLM key. The tool detects the platform from the CI environment.

<details>
<summary><b>GitLab</b> (GitLab.com and self-hosted)</summary>

Copy [`examples/gitlab-ci.yml`](./examples/gitlab-ci.yml) to `.gitlab-ci.yml` and [`examples/ai-review.gitlab.yaml`](./examples/ai-review.gitlab.yaml) to `ai-review.config.yaml`. Add the CI/CD variables `GITLAB_TOKEN` (`api` scope) and `ANTHROPIC_API_KEY` (or another LLM key). Review and reply run on merge request pipelines. Full steps: [GitLab setup](./docs/gitlab-setup.md).
</details>

<details>
<summary><b>Bitbucket Cloud</b></summary>

Start from this repo's [`bitbucket-pipelines.yml`](./bitbucket-pipelines.yml). It runs `reply`, then `review`, with `--provider=bitbucket`. Add two secured repository variables: `AI_REVIEW_TOKEN` (access token with `pullrequest:write`) and the LLM key named in your config. Bitbucket Pipelines has no comment trigger, so replies are read on the next push. Bitbucket Server and Data Center are not supported. Variables: [review provider](./docs/usage.md#review-provider-github-bitbucket-gitlab-or-azure-devops).
</details>

<details>
<summary><b>Azure DevOps</b></summary>

No pipeline template yet ([help wanted](#community)). In a pull request validation build, run `reply` and then `review` with `--provider=azure-devops`. Use a PAT in `AZURE_DEVOPS_TOKEN` or the pipeline's `System.AccessToken`, plus your LLM key. Variables and `azure.*` config keys: [review provider](./docs/usage.md#review-provider-github-bitbucket-gitlab-or-azure-devops).
</details>

## LLM providers

Review and reply each pick a provider, so you can use a strong model for review and a cheap one for replies. Backup models can switch provider when one fails ([model failover](./docs/config.md#model-failover)).

| Provider | Action input | Notes |
|---|---|---|
| Anthropic (default) | `anthropic-api-key` | Defaults: review `claude-opus-4-7`, reply `claude-haiku-4-5-20251001` |
| Gemini | `gemini-api-key` | Set `review-provider: gemini` |
| DeepSeek | `deepseek-api-key` | Set `review-provider: deepseek` |
| OpenRouter (many models, one key) | `openrouter-api-key` | Private routing by default (`data_collection: deny`); cost is OpenRouter's billed amount |
| ModelStack (OpenAI-compatible gateway) | `modelstack-api-key` | Add a `pricing:` block, otherwise cost shows as `$0` |
| Any OpenAI-compatible endpoint, including local models | config `review.apiBaseUrl` | The key may be empty for local models |

Switching provider, models and pricing: [configuration reference](./docs/config.md#llm-providers).

## Privacy

Your code goes to the LLM provider you choose, and nowhere else. There is no Owlet Lens server.

- **Sent:** the pull request diff, files the diff imports, files in `review.contextPaths` and `review.codingStandardsPath`, and the replies it judges.
- **Scrubbed:** secret-shaped text (keys, tokens, passwords, connection strings) becomes `[REDACTED]` before sending. This is pattern matching, not a guarantee.
- **Not scrubbed:** `contextPaths` and coding-standards files are sent as they are. Keep secrets out of them.
- **Fallback models** on another provider send your code to that provider too.

Per provider: [LLM data policy](./docs/llm-data-policy.md). Report a vulnerability: [SECURITY.md](./SECURITY.md).

## How it compares

<!-- TODO before launch: re-verify every cell against each project's current docs -->
Based on each project's public documentation, checked 10 November 2026.

| | Owlet Lens | [CodeRabbit](https://docs.coderabbit.ai/platforms/overview.md) | [PR-Agent](https://github.com/qodo-ai/pr-agent) | [Copilot code review](https://docs.github.com/en/copilot/concepts/agents/code-review) |
|---|---|---|---|---|
| License | Apache-2.0 | Hosted service | MIT | Part of GitHub Copilot |
| Runs | In your CI | Their cloud; self-hosted for Enterprise | CLI, Action, Docker | GitHub |
| Platforms | GitHub, GitLab, Bitbucket Cloud, Azure DevOps | GitHub, GitLab, Bitbucket, Azure DevOps | GitHub, GitLab, Bitbucket, Azure DevOps, Gitea | GitHub, Azure DevOps (preview) |
| Your own AI model | ✅ Incl. local models | ❌ | ✅ Incl. local models | ❌ |
| Cost | LLM usage only | Per-developer plans | LLM usage only | Copilot plan |
| Closes or reopens its threads from each reply's verdict, no command needed | ✅ | ❌ | ❌ | ❌ |
| Proposes rules from findings your team declined | ✅ | ❌ | ❌ | ❌ |

## Documentation

| Topic | Read |
|---|---|
| GitHub Action: workflow, conversation-tab replies, reusable workflow | [docs/github-action.md](./docs/github-action.md) |
| Commands, inputs, exit codes, strict mode, token permissions, version pinning | [docs/usage.md](./docs/usage.md) |
| Every `ai-review.config.yaml` key | [docs/config.md](./docs/config.md) |
| Team lead gate: hold the review until a named lead starts it | [GitHub](./docs/tl-gate-github-setup.md) · [GitLab](./docs/tl-gate-gitlab-setup.md) · [Bitbucket](./docs/tl-gate-bitbucket-setup.md) · [Azure DevOps](./docs/tl-gate-azure-devops-setup.md) |
| FAQ: cost, languages, forks, noise, blocking merges | [docs/faq.md](./docs/faq.md) |
| Example configs and pipelines | [examples/](./examples/) |
| Full index, including architecture decisions | [docs/README.md](./docs/README.md) |

## Community

Owlet Lens is young and shaped by its users. Questions, ideas and show-and-tell go in [Discussions](https://github.com/openwt-vn/owlet-lens/discussions). Bugs go in [Issues](https://github.com/openwt-vn/owlet-lens/issues).

**Help wanted:**

- A **Gitea / Forgejo** review provider
- **Bitbucket Server / Data Center** support
- An **Azure DevOps** pipeline template and `init` support
- Review-quality reports on your language or stack

New here? Start with a [good first issue](https://github.com/openwt-vn/owlet-lens/labels/good%20first%20issue). [CONTRIBUTING.md](./CONTRIBUTING.md) covers running it locally, the code map and the test suite (116 test files; CI fails any library file under 80% line coverage).

<a href="https://github.com/openwt-vn/owlet-lens/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=openwt-vn/owlet-lens" alt="Contributors">
</a>

If Owlet Lens saves your team review time, a ⭐ helps others find it.

## License

Licensed under the [Apache License 2.0](./LICENSE). Copyright 2026 Open Web Technology Vietnam LLC.

The name Owlet Lens and its logo are not covered by the license: see [TRADEMARKS.md](./TRADEMARKS.md) and [NOTICE](./NOTICE).

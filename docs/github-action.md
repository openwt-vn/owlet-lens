# GitHub Action setup

Review every pull request automatically with the GitHub Action. For a one-off review from a terminal, see the [command line](../README.md#command-line) instead; for the other platforms, see [Other platforms](../README.md#other-platforms).

> [!TIP]
> Prefer the terminal? Run `owlet-lens init` in your repository: it can create the workflow below for you ([details](./usage.md#owlet-lens-init)). You still add the secret yourself.

## 1. Add a secret

Repo → Settings → Secrets and variables → Actions → `ANTHROPIC_API_KEY` (other providers: [LLM providers](../README.md#choose-an-llm-provider)).

## 2. Add the workflow

Create `.github/workflows/ai-review.yml`:

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

> [!TIP]
> To also read replies from the conversation tab, add `issue_comment: { types: [created] }` under `on:` and replace the reply job's `if:` with:
>
> ```yaml
> if: >-
>   (github.event_name == 'pull_request_review_comment' && github.event.comment.user.type != 'Bot')
>   || (github.event_name == 'issue_comment' && github.event.issue.pull_request != null)
> ```
>
> This repo's own [workflow](../.github/workflows/ai-review.yml) adds a check that the commenter is a member of the repo.

## 3. Open a pull request

 Findings appear as review threads within a minute or two. Reply to a thread to discuss it.

> [!NOTE]
> Every Action input and output, the exit codes and version pinning are in the [usage reference](./usage.md).

<details>
<summary><b>Shorter: call the reusable workflow</b></summary>

Keep the `on:` block from step 2 and replace the two jobs with one call. It runs both the review and the reply job:

```yaml
jobs:
  ai-review:
    uses: openwt-vn/owlet-lens/.github/workflows/ai-review-reusable.yml@v1
    with:
      runner: '["ubuntu-latest"]'   # required; '["self-hosted"]' for your own runners
    secrets: inherit
```

`runner` is a JSON list in a string because the workflow passes it to `runs-on`. It reads one LLM key secret (`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `MODELSTACK_API_KEY` or `OPENROUTER_API_KEY`) and the optional `AI_REVIEW_RESOLVE_TOKEN`; the list is at the top of [`ai-review-reusable.yml`](../.github/workflows/ai-review-reusable.yml).
</details>

# FAQ

Short answers to the questions people ask first. Each one links to the page with the details.

1. [Does it replace human review?](#does-it-replace-human-review)
2. [Where does my code go?](#where-does-my-code-go)
3. [Can I keep my code inside my own network?](#can-i-keep-my-code-inside-my-own-network)
4. [What does a review cost?](#what-does-a-review-cost)
5. [Which languages does it review?](#which-languages-does-it-review)
6. [Which platforms are supported?](#which-platforms-are-supported)
7. [Does it post the same findings again on every push?](#does-it-post-the-same-findings-again-on-every-push)
8. [Why is a fixed thread not marked "Resolved"?](#why-is-a-fixed-thread-not-marked-resolved)
9. [How do I reduce noisy findings?](#how-do-i-reduce-noisy-findings)
10. [Can it block a merge?](#can-it-block-a-merge)
11. [Does it work on pull requests from forks?](#does-it-work-on-pull-requests-from-forks)
12. [What does "learn" change in my repository?](#what-does-learn-change-in-my-repository)

## Does it replace human review?

No. It is a first pass that catches routine problems, so reviewers can spend their time on design and business logic. People still approve and merge.

## Where does my code go?

To the LLM provider you choose, and nowhere else. There is no Owlet Lens server and no database. What is sent: the diff of the pull request, the files the diff imports, the files you list in `review.contextPaths` and `review.codingStandardsPath`, and the developer replies it has to judge. Secret-shaped text in diffs, imported files and replies is replaced with `[REDACTED]` first; this is pattern matching, not a guarantee.

Details per provider, including which paths are scrubbed and which are not: [LLM data policy](./llm-data-policy.md).

## Can I keep my code inside my own network?

Yes, if you point it at a model you host. Use the `openai` provider with a self-hosted endpoint (Ollama, LM Studio, a company gateway) through `review.apiBaseUrl`, run the job on a runner that can reach that endpoint, and list its host in the `allowed-hosts` input, because a configuration file is not allowed to send data to an unapproved host. See [Where the configuration file may send data](./config.md#where-the-configuration-file-may-send-data).

Check the model names and quality yourself: a model your endpoint does not offer makes every call fail, and we have not measured how local models compare.

## What does a review cost?

You pay your LLM provider for the tokens used; there is no per-seat fee. The summary comment on each pull request shows the cost of the run and the running total. Two small pull requests we looked at cost $0.0061 and $0.0087. A larger diff, a stronger model, or a second review pass costs more, so treat these as examples, not an average.

Cost depends on the model. Anthropic, Gemini and DeepSeek have a built-in price table for their listed models; for any other model or provider (ModelStack, a local endpoint) add a `pricing:` block, otherwise cost shows as `$0` ([LLM providers](./config.md#llm-providers)).

## Which languages does it review?

It reviews the diff with an LLM, so it is not tied to one language. You can add language-specific rules with `review.codingStandards` (a glob and a rules file per language) so that only matching files get those rules: [Language-aware coding standards](./config.md#language-aware-coding-standards-v16). We have not measured review quality per language.

## Which platforms are supported?

GitHub, GitLab (GitLab.com and self-hosted), Bitbucket Cloud and Azure DevOps. Bitbucket Server / Data Center is not supported. Setup for each: [Usage reference](./usage.md#review-provider-github-bitbucket-gitlab-or-azure-devops) and the [GitLab setup](./gitlab-setup.md).

## Does it post the same findings again on every push?

No. Each finding carries a hidden fingerprint in its comment, so a finding that is still open is not posted twice, and the tool replies on it instead. A push that leaves the reviewable content unchanged, such as a merge from the target branch, is skipped ([ADR-0015](./adr/0015-skip-unchanged-review-fingerprint.md)). State lives in these markers, not in a database ([ADR-0001](./adr/0001-marker-based-state-no-state-file.md)).

## Why is a fixed thread not marked "Resolved"?

The default `GITHUB_TOKEN` cannot call the GraphQL mutation that flips GitHub's "Resolved" button. The tool still posts a reply that records `fixed` or `wontfix`, and that reply is what it reads on later runs, so reconciliation is correct; the thread just stays open on screen. To let it flip the button, give it a personal access token with the `repo` scope through the `resolve-token` input. Threads already stuck are resolved on the next run. See [token permissions](./usage.md#limitations--token-permissions).

## How do I reduce noisy findings?

Defaults already drop low-severity style and naming findings, findings on test files below `high`, and generated paths (`dist/`, `vendor/`, `migrations/`, `*.lock`, and similar). Tune them with `review.severityThreshold`, `review.testFileSeverityThreshold`, `review.noiseCategories` and `review.skipGeneratedFiles`. A second pass (`review.reflection`, on by default) asks the reply model (usually a cheaper one) to challenge each finding before it is posted. Details: [Noise reduction](./usage.md#noise-reduction). Note that the default skips `migrations/` and mock files; turn `skipGeneratedFiles` off if you want those reviewed.

## Can it block a merge?

Optionally. With `strict: 'true'`, the check fails (exit code 8) while a finding at or above `review.severityThreshold` is still open. It turns green when the finding is fixed or a reply argues it to `wontfix`, not when someone presses Resolve. Make the check required in your branch rules to block the merge. See [Strict mode](./usage.md#strict-mode).

## Does it work on pull requests from forks?

Not with your secrets. By GitHub's default, a workflow started by a pull request from a fork does not receive repository secrets, so a review that needs your LLM key cannot run there. Do not work around this by exposing secrets to fork code. The `/review` command of the reusable workflow also refuses fork pull requests. More: [SECURITY.md](../SECURITY.md#for-people-who-use-the-action).

## What does "learn" change in my repository?

Nothing on its own. It is optional and runs on a schedule you set. It collects the findings your team declined (`wontfix`) in merged pull requests and, when a pattern repeats, opens a pull request that adds a rule to a LEARNED block at the end of your coding-standards file. A person reviews and merges that pull request. Rules you wrote by hand above the block are never touched. See [Self-learning](./config.md#self-learning-reviewlearn).

# Domain glossary

Terms used across the review pipeline. Code, tests, issues and docs use these words with exactly these meanings.

## Review pass

One PR's journey from raw diffs and existing threads to an **action plan**. Owned by `pipelines/scripts/lib/review-pass.js` (`runReviewPass`). It covers dismissed-context building, secret redaction, file bypasses (exclude / size / boilerplate), the LLM call plan (main call plus overflow chunks), the finding filter chain (validate → deletion-only → noise → truncate), **coverage**, and reconcile.

Out of scope: loading config and context files, posting to the provider, the summary comment, the strict gate, state/audit/webhook side effects. Those stay with the `review` subcommand orchestrator (`runReview`).

_Avoid_: "review step", "LLM stage".

## Coverage

The set of changed files that were inside a prompt whose response parsed successfully. Only threads on covered files may be auto-closed.

A changed file is **uncovered** when it was excluded by `paths.exclude`, over `review.maxFileBytes`, a boilerplate path, dropped by the token budget without being chunked, or in a chunk whose call failed or did not parse. Uncovered files keep their existing threads untouched. Coverage size is the summary's `filesReviewed`.

_Avoid_: "reviewed files" when the skip reason matters; say "covered" / "uncovered".

## Action plan

The review pass's output buckets, computed by reconcile:

- `toPost`: new finding, no matching thread.
- `toReply`: matches an active thread.
- `toReopen`: matches a non-active thread.
- `toClose`: active bot thread, on a covered file, whose line changed in this diff, with no matching finding and the bot holding the last word.

_Avoid_: "reconcile result", "diff plan".

## TL gate

The per-repository switch `review.tlGate` that holds the AI back until a team lead turns it on for a PR. Owned by `pipelines/scripts/lib/port/tl-gate.js` (the decision) and `lib/port/tl-gate-run.js` (the two comment writes around `runReview`); wired into `runReview` before any LLM client is built.

It is a **decision, not a review step**: it answers "may this run spend a token?" from three facts — the switch and the lead list on the PR's **target branch**, whether this run is a **button run**, and whether the PR already carries the **AI on note**. A held-back PR costs one config read and one comment.

_Avoid_: "approval", "human review", "the TL review". The gate decides whether the AI runs at all; the platform's own rule that a TL must approve before merge is a separate, non-code concern.

## Button run

A CI run that a human started by pressing the platform's "turn the AI on" control, as opposed to one started by a push. The only kind of run that can turn the AI on. Each provider reads its own platform's facts into a `TriggerInfo` (`manual`, `actorId`, `actorLabel`, `howToTurnOn`) per [ADR-0012](./adr/0012-providers-own-platform-concerns.md).

| Platform | The button | How the run knows | Presser |
|---|---|---|---|
| GitHub | "Re-run all jobs" on the PR's review run | `pull_request` event and `GITHUB_RUN_ATTEMPT` > 1 | `GITHUB_TRIGGERING_ACTOR`, resolved via `GET /users/{username}` |
| GitLab | the manual job's **Play** button | `CI_JOB_MANUAL=true` | `GITLAB_USER_ID` |
| Bitbucket | **Run** on the manual step | `AI_REVIEW_TL_PRESSED`, which the manual step exports itself | `BITBUCKET_STEP_TRIGGERER_UUID` |
| Azure DevOps | the Manual build-validation policy | `AI_REVIEW_TL_PRESSED`, set by the pipeline | `Build.RequestedForId` / `Build.QueuedById` |

_Avoid_: "manual run", "re-run" (means something else on GitHub, where the CLI also has a `/review` comment).

## AI on note

The bot's own sticky comment on the PR recording that a listed team lead turned the AI on and when. It is the gate's only memory: every later push finds it and reviews. Its own comment is the evidence — a note someone else edited, or a marker pasted into a human comment, does not count.

The PR carries exactly one gate comment under the marker key `tl-gate` (the slot, updated in place, whatever the gate has to say); "on" is the second marker, `tl-on`, inside it. The two are separate because the slot alone must not mean permission — otherwise the bot's own "waiting for a team lead" comment would open the gate on the next push.

_Avoid_: "the summary comment", "the gate marker". The summary is a different comment with a different lifecycle (in append mode, a new one per run).

## Review fingerprint

One hash of everything a review pass's outcome depends on that a push can change: each reviewable file's own changes (added and removed lines, not hunk headers or context), the effective config minus `auth`, and the coding standards. Owned by `pipelines/scripts/lib/review-fingerprint.js`; the skip decision lives in `lib/port/skip-unchanged.js`.

A full review stamps it into the summary comment as the `reviewed-<hash>` key marker. A later push with the same fingerprint, such as a merge from the target branch, skips the review ([ADR-0015](./docs/adr/0015-skip-unchanged-review-fingerprint.md)), unless it is a **button run** or forced.

_Avoid_: "diff hash" (the raw diff changes on a merge; the fingerprint does not), "incremental review" (a different, unbuilt feature).

## Carried blocker

An open (`active`) bot finding thread from an earlier run whose stored severity is at or above `review.severityThreshold`. With `review.strict` on, it keeps the run at exit 8, on full reviews and skips, until the bot marks it `fixed` or `wontfix`. The platform's Resolve button does not clear it ([ADR-0016](./docs/adr/0016-strict-gate-counts-open-blocking-threads.md)).

_Avoid_: "stale finding" (the finding is current; only its thread is older than this run).

## PR-size advisory

An optional, comment-only warning that a PR's file count or changed-line churn (added + removed) has crossed one or more of `review.maxFiles`, `review.maxChangedLines`, or `review.maxChangedLinesPerFile`. It does not bypass files, hold the review, or change the exit code by itself; the review still runs. Counts use the **advisory set**: after `paths.exclude` and boilerplate, and deliberately before `review.maxFileBytes` ([ADR-0018](./docs/adr/0018-pr-size-advisory.md)). The bot keeps one sticky PR comment under the `size-advisory` marker while any configured limit is exceeded, and deletes it when none are.

_Avoid_: "size gate", "maxFileBytes bypass", "token budget overflow", "uncovered" (those are technical limits or Coverage, not this warning).

## Release change gate

The check that refuses a new Owlet version when the tree being released does not meaningfully differ from the previous semver tag. Owlet's own version stamp in `package.json` / `package-lock.json` alone is not enough; dependency upgrades and any other file changes are ([ADR-0022](./docs/adr/0022-manual-release-change-gate.md)).

_Avoid_: "CI gate", "TL gate", "strict gate" (those are review-time controls).

## Manual release

Starting the Release workflow from the Actions tab (`workflow_dispatch`) with a `patch` / `minor` / `major` bump so `main` is versioned and tagged without a local `git tag`. Publishing still happens only on the resulting tag push ([ADR-0022](./docs/adr/0022-manual-release-change-gate.md)).

_Avoid_: "auto release on merge" (merging to `main` does not publish).

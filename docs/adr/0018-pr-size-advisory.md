# ADR-0018: PR-size advisory is comment-only with its own count set

Repos can cap how large a PR may get before the bot warns. That warning is not a technical bypass (`maxFileBytes`, `tokenBudget`) and not a hold (`tlGate` / `skipUnchanged`): the review still runs, files still reach the LLM, and crossing a limit does not by itself change the exit code.

## Decision

1. **Advisory, not a gate.** `review.maxFiles`, `review.maxChangedLines`, and `review.maxChangedLinesPerFile` (each optional, default `null`) only drive a sticky PR comment. Exceeding them never skips the LLM call and never bypasses a file the way `maxFileBytes` does.
2. **Own comment, own marker.** The warning lives under the `size-advisory` key marker, not in the summary body, so size noise does not fight the summary lifecycle (sticky vs append) and can be deleted cleanly when the PR shrinks under every configured limit.
3. **Advisory set ≠ reviewable set.** Counts run after `paths.exclude` and boilerplate, and **before** `maxFileBytes`. Lockfiles and generated paths stay out of the warning; a single huge patch still counts toward churn even if the LLM later bypasses it on bytes. `partitionReviewable` keeps its existing order (`exclude → maxFileBytes → boilerplate`) so Coverage and the review fingerprint do not shift.
4. **Churn is added + removed** lines in the unified-diff patch (same sense as prompt prioritization), not net lines and not provider `additions`/`deletions` metadata.

## Consequences

- Azure DevOps sometimes synthesizes a whole-file `+` patch; advisories there can fire sooner than on GitHub for the same edit. Documented next to the config keys; no per-provider counter.
- Upsert or delete of the advisory comment counts as review activity (exit `1`) when it is the only write; it never forces exit `8`.
- TL-held and fingerprint-skip runs do not sync the advisory (no diff write phase on those paths).

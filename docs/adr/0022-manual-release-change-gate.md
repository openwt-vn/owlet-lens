# ADR-0022: Manual release with a change gate

- **Status**: Accepted
- **Date**: 2026-11-13
- **Related**: [ADR-0006](./0006-dist-built-only-by-release.md) (`dist/` still only lands from the Release workflow)

## Context

Release already ran only on a `vX.Y.Z` tag push (not on every merge to `main`). That is easy to miss: people expect a button on the Actions tab. Separately, a docs-only merge (for example a README refresh) can sit on `main` after the last version tag with no new release. We needed a **manual** path that still refuses to mint a version when there is nothing meaningful to ship.

## Decision

1. **`workflow_dispatch` on the Release workflow** with input `bump`: `patch` | `minor` | `major`. That job checks out `main`, runs the **release change gate**, computes the next version from the previous semver tag (not from a commit on `main`), tags **current `main` HEAD**, and pushes only `vX.Y.Z`. It does **not** push commits to `main`.
2. **Publish runs in the same workflow run after a successful prepare-tag** (and still on a human/PAT tag `push`). A tag push that uses `GITHUB_TOKEN` does **not** start a new workflow, so splitting “tag in dispatch / publish on push” leaves an unpublished tag. The release job builds `dist/`, writes the GitHub Release, and publishes to npm.
3. **Release change gate** (both dispatch and tag-push): compare the current ref to the previous semver tag. Fail the job when there is no meaningful diff. Owlet's own version stamp in `package.json` / `package-lock.json` alone is not meaningful. Dependency upgrades and any other file changes (including README) are.
4. Gate logic lives in `pipelines/scripts/lib/release-change-gate.js` so it can be unit-tested.
5. **`main` is branch-protected** (PR required + status checks). Direct pushes from Actions fail with GH013. After publish, the Release job opens a `chore/bump-version-X.Y.Z` PR to sync `package.json` on `main` instead of pushing to `main`.

## Consequences

- Actions → Release → Run workflow is enough to ship `main` when it differs from the last version (for example after a docs PR with no prior bump).
- Pushing a tag that only re-stamps the package version against an identical tree fails the gate instead of republishing empty notes.
- Local `git tag` + push still works, subject to the same gate on the tag job.
- Version choice on the manual path is the bump input; humans are not required to bump on `main` first for that path.
- `main`'s `package.json` may lag the latest tag until the sync PR merges; the next manual release still bases the version on the latest tag.
- If a prior dispatch left an unpublished tag pointing at `main` HEAD, the next dispatch resumes that version instead of minting another bump.

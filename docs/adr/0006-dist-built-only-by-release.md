# `dist/` is gitignored and only the Release workflow commits it

A JavaScript GitHub Action usually commits its bundled `dist/` so that `uses: …@ref` works. Committing the bundle on feature branches caused merge conflicts in generated output on almost every PR. So `dist/` is gitignored. The Release workflow builds it on a `vX.Y.Z` tag push, commits it to the tag, and force-updates the major tag (`v2`). Consumers pin to release tags, which always contain `dist/`. A branch or SHA ref does not contain it.

## Consequences

- Never commit `dist/` in a feature branch or PR.
- `uses: …@main` or `@<sha>` will not run. Test unreleased changes via a tag or by running the scripts directly.
- Version bumps are explicit (see CLAUDE.md, "Release / shipping"). Merging to `main` does not publish. Manual release and the change gate are in [ADR-0022](./0022-manual-release-change-gate.md).

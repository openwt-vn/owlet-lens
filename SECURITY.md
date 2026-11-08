# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Use **private vulnerability reporting** on GitHub: open the [Security tab](https://github.com/openwt-vn/owlet-lens/security/advisories/new) of this repository and choose "Report a vulnerability". Only the maintainers can read the report.

A good report says what you did, what happened, what you expected, and which version (`@v1`, a tag, or a commit) you used. A short reproduction is the most useful thing you can send.

We read every report, tell you what we decide, and credit you in the advisory if you want that. Please give us a reasonable time to ship a fix before you publish details.

## Supported versions

Only the latest `1.x` release gets security fixes. Pin an exact tag or a full commit SHA if you need reproducible runs, and update when an advisory asks you to.

## What counts

We want to hear about anything that lets someone without access to a repository's secrets or runners reach them through Owlet Lens, for example:

- a secret (LLM key, `GITHUB_TOKEN`, the resolve token) sent somewhere the workflow did not approve, or written to a log, an output, a file or a comment;
- a way for a configuration file, a pull request, a comment or a model answer to run code, or to choose the runner, in the workflow of the repository that uses the action;
- a bypass of the guards described in [ADR-0019](./docs/adr/0019-config-cannot-redirect-secrets.md) (secret variables only under `auth.*`, approved hosts for URLs that receive data) or of the `/review` fork guard;
- a flaw in the secret scrubbing that is not simply "an unusual secret shape went through" (see [Privacy and security](./README.md#privacy-and-security): that part is pattern matching and says so).

## What does not count

- A review that is wrong, missing or noisy. That is a normal issue.
- A secret you put in `review.contextPaths` or a coding-standards file: those files are sent as they are, by design.
- A setting you chose that sends code to a provider you do not trust. The provider is your choice; see the [LLM data policy](./docs/llm-data-policy.md).
- A pull request that changes the workflow file of its own repository. Whoever can change that file already controls that repository's runners and secrets; protect it with branch rules, required reviews and "approve workflows from outside contributors".

## For people who use the action

- Give each job only the permissions it needs. The examples here use `contents: read` and `pull-requests: write`.
- Choose the runner yourself. The reusable workflow has no default `runner` and resolves the label among the runners of your repository.
- Do not run a pull request from a fork with your secrets. The `/review` command of this project refuses forks for that reason; do the same in your own workflows.

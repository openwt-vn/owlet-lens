# Owlet Lens as a ReviewBench agent

A thin adapter that runs Owlet Lens with `--provider=local` and `--findings-out=$RB_OUT`, so [ReviewBench](https://github.com/review-bench/ReviewBench) can score it. No forge token is needed; pass an LLM key (the default config uses Anthropic).

Env the adapter reads: `RB_NWO`, `RB_PR_NUMBER`, `RB_BASE`, `RB_HEAD`, `RB_OUT`, `RB_REPO` (optional), `RB_AGENT` (optional), plus the LLM key named in `ai-review.config.yaml`.

## Build and publish (manual workflow)

Run **Actions -> ReviewBench image -> Run workflow**. There is no input: the Owlet Lens version is read from `package.json` on the branch you run it on, and it must already be published on npm (release first). The workflow builds `linux/amd64` and pushes `ghcr.io/<owner>/owlet-lens-reviewer:<version>-<build>`, where `<build>` counts up from 0 for that version (`1.8.0-0`, `1.8.0-1`, ...). Existing tags are never overwritten. The image digest is printed in the run summary. Register the digest, not the tag, on review-bench.ai.

A new GHCR package starts private. Make it public in the package settings so the portal can pull it anonymously.

## Build and try locally

```sh
docker build --platform linux/amd64 --build-arg OWLET_VERSION=1.8.0 -t owlet-lens-reviewer:dev benchmarks/reviewbench
# from a ReviewBench clone, with ANTHROPIC_API_KEY in the shell
scripts/try-agent.sh owlet-lens-reviewer:dev --pr 0 -e ANTHROPIC_API_KEY
```

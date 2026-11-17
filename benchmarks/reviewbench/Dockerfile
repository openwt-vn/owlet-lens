# ReviewBench vendor image: Owlet Lens local review -> findings.json
# Build: docker build --platform linux/amd64 --build-arg OWLET_VERSION=<x.y.z> -t owlet-lens-reviewer:dev .
FROM node:22-slim

# Pin an exact published version (>= 1.7.0 has the local provider and --findings-out).
ARG OWLET_VERSION

RUN test -n "$OWLET_VERSION" \
    && apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --no-audit --no-fund "@openwt-vn/owlet-lens@${OWLET_VERSION}" \
    && npm cache clean --force

WORKDIR /agent
COPY agent.mjs ai-review.config.yaml ./

ENTRYPOINT ["node", "/agent/agent.mjs"]

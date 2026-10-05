# syntax=docker/dockerfile:1.7
# Blueprint Steward, as a team hosts it beside its codebase: git, gh, the claude CLI, pnpm and yarn through corepack,
# and Steward itself, bundled at /opt/blueprint-steward. Debian trixie, for a git (2.47) whose grep takes
# --end-of-options, which the repo history tool passes. The image serves any repository: the entrypoint clones the
# served repository (BLUEPRINT_REPO_URL) into the /work volume and runs Steward against it.
#   docker build -t blueprint-steward:local .
# deploy/compose/compose.yaml and deploy/helm/blueprint-steward run it; see either for the environment it needs.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-trixie-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/spec/package.json packages/spec/
COPY packages/steward/package.json packages/steward/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY packages packages
# Steward's bin and its two MCP servers, each bundled into one file at the paths the bin resolves; no node_modules ship.
RUN node packages/steward/scripts/bundle.mjs /out

FROM node:${NODE_VERSION}-trixie-slim AS runtime
# The claude CLI the design agent runs on, and the Blueprint generator CLI a repository's designTooling may call.
ARG CLAUDE_CODE_VERSION=latest
ARG PV3_CLI_VERSION=latest
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl gnupg openssh-client \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@bett3r-dev/pv3-cli@${PV3_CLI_VERSION}" \
    && npm cache clean --force \
    && corepack enable \
    && mkdir -p /work && chown node:node /work
COPY --from=build --chown=root:root /out /opt/blueprint-steward
COPY --chmod=0755 deploy/docker/steward-entrypoint.sh /usr/local/bin/steward-entrypoint
RUN ln -s /opt/blueprint-steward/bin/blueprint-steward.mjs /usr/local/bin/blueprint-steward
# corepack fetches the served repository's pinned package manager on first use; keep it and pnpm's store on the volume.
ENV COREPACK_HOME=/work/.corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    npm_config_store_dir=/work/.pnpm-store
USER node
WORKDIR /work
ENTRYPOINT [ "steward-entrypoint" ]
CMD [ "start" ]

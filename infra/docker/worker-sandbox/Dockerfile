FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && npm install --global pnpm@11.7.0 @anthropic-ai/claude-code@2.1.216 @openai/codex@0.144.6 \
  && chmod 0555 "$(readlink -f /usr/local/bin/claude)" "$(readlink -f /usr/local/bin/codex)" \
  && find /usr/local/lib/node_modules/@openai/codex -type f -name codex -exec chmod 0555 {} + \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY --chmod=0555 provider-entrypoint.mjs /usr/local/bin/theforge-provider-entrypoint

USER node
WORKDIR /workspace

# syntax=docker/dockerfile:1

FROM oven/bun:1 AS builder
WORKDIR /app

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /home/bun && chown -R bun:bun /home/bun /app
USER bun

ENV SHELL=/bin/bash

RUN curl -L https://foundry.paradigm.xyz | bash \
    && /home/bun/.foundry/bin/foundryup

COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY --chown=bun:bun . .

RUN cd ./foundry && /home/bun/.foundry/bin/forge install foundry-rs/forge-std --no-git

RUN ls foundry && cd ./foundry && /home/bun/.foundry/bin/forge test

FROM oven/bun:1-slim AS runtime
WORKDIR /app

USER root
RUN mkdir -p /home/bun && chown -R bun:bun /home/bun

ENV SHELL=/bin/bash \
    NODE_ENV=production \
    PORT=8080 \
    FORGE_PROJECT_DIR=/app/foundry \
    PATH="/home/bun/.foundry/bin:$PATH"

COPY --from=builder --chown=bun:bun /home/bun/.foundry /home/bun/.foundry
COPY --from=builder --chown=bun:bun /app /app

USER bun

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD bun -e "fetch('http://localhost:8080/api/health').then(r => process.exit(r.ok ? 0 : 1))" || exit 1

CMD ["bun", "run", "index.ts"]

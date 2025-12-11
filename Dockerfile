# syntax=docker/dockerfile:1

FROM oven/bun:1 as builder
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

FROM oven/bun:1-slim as runtime
WORKDIR /app

USER root
RUN mkdir -p /home/bun

ENV SHELL=/bin/bash \
    PORT=3000 \
    FORGE_PROJECT_DIR=/app/foundry

COPY --from=builder --chown=bun:bun /home/bun/.foundry /home/bun/.foundry
COPY --from=builder --chown=bun:bun /app /app

USER bun

EXPOSE 3000
CMD ["bun", "run", "index.ts"]

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Foundry Tracer API is a Bun + Hono service that wraps `forge test -vvvv` and provides ANSI-colored trace output. It features an async queue-based API (`/api/queue`) where trace requests return immediately with 202 Accepted and results are POSTed to a callback URL. The service uses a single-flight queue to prevent concurrent Forge runs from conflicting, and implements two-way API key authentication for secure communication.

## Commands

```bash
# Install dependencies
bun install

# Run the server (with hot reload)
bun --hot index.ts

# Run without hot reload
bun run index.ts

# Build and run Docker image
docker build -t foundry-tracer-api .
docker run --rm -p 3000:3000 foundry-tracer-api
```

## Architecture

The codebase is structured around async trace processing with callback-based delivery.

### Core Files

- **`index.ts`** - Hono HTTP server with four endpoints:
  - `GET /` - Liveness probe
  - `GET /api/health` - Health check returning `{ status: "ok" }`
  - `POST /api/run-tests` - (Legacy) Synchronous trace execution, returns `{ success, exitCode, stdout, stderr }`
  - `POST /api/queue` - (Recommended) Async trace queue, returns 202 immediately, posts results to callback URL

- **`types.ts`** - TypeScript interfaces for the API:
  - `TraceRequest` - Request payload for `/api/queue`
  - `TraceCallbackPayload` - Callback payload sent to dapp
  - `EVMTransaction` - Full EVM transaction representation (Types 0-4)
  - `BlockEnv` - Block environment context for simulation
  - `TransactionData` - Simplified transaction data for tracing

- **`auth.ts`** - Authentication middleware:
  - `authMiddleware` - Hono middleware for X-API-Key validation
  - `validateApiKey()` - Constant-time key comparison (timing attack prevention)
  - `parseApiKeys()` - Parse comma-separated DAPP_API_KEYS

- **`foundry/`** - Forge project directory containing Solidity test contracts
  - `test/InvalidatingTrace.t.sol` - Main test contract that reads env vars and executes traced calls

- **`run-tests.html`** - Demo UI for triggering tests with form inputs for env overrides

### Key Patterns

- **Async queue with callbacks**: `/api/queue` returns 202 immediately; `processTrace()` runs the forge test and calls `sendCallback()` with results
- **Single-flight queue**: All trace requests are serialized through `forgeRunQueue` promise chain to prevent concurrent Forge executions
- **Two-way authentication**:
  - Incoming: `authMiddleware` validates `X-API-Key` against `DAPP_API_KEYS`
  - Outgoing: `sendCallback()` includes `X-API-Key` header with `TRACER_CALLBACK_API_KEY`
- **Environment forwarding**: Transaction data, block env, and previous transactions are passed as env vars to Forge
- **ANSI preservation**: Forge runs with `--color always` and the server sets `FORCE_COLOR=1` to maintain colorized output

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP server port |
| `FORGE_PROJECT_DIR` | `./foundry` | Directory passed to `forge test` |
| `FORGE_BIN` | auto-resolved | Path to forge binary if not in PATH |
| `DAPP_API_KEYS` | - | Comma-separated valid API keys for `/api/queue` authentication |
| `TRACER_CALLBACK_API_KEY` | - | API key sent with callback requests for dapp to verify |

## Security Notes

- **API Key Authentication**: The `/api/queue` endpoint requires a valid API key in the `X-API-Key` header. Keys are validated using constant-time comparison to prevent timing attacks.
- **Callback Verification**: When sending results to callback URLs, the service includes `TRACER_CALLBACK_API_KEY` in the `X-API-Key` header so the receiving dapp can verify authenticity.
- **No Secrets in Logs**: API keys are never logged - only authentication success/failure status is recorded.
- **Environment Validation**: The server warns at startup if authentication keys are not configured.

## Bun Guidelines

Default to using Bun instead of Node.js:
- Use `bun <file>` instead of `node` or `ts-node`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install`
- Bun automatically loads `.env` files

Preferred APIs:
- `Bun.serve()` for HTTP/WebSocket servers (don't use Express)
- `Bun.spawn()` for subprocesses
- `Bun.file()` over `node:fs` readFile/writeFile

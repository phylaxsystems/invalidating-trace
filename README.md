# Foundry Tracer API

A tiny Bun + Hono service that shells out to `forge test -vvvv --color always` and streams the raw stdout/stderr back as JSON. The bundled HTML helper (`run-tests.html`) renders Forge's ANSI-colored output and can fire multiple simulated requests to demonstrate the server-side single-flight queue.

## Features

- ✅ **Single-run queue** – every `/api/run-tests` call waits for the previous Forge run to finish, so two users can't mutate the project simultaneously.
- ✅ **Forge environment overrides** – optional JSON body (`from`, `to`, `value`, `rpc`, `calldata`, `previous_tx`) is forwarded as uppercase env vars before each run.
- ✅ **Color-preserving output** – the API forces Forge to emit ANSI colors, and the demo UI renders them so traces look exactly like the terminal.
- ✅ **Docker-first** – multi-stage image installs Foundry once in a builder layer and copies only the runtime bits into `oven/bun:1-slim` (~! significantly smaller than the original 777 MB image).

## Requirements

- [Bun](https://bun.sh) v1+
- [Foundry](https://github.com/foundry-rs/foundry) with `forge` on your `PATH` (or run inside the Docker image)

## Local development

```bash
bun install
foundryup   # ensures ~/.foundry/bin/forge exists
bun run index.ts
```

The server prints which forge binary/project directory it found and starts listening on `PORT` (default `3000`).

## API reference

| Method | Path              | Description |
| ------ | ----------------- | ----------- |
| GET    | `/`               | Hello world text response (basic liveness probe). |
| GET    | `/api/health`     | `{ "status": "ok" }`. |
| POST   | `/api/run-tests`  | Runs `forge test --color always -vvvv` in `FORGE_PROJECT_DIR`. Responses look like `{ success, exitCode, stdout, stderr }`. Non-zero exit codes return HTTP 500. |

### POST `/api/run-tests` request body

Every field is optional – unset values are ignored.

| JSON key     | Forwarded env var | Purpose |
| ------------ | ----------------- | ------- |
| `from`       | `FROM`            | Sender address for the traced call. |
| `to`         | `TO`              | Contract to call. |
| `value`      | `VALUE`           | Call value (wei/ether/etc). |
| `rpc`        | `RPC`             | RPC URL (used by the forge tests). |
| `calldata`   | `CALLDATA`        | Hex calldata forwarded to the test harness. |
| `previous_tx`| `PREVIOUS_TX`     | Optional identifier to chain traces together. |

Example request that reuses any matching shell env vars:

```bash
curl -sS -X POST http://localhost:3000/api/run-tests \
  -H 'Content-Type: application/json' \
  -d "$(jq -n \
        --arg from "${FROM:-}" \
        --arg to "${TO:-}" \
        --arg value "${VALUE:-}" \
        --arg rpc "${RPC:-}" \
        --arg calldata "${CALLDATA:-}" \
        --arg previous_tx "${PREVIOUS_TX:-}" \
        '$ARGS.named | with_entries(select(.value != ""))')"
```

### Responses

- `success`: boolean convenience flag (`exitCode === 0`).
- `exitCode`: Forge's exit status.
- `stdout` / `stderr`: raw output strings (with ANSI escapes preserved).

Because the server serializes runs, concurrent callers will see one request block until the previous finishes.

## Demo UI (`run-tests.html`)

Open the file directly in a browser or serve it with any static file server. When opened from the filesystem it automatically points at `http://localhost:3000`; when served from the Bun API origin it reuses the current host. Features:

- Manual Run button that mirrors the curl call.
- Optional form inputs for all supported env overrides.
- Burst simulator that fires N requests simultaneously so you can watch the queue in action – result cards show pass/fail, duration, and a colorized stdout snippet.

## Docker image

The repository ships with a multi-stage Dockerfile:

```bash
docker build -t foundry-tracer-api .
docker run --rm -p 3000:3000 foundry-tracer-api
```

- `builder` stage (`oven/bun:1`) installs apt utilities, Foundry, and Bun dependencies.
- `runtime` stage (`oven/bun:1-slim`) copies `/app` and `/home/bun/.foundry`, sets ownership to the `bun` user, and exposes port 3000.

This keeps the final image lean while still bundling Foundry so the container works out of the box.

## Configuration

Environment variables you may care about:

| Variable            | Default                              | Notes |
| ------------------- | ------------------------------------ | ----- |
| `PORT`              | `3000`                               | HTTP port for Bun. |
| `FORGE_PROJECT_DIR` | `<repo>/foundry` (or `/app/foundry`) | Directory passed to `forge test`. |
| `FORGE_BIN`         | auto-resolved                        | Hard-set if `forge` lives elsewhere. |
| `FOUNDRY_HOME`      | `$HOME` or `/tmp/foundry`            | Used when building Foundry env vars. |

The server also injects `FORCE_COLOR=1`, `CLICOLOR=1`, and `CLICOLOR_FORCE=1` to keep colored logs when piping through Bun.

## Tips

- Use `bun run index.ts` locally, then hit `run-tests.html` for a nicer visualization.
- The queue is simple but effective: every request is awaiting the previous run promise. If you ever need parallelism, remove or expand it deliberately.
- `curl -N` or tools like `grc` aren't required – the response already carries ANSI escapes for rich rendering on the client side.

Happy tracing!

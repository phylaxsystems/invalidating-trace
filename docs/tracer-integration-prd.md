# Tracer Service Integration PRD

> **Decisions Made**:
>
> - **Storage**: None - fully stateless
> - **Queue**: Reuse existing promise-chain serialization
> - **Correlation**: Dapp embeds `debug_trace_id` in callback URL query param - tracer just POSTs to the URL
> - **Data**: Dapp passes ALL execution context - tracer fetches nothing

## Overview

This document outlines the minimal work required to make the tracer service (`/Users/jacobdcastro/ph/tracer`) compatible with the Credible Layer dapp's fire-and-forget background job system.

## Design Philosophy

**The tracer is a "dumb pipe"** - it receives everything it needs to run a trace and calls back with results. No configuration, no chain awareness, no state, no data fetching.

---

## Current State

### Tracer Service (As-Is)

- **Architecture**: Minimal Hono API wrapping Foundry's `forge test`
- **Endpoint**: `POST /api/run-tests` - blocks until test completes
- **Queue**: Promise-chain serialization (prevents concurrent runs)
- **Storage**: None - stateless service

### Key Insight: Existing Queue Mechanism

```typescript
let forgeRunQueue: Promise<void> = Promise.resolve();

function enqueueForgeTestRun(forgeEnv: Record<string, string>) {
  const run = forgeRunQueue.then(() => runForgeTests(forgeEnv));
  forgeRunQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
```

**We reuse this directly** - no new queue infrastructure needed. The `forgeEnv` parameter contains request-specific trace parameters passed to the forge subprocess.

### Key Insight: URL-Based Correlation

The dapp embeds `debug_trace_id` in the callback URL as a query parameter:

```
callback_url: "https://{DAPP_BASE_URL}/api/v1/tracer/events?debug_trace_id=abc-123"
```

The tracer just POSTs results to whatever URL it was given - it never sees or handles `debug_trace_id`. This is the true "dumb pipe" pattern. **Zero state needed, zero coupling to dapp's data model.**

---

## API Contract

### POST /api/queue

The dapp sends **everything** the tracer needs. The tracer fetches nothing.

```typescript
{
  // Required fields
  rpc_url: string,                    // e.g., "https://rpc.sepolia.linea.build"
  callback_url: string,               // e.g., "https://...?debug_trace_id=abc-123"

  // Chain and transaction identification
  chain_id: number,                   // Chain ID for logging/context
  transaction_hash: string,           // 0x + 64 hex (at root level, not in transaction)

  // Transaction data for replay
  transaction: {
    from: string,                     // Ethereum address
    to: string,                       // Ethereum address (empty for contract creation)
    value: string,                    // Wei as decimal or hex string
    data: string,                     // Calldata (hex)
    nonce?: string,                   // Optional
    gas_limit?: string,               // Optional
    type?: number,                    // Transaction type (0-4)
  },

  // Block context
  block_number?: number,              // Block number containing the tx
  previous_block_number?: number,     // Previous block for context

  // Previous transactions in the block (for Linea multi-block simulation)
  // Each transaction is a full EVMTransaction object (Types 0-4)
  previous_transactions?: Array<{
    type: 0 | 1 | 2 | 3 | 4,          // Transaction type discriminator
    transaction_hash: string,
    chain_id: number,
    nonce: string,
    gas_limit: string,
    to_address: string,
    from_address: string,
    value: string,
    data?: string,
    // Type-specific fields (see EVMTransaction discriminated union)
    gas_price?: string,               // Types 0, 1
    max_fee_per_gas?: string,         // Types 2, 3, 4
    max_priority_fee_per_gas?: string,// Types 2, 3, 4
    max_fee_per_blob_gas?: string,    // Type 3
    blob_versioned_hashes?: string[], // Type 3
    authorization_list?: Array<{...}>,// Type 4
    access_list?: Array<{...}>,       // Types 1, 2, 3, 4
  }>,

  // Block environment context (from Revm - critical for accurate simulation)
  // When provided, all fields are required (not optional) to ensure accurate simulation
  block_env?: {
    number: string,                   // Block number
    timestamp: string,                // Unix timestamp
    beneficiary: string,              // Coinbase/miner address
    gas_limit: string,                // Block gas limit
    basefee: string,                  // EIP-1559 base fee
    difficulty: string,               // Pre-merge difficulty
    prevrandao: string | null,        // Post-merge randomness (null for pre-merge chains)
    blob_excess_gas_and_price: {      // EIP-4844 blob gas (null for non-blob chains)
      excess_blob_gas: string,
      blob_gasprice: string,
    } | null,
  },
}
```

> **Note**: `debug_trace_id` is NOT in the request body - it's embedded in the `callback_url` query parameter. The tracer is a "dumb pipe" that doesn't know about dapp correlation IDs.

**Response** (immediate):

```json
{
  "status": "queued",
  "message": "Trace job queued successfully"
}
```

### POST {callback_url} (Webhook to Dapp)

**Headers**: `X-API-Key: {TRACER_CALLBACK_API_KEY}`

**Success payload**:

```json
{
  "success": true,
  "trace_content": "... forge output with ANSI colors ...",
  "trace_format": "ansi",
  "duration_ms": 45000
}
```

**Failure payload**:

```json
{
  "success": false,
  "error": "Transaction not found",
  "error_code": "TRACE_FAILED",
  "duration_ms": 1200
}
```

**Full callback schema (all fields)**:

```typescript
{
  // Result status
  success: boolean,
  trace_content?: string,           // Present if success=true
  trace_format?: 'ansi' | 'plain' | 'json',
  error?: string,                   // Present if success=false
  error_code?: string,              // Present if success=false

  // Metadata
  duration_ms?: number,
  tracer_metadata?: Record<string, unknown>,
}
```

> **Note**: The `debug_trace_id` is NOT in the callback body - the dapp extracts it from the URL query params. The tracer doesn't know or care about correlation.

---

## Implementation

### Complete Tracer Code (~40 lines of new code)

```typescript
// Add to index.ts

interface TraceRequest {
  // Required
  rpc_url: string;
  callback_url: string;

  // Chain and transaction identification
  chain_id: number;
  transaction_hash: string;

  // Transaction data for replay
  transaction: {
    from: string;
    to: string;
    value: string;
    data: string;
    nonce?: string;
    gas_limit?: string;
    type?: number;
  };

  // Block context
  block_number?: number;
  previous_block_number?: number;
  // Full EVMTransaction objects (Types 0-4) - same structure as transaction_data
  previous_transactions?: Array<{
    type: 0 | 1 | 2 | 3 | 4;
    transaction_hash: string;
    chain_id: number;
    nonce: string;
    gas_limit: string;
    to_address: string;
    from_address: string;
    value: string;
    data?: string;
    // Type-specific fields based on transaction type
    gas_price?: string; // Types 0, 1
    max_fee_per_gas?: string; // Types 2, 3, 4
    max_priority_fee_per_gas?: string; // Types 2, 3, 4
    max_fee_per_blob_gas?: string; // Type 3
    blob_versioned_hashes?: string[]; // Type 3
    authorization_list?: AuthorizationTuple[]; // Type 4
    access_list?: AccessListEntry[]; // Types 1, 2, 3, 4
  }>;
  // When provided, all fields are required to ensure accurate simulation
  block_env?: {
    number: string;
    timestamp: string;
    beneficiary: string;
    gas_limit: string;
    basefee: string;
    difficulty: string;
    prevrandao: string | null; // null for pre-merge chains
    blob_excess_gas_and_price: {
      // null for non-blob chains
      excess_blob_gas: string;
      blob_gasprice: string;
    } | null;
  };
}

app.post("/api/queue", async (c) => {
  const request: TraceRequest = await c.req.json();

  if (
    !request.rpc_url ||
    !request.transaction ||
    !request.callback_url ||
    !request.transaction_hash
  ) {
    return c.json(
      {
        error:
          "Missing required fields: rpc_url, transaction, transaction_hash, callback_url",
      },
      400,
    );
  }

  // Fire-and-forget
  processTrace(request);

  return c.json(
    { status: "queued", message: "Trace job queued successfully" },
    202,
  );
});

async function processTrace(request: TraceRequest) {
  const startTime = Date.now();

  try {
    // Build forge environment from request data
    // NOTE: These are REQUIRED values from the request, not optional overrides.
    // Each trace has unique transaction data - there are no defaults to override.
    const forgeEnv: Record<string, string> = {
      FROM: request.transaction.from,
      TO: request.transaction.to || "",
      VALUE: request.transaction.value,
      CALLDATA: request.transaction.data || "",
      RPC: request.rpc_url,
      PREVIOUS_TX: request.transaction_hash, // transaction_hash is at root level
    };

    // Add optional transaction fields
    if (request.transaction.nonce) {
      forgeEnv.NONCE = request.transaction.nonce;
    }
    if (request.transaction.gas_limit) {
      forgeEnv.GAS_LIMIT = request.transaction.gas_limit;
    }

    // Add previous transactions if provided (for multi-block sim)
    // NOTE: Field names must match Solidity struct for vm.parseJson to work
    // Previous transactions are full EVMTransaction objects (Types 0-4)
    if (request.previous_transactions?.length) {
      const prevTxsForSolidity = request.previous_transactions.map((tx) => ({
        // Common fields from BaseTransaction
        txType: tx.type,
        txHash: tx.transaction_hash,
        txChainId: tx.chain_id,
        txNonce: tx.nonce,
        txGasLimit: tx.gas_limit,
        txFrom: tx.from_address,
        txTo: tx.to_address || "",
        txValue: tx.value,
        txData: tx.data || "0x",
        // Type-specific fields (Solidity will use based on txType)
        txGasPrice: tx.gas_price || "0",
        txMaxFeePerGas: tx.max_fee_per_gas || "0",
        txMaxPriorityFeePerGas: tx.max_priority_fee_per_gas || "0",
        txMaxFeePerBlobGas: tx.max_fee_per_blob_gas || "0",
        txBlobVersionedHashes: tx.blob_versioned_hashes || [],
        txAccessList: tx.access_list || [],
        txAuthorizationList: tx.authorization_list || [],
      }));
      forgeEnv.PREVIOUS_TXS = JSON.stringify(prevTxsForSolidity);
    }

    // Add block environment if provided (all fields are required when block_env is present)
    if (request.block_env) {
      forgeEnv.BLOCK_NUMBER = request.block_env.number;
      forgeEnv.BLOCK_TIMESTAMP = request.block_env.timestamp;
      forgeEnv.BLOCK_COINBASE = request.block_env.beneficiary;
      forgeEnv.BLOCK_BASEFEE = request.block_env.basefee;
      forgeEnv.BLOCK_GAS_LIMIT = request.block_env.gas_limit;
      forgeEnv.BLOCK_DIFFICULTY = request.block_env.difficulty;
      // prevrandao may be null for pre-merge chains
      if (request.block_env.prevrandao !== null) {
        forgeEnv.BLOCK_PREVRANDAO = request.block_env.prevrandao;
      }
      // blob gas fields may be null for non-blob chains
      if (request.block_env.blob_excess_gas_and_price !== null) {
        forgeEnv.BLOB_EXCESS_GAS =
          request.block_env.blob_excess_gas_and_price.excess_blob_gas;
        forgeEnv.BLOB_GASPRICE =
          request.block_env.blob_excess_gas_and_price.blob_gasprice;
      }
    }

    // Use existing queue - handles serialization!
    const result = await enqueueForgeTestRun(forgeEnv);

    // Just POST to the callback URL - correlation is embedded in the URL itself
    await sendCallback(request.callback_url, {
      success: true,
      trace_content: result.stdout,
      trace_format: "ansi",
      duration_ms: Date.now() - startTime,
    });
  } catch (error) {
    await sendCallback(request.callback_url, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      error_code: "TRACE_FAILED",
      duration_ms: Date.now() - startTime,
    });
  }
}

async function sendCallback(url: string, payload: object) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": process.env.TRACER_CALLBACK_API_KEY || "",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      console.error(`Callback failed: ${response.status}`);
    }
  } catch (e) {
    console.error("Callback error:", e);
  }
}
```

**That's it.** The tracer:

1. Receives complete execution context
2. Runs forge with env vars
3. POSTs result to callback URL

No viem dependency. No chain config. No data fetching. Fully stateless.

---

## Environment Variables

```bash
# ================== TRACER SERVICE ==================
# Existing
PORT=3000
FORGE_PROJECT_DIR=/app/foundry

# Authentication keys
TRACER_CALLBACK_API_KEY=trc_[64-hex-chars]  # Key tracer sends TO dapp (must match dapp's TRACER_API_KEY_*)
DAPP_API_KEYS=trc_[64-hex-chars]             # Key(s) tracer accepts FROM dapp

# ================== DAPP SERVICE ==================
# Tracer service connection
TRACER_SERVICE_URL=https://tracer.example.com  # Base URL for tracer service
TRACER_SERVICE_API_KEY=trc_[64-hex-chars]      # Key dapp sends TO tracer

# Tracer callback authentication (accepts callbacks from tracer)
# Format: trc_[64-hex-chars]:[identifier]:[description]
TRACER_API_KEY_1=trc_abc123...:tracer-prod:Production tracer callback key
TRACER_API_KEY_2=trc_def456...:tracer-staging:Staging tracer callback key
```

---

## Authentication

The tracer integration uses **bidirectional API key authentication** to secure communication between the dapp and tracer services. Both directions require authentication to prevent unauthorized access and spoofed requests.

### Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Authentication Flow                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────┐     POST /api/queue           ┌─────────┐                       │
│  │  Dapp  │ ─────────────────────────────▶│ Tracer  │                       │
│  │        │  X-API-Key: TRACER_SERVICE_   │         │                       │
│  │        │            API_KEY            │         │                       │
│  └────────┘                               └─────────┘                       │
│      ▲                                         │                            │
│      │                                         │                            │
│      │  POST callback_url                      │                            │
│      │  X-API-Key: TRACER_CALLBACK_API_KEY     │                            │
│      └─────────────────────────────────────────┘                            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1. Dapp to Tracer Authentication

When the dapp submits trace requests to the tracer's `POST /api/queue` endpoint:

**Header**: `X-API-Key: {TRACER_SERVICE_API_KEY}`

**Environment Variables**:
| Variable | Location | Description |
|----------|----------|-------------|
| `TRACER_SERVICE_API_KEY` | Dapp | API key that dapp sends to tracer |
| `DAPP_API_KEYS` | Tracer | Comma-separated list of valid keys tracer accepts |

**Purpose**:

- Prevent unauthorized queue submissions
- DOS protection - only authenticated clients can queue trace jobs
- Rate limiting can be applied per API key

**Example Request**:

```typescript
const response = await fetch(`${TRACER_SERVICE_URL}/api/queue`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-API-Key": process.env.TRACER_SERVICE_API_KEY,
  },
  body: JSON.stringify(tracerPayload),
});
```

**Tracer Validation**:

```typescript
app.post("/api/queue", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  const validKeys = (process.env.DAPP_API_KEYS || "").split(",");

  if (!apiKey || !validKeys.includes(apiKey)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Process request...
});
```

### 2. Tracer to Dapp Authentication

When the tracer calls back to the dapp's `POST /api/v1/tracer/events` endpoint:

**Header**: `X-API-Key: {TRACER_CALLBACK_API_KEY}`

**Environment Variables**:
| Variable | Location | Description |
|----------|----------|-------------|
| `TRACER_CALLBACK_API_KEY` | Tracer | API key that tracer sends to dapp |
| `TRACER_API_KEY_*` | Dapp | Pattern-matched keys dapp accepts (e.g., `TRACER_API_KEY_1`, `TRACER_API_KEY_2`) |

**Purpose**:

- Prevent spoofed callbacks from malicious actors
- Ensure only the authorized tracer service can report trace results
- Enables audit trail for which tracer instance reported results

**Key Format**: `trc_[64-hex-chars]:[identifier]:[description]`

- `trc_` prefix identifies tracer-related keys
- 64 hex characters provide cryptographic randomness
- Identifier and description aid in key management and rotation

**Example Callback**:

```typescript
async function sendCallback(url: string, payload: object) {
  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": process.env.TRACER_CALLBACK_API_KEY || "",
    },
    body: JSON.stringify(payload),
  });
}
```

**Dapp Validation**:

```typescript
// In /api/v1/tracer/events route handler
const apiKey = req.headers.get("X-API-Key");

// Load all TRACER_API_KEY_* environment variables
const validKeys = Object.entries(process.env)
  .filter(([key]) => key.startsWith("TRACER_API_KEY_"))
  .map(([, value]) => value?.split(":")[0]); // Extract key portion before identifier

if (!apiKey || !validKeys.includes(apiKey)) {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
```

### 3. Key Format and Validation

**Key Format**: Both directions use the same key format for consistency.

```
trc_[64-hex-chars]:[identifier]:[description]
 │        │              │            │
 │        │              │            └── Human-readable description
 │        │              └── Unique identifier (e.g., "tracer-prod", "staging")
 │        └── 64 cryptographically random hex characters
 └── Prefix identifying tracer-related keys
```

**Generating Keys**:

```bash
# Generate a cryptographically random 64-char hex key
openssl rand -hex 32

# Example output: 7f3a8b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a

# Format for environment variable:
# TRACER_API_KEY_1=trc_7f3a8b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a:tracer-prod:Production tracer
```

**Validation Best Practices**:

- Use constant-time comparison to prevent timing attacks
- Log authentication failures for security monitoring
- Implement rate limiting per API key
- Rotate keys periodically

### 4. Environment Variable Summary

```bash
# ============================================================
#                    DAPP SERVICE
# ============================================================

# Tracer service connection (for submitting trace requests)
TRACER_SERVICE_URL=https://tracer.example.com
TRACER_SERVICE_API_KEY=trc_[64-hex]  # Key dapp sends TO tracer

# Tracer callback authentication (for receiving trace results)
# Multiple keys supported for key rotation and multiple tracer instances
TRACER_API_KEY_1=trc_[64-hex]:tracer-prod:Production tracer
TRACER_API_KEY_2=trc_[64-hex]:tracer-staging:Staging tracer

# ============================================================
#                    TRACER SERVICE
# ============================================================

# Callback authentication (for sending trace results to dapp)
TRACER_CALLBACK_API_KEY=trc_[64-hex]  # Must match one of dapp's TRACER_API_KEY_* values

# Queue submission authentication (for accepting requests from dapp)
DAPP_API_KEYS=trc_[64-hex]  # Must match dapp's TRACER_SERVICE_API_KEY
# Multiple keys can be comma-separated: DAPP_API_KEYS=key1,key2,key3
```

**Key Matching Requirements**:

- `TRACER_SERVICE_API_KEY` (dapp) must be in `DAPP_API_KEYS` (tracer)
- `TRACER_CALLBACK_API_KEY` (tracer) must match one of `TRACER_API_KEY_*` (dapp)

### 5. Security Considerations

1. **Never commit API keys** - Use environment variables or secrets management
2. **Use HTTPS** - All communication must be over TLS
3. **Key rotation** - Support multiple keys to enable rotation without downtime
4. **Logging** - Log authentication attempts (success/failure) without logging the actual keys
5. **Rate limiting** - Implement per-key rate limits to prevent abuse
6. **IP allowlisting** (optional) - For additional security, restrict tracer callbacks to known IPs

---

## Dependencies

**None new!** We removed the need for `viem` since we're not fetching transaction data.

---

## What We're NOT Building

| Removed                   | Reason                      |
| ------------------------- | --------------------------- |
| Transaction data fetching | Dapp provides complete data |
| viem dependency           | Not needed                  |
| Chain ID / RPC config     | Dapp provides RPC URL       |
| Any env vars for RPCs     | Not needed                  |
| State / job tracking      | Fully stateless             |

---

## Dapp Changes Required

### 1. Update tracer-request Inngest function

Build the complete payload from the `invalidating_transactions` record:

```typescript
// In tracer-request inngest function
import { getRpcUrl } from "@phylax-systems/config/chains";

// Embed debug_trace_id in the callback URL - tracer never sees it
const callbackUrl = `${API_BASE_URL}/api/v1/tracer/events?debug_trace_id=${debug_trace_id}`;

// Build tracer submission payload with full execution context
// Note: debug_trace_id is NOT in the body - it's embedded in the callback URL query param
const tracerPayload = {
  callback_url: callbackUrl,
  rpc_url: getRpcUrl(chain_id), // Dapp knows the RPC via chain profile config
  chain_id,
  transaction_hash: txData?.transaction_hash, // At root level, not in transaction
  transaction: txData
    ? {
        from: txData.from_address,
        to: txData.to_address,
        value: txData.value,
        data: txData.calldata,
        gas_limit: txData.gas_limit,
        nonce: txData.nonce,
        type: txData.transaction_type,
      }
    : undefined,
  block_number: txData?.block_number,
  previous_block_number: txData?.previous_block_number,
  previous_transactions: txData?.previous_transactions, // From JSONB column
  block_env: txData?.block_env, // Block environment from Revm
};
```

### 2. Webhook handler

Extract `debug_trace_id` from URL query params:

```typescript
// In /api/v1/tracer/events route
const url = new URL(req.url);
const debug_trace_id = url.searchParams.get("debug_trace_id");
```

---

## Data Flow

```
┌─────────────┐     POST /enforcer/incidents      ┌─────────┐
│  Enforcer   │ ─────────────────────────────────▶│  Dapp   │
│             │   { transaction_data, block_env,  │  API    │
│             │     previous_transactions, ... }  │         │
└─────────────┘                                   └────┬────┘
                                                       │
                                                       ▼
                                              ┌────────────────┐
                                              │    Inngest     │
                                              │ process-incident│
                                              └────────┬───────┘
                                                       │
                                                       ▼
                                              ┌────────────────┐
                                              │    Inngest     │
                                              │ tracer-request │
                                              └────────┬───────┘
                                                       │
                    POST /api/queue                    │
     { rpc_url, transaction, block_env,                │
       previous_transactions,                          │
       callback_url: "...?debug_trace_id=X" }          ▼
                                              ┌────────────────┐
                                              │    Tracer      │
                                              │    Service     │
                                              └────────┬───────┘
                                                       │
                                                       │ (runs forge test)
                                                       │
                    POST callback_url                  │
     (URL contains ?debug_trace_id=X)                  │
     { success, trace_content, duration_ms }           ▼
                                              ┌────────────────┐
                                              │  Dapp Webhook  │
                                              │ /tracer/events │
                                              │ (extracts ID   │
                                              │  from URL)     │
                                              └────────────────┘
```

---

## Testing

```bash
# Submit trace request with complete data
# Note: debug_trace_id is in the callback URL, NOT in the body
# Note: X-API-Key header is required for authentication (see Authentication section)
curl -X POST http://localhost:3000/api/queue \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: trc_your_tracer_service_api_key_here' \
  -d '{
    "rpc_url": "https://rpc.sepolia.linea.build",
    "callback_url": "http://localhost:3001/api/v1/tracer/events?debug_trace_id=550e8400-e29b-41d4-a716-446655440000",
    "chain_id": 59141,
    "transaction_hash": "0x123...",
    "transaction": {
      "from": "0xabc...",
      "to": "0xdef...",
      "value": "0",
      "data": "0x..."
    },
    "block_number": 12345678,
    "previous_transactions": [
      { "from": "0x...", "to": "0x...", "value": "0" }
    ],
    "block_env": {
      "number": "12345678",
      "timestamp": "1704672000"
    }
  }'

# Expected: 202 { "status": "queued" }
# If X-API-Key is missing or invalid: 401 { "error": "Unauthorized" }

# Tracer will POST to callback_url with:
# Headers: X-API-Key: {TRACER_CALLBACK_API_KEY}
# Body: { "success": true, "trace_content": "...", "duration_ms": 45000 }
# Dapp extracts debug_trace_id from the URL query param
```

---

## Estimated Effort

| Task                   | Lines of Code | Time   |
| ---------------------- | ------------- | ------ |
| Queue endpoint + types | ~20           | 20 min |
| Process function       | ~40           | 30 min |
| Callback function      | ~15           | 10 min |
| Testing                | -             | 1 hr   |

**Total: ~75 lines of new code, 2 hours of work**

---

## Files to Modify

### Tracer

| File       | Action | Purpose                                        |
| ---------- | ------ | ---------------------------------------------- |
| `index.ts` | Modify | Add queue endpoint, process function, callback |

**One file. No new dependencies.**

### Dapp

| File                | Action | Purpose                                      |
| ------------------- | ------ | -------------------------------------------- |
| `tracer-request.ts` | Modify | Build payload, embed debug_trace_id in URL   |
| Tracer events route | Modify | Extract debug_trace_id from URL query params |

---

## Forge Environment Variables (Trace Parameters)

The tracer passes request data to forge via environment variables. These are **not overrides** - they are required inputs provided fresh by each trace request. The forge Solidity tests read these using `vm.envString()`, `vm.envUint()`, etc.

| Env Var            | Source                                              | Purpose                                      |
| ------------------ | --------------------------------------------------- | -------------------------------------------- |
| `FROM`             | transaction.from                                    | Sender address                               |
| `TO`               | transaction.to                                      | Target contract                              |
| `VALUE`            | transaction.value                                   | Call value (wei)                             |
| `CALLDATA`         | transaction.data                                    | Transaction input data                       |
| `RPC`              | rpc_url                                             | Fork RPC endpoint                            |
| `PREVIOUS_TX`      | transaction_hash                                    | Transaction being traced (at root level)     |
| `NONCE`            | transaction.nonce                                   | Optional nonce                               |
| `GAS_LIMIT`        | transaction.gas_limit                               | Optional gas limit                           |
| `PREVIOUS_TXS`     | previous_transactions                               | JSON array for multi-block sim               |
| `BLOCK_NUMBER`     | block_env.number                                    | Fork block number                            |
| `BLOCK_TIMESTAMP`  | block_env.timestamp                                 | Block timestamp                              |
| `BLOCK_COINBASE`   | block_env.beneficiary                               | Miner/validator address                      |
| `BLOCK_BASEFEE`    | block_env.basefee                                   | EIP-1559 base fee                            |
| `BLOCK_GAS_LIMIT`  | block_env.gas_limit                                 | Block gas limit                              |
| `BLOCK_DIFFICULTY` | block_env.difficulty                                | Pre-merge difficulty                         |
| `BLOCK_PREVRANDAO` | block_env.prevrandao                                | Post-merge randomness (null for pre-merge)   |
| `BLOB_EXCESS_GAS`  | block_env.blob_excess_gas_and_price.excess_blob_gas | EIP-4844 excess blob gas (null for non-blob) |
| `BLOB_GASPRICE`    | block_env.blob_excess_gas_and_price.blob_gasprice   | EIP-4844 blob gas price (null for non-blob)  |

---

## Solidity Test Changes Required

The existing `InvalidatingTrace.t.sol` needs updates to handle the `PREVIOUS_TXS` array.

### Current Issue

The current test only handles a single transaction:

```solidity
vm.createSelectFork(rpc, previous_tx);
vm.transact(previous_tx);  // ❌ Applies invalidating tx BEFORE tracing
```

This is incorrect - `vm.transact(previous_tx)` applies the invalidating transaction before we trace it, so the traced execution is actually the SECOND run.

### Required Changes

1. **Remove** `vm.transact(previous_tx)` - we don't want to pre-apply the invalidating tx
2. **Add** `_applyPreviousTransactions()` - apply all prior txs from `PREVIOUS_TXS` array
3. **Add** `PrevTx` struct - for JSON parsing with `vm.parseJson`

### Updated InvalidatingTrace.t.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

contract InvalidatingTrace is Test {
    string rpc;
    address from;
    address to;
    bytes data;
    bytes32 invalidating_tx_hash;
    uint256 value;

    function setUp() public {
        rpc = vm.envString("RPC");
        invalidating_tx_hash = vm.envBytes32("PREVIOUS_TX");
        data = vm.envBytes("CALLDATA");
        from = vm.envAddress("FROM");
        to = vm.envAddress("TO");
        value = vm.envUint("VALUE");

        vm.label(from, "invalidating_from");
        vm.label(to, "invalidating_to");

        // Fork at the block containing the invalidating tx (state BEFORE any txs)
        vm.createSelectFork(rpc, invalidating_tx_hash);

        // REMOVED: vm.transact(previous_tx) - don't apply invalidating tx before tracing

        // Apply previous transactions in order (if any)
        _applyPreviousTransactions();

        vm.startPrank(from, from);
    }

    function _applyPreviousTransactions() internal {
        string memory prevTxsJson = vm.envOr("PREVIOUS_TXS", string("[]"));

        // Skip if empty array
        if (bytes(prevTxsJson).length <= 2) return;

        bytes memory parsed = vm.parseJson(prevTxsJson);
        PrevTx[] memory prevTxs = abi.decode(parsed, (PrevTx[]));

        for (uint256 i = 0; i < prevTxs.length; i++) {
            vm.prank(prevTxs[i].txFrom);
            (bool success,) = prevTxs[i].txTo.call{value: prevTxs[i].txValue}(prevTxs[i].txData);
            require(success, "Previous transaction failed");
        }
    }

    function testTracing() public {
        // First execution of invalidating tx - this is what we trace
        (bool success, bytes memory result) = address(to).call{value: value}(data);
        require(success);
    }
}

// Struct field names MUST match JSON keys from TypeScript
// Full EVMTransaction structure to support all 5 transaction types (0-4)
struct PrevTx {
    // Transaction type discriminator (0=Legacy, 1=EIP-2930, 2=EIP-1559, 3=EIP-4844, 4=EIP-7702)
    uint8 txType;
    // Common fields from BaseTransaction
    bytes32 txHash;
    uint256 txChainId;
    uint256 txNonce;
    uint256 txGasLimit;
    address txFrom;
    address txTo;
    uint256 txValue;
    bytes txData;
    // Type-specific fields (use based on txType)
    uint256 txGasPrice;               // Types 0, 1
    uint256 txMaxFeePerGas;           // Types 2, 3, 4
    uint256 txMaxPriorityFeePerGas;   // Types 2, 3, 4
    uint256 txMaxFeePerBlobGas;       // Type 3
    bytes32[] txBlobVersionedHashes;  // Type 3
    AccessListEntry[] txAccessList;   // Types 1, 2, 3, 4
    AuthorizationTuple[] txAuthorizationList; // Type 4
}

struct AccessListEntry {
    address addr;
    bytes32[] storageKeys;
}

struct AuthorizationTuple {
    uint256 chainId;
    address addr;
    uint256 nonce;
    uint8 v;
    bytes32 r;
    bytes32 s;
}
```

### Execution Flow

1. Fork at block containing invalidating tx (state BEFORE it)
2. Apply all `PREVIOUS_TXS` transactions in order
3. `testTracing()` executes the invalidating tx (FIRST execution = traced)

# Opcode-Level Tracing Implementation Plan

## Summary

Add opt-in opcode-level tracing to the Foundry Tracer API using **Anvil + `debug_traceTransaction`**. The current `forge test -vvvv` call traces remain the default; opcode traces are enabled via `trace_type: "opcode"` request parameter.

## Architecture

### Approach: Anvil-Based Tracing

For opcode traces, we'll:
1. Start an ephemeral Anvil instance per request with `--steps-tracing` flag
2. Fork at `fork_block_number` and apply block environment via Anvil RPC methods
3. Replay previous transactions, then execute the target transaction
4. Call `debug_traceTransaction` to get `structLogs` with every opcode
5. Format output with ANSI color codes
6. Kill Anvil process

### Why Anvil vs Forge Debugger

- `forge test --debug` is interactive-only, cannot output to stdout/file
- `debug_traceTransaction` returns machine-readable JSON `structLogs` with pc, op, gas, stack, memory, storage
- Anvil supports full forked execution with state setup

### Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Anvil lifecycle | Ephemeral per request | Isolation, no state bleed, consistent with forge pattern |
| Block env application | Anvil RPC cheatcodes | `evm_setNextBlockTimestamp`, `anvil_setNextBlockBaseFeePerGas`, `anvil_setCoinbase` |
| Output format | JSON structLogs + ANSI coloring | Raw-like but colored for terminal readability |
| Request param | `trace_type: "opcode"` | Clear opt-in, "call" remains default |
| Queue handling | Same queue as call traces | Prevents resource contention |

## Files to Create

### 1. `anvil.ts` - Anvil Process Management

```typescript
// Key functions:
export async function startAnvil(config: AnvilConfig): Promise<AnvilInstance>
export async function getAvailablePort(): Promise<number>
export async function applyBlockEnvironment(rpcUrl: string, blockEnv: BlockEnv): Promise<void>
export async function sendTransaction(rpcUrl: string, tx: TransactionData): Promise<string>
export async function debugTraceTransaction(rpcUrl: string, txHash: string): Promise<DebugTraceResult>
```

- Start Anvil with `--fork-url`, `--fork-block-number`, `--steps-tracing`, `--no-mining`
- Wait for ready via `eth_chainId` polling
- Use `anvil_impersonateAccount` to send transactions as any address
- Mine blocks with `evm_mine` after each transaction

### 2. `opcode-trace.ts` - Trace Formatting

```typescript
// Key functions:
export function formatStructLog(log: StructLog, options: FormatOptions): string
export function formatOpcodeTrace(trace: OpcodeTrace, options: FormatOptions): string
```

**Color scheme:**
- `CALL/DELEGATECALL/STATICCALL`: Cyan
- `SLOAD/SSTORE`: Yellow
- `JUMP/JUMPI`: Magenta
- `REVERT/INVALID`: Red
- `RETURN/STOP`: Green
- Gas costs: Dim

**Output detail:** Opcodes + storage only (no stack/memory) - keeps output size manageable while showing the most useful debugging info.

**Default view:** Filter to significant opcodes only (CALL, SLOAD, SSTORE, LOG*, REVERT, RETURN)

## Files to Modify

### 1. `types.ts`

Add:
```typescript
export interface TraceRequest {
  // ... existing ...
  trace_type?: 'call' | 'opcode';
}

export interface TraceCallbackPayload {
  // ... existing ...
  trace_format?: 'ansi' | 'plain' | 'json' | 'opcode_ansi';
  opcode_trace?: OpcodeTrace;
}

export interface OpcodeTrace {
  gas: number;
  failed: boolean;
  returnValue: string;
  structLogs: StructLog[];
}

export interface StructLog {
  pc: number;
  op: string;
  gas: number;
  gasCost: number;
  depth: number;
  storage?: Record<string, string>;  // Only storage, no stack/memory
}
```

### 2. `index.ts`

Add:
- Import `anvil.ts` and `opcode-trace.ts`
- Route based on `request.trace_type` in `processTrace()`
- New `processOpcodeTrace()` function that:
  1. Starts ephemeral Anvil instance
  2. Applies block environment
  3. Executes previous transactions
  4. Executes target transaction
  5. Calls `debug_traceTransaction`
  6. Formats with ANSI colors
  7. Sends callback with `trace_format: "opcode_ansi"` and `opcode_trace` data
  8. Always kills Anvil in `finally` block

## Implementation Steps

### Phase 1: Anvil Management
1. Create `anvil.ts` with process lifecycle functions
2. Implement port finding (range 8546-9545)
3. Add RPC helper functions (`rpcCall`, `applyBlockEnvironment`, `sendTransaction`)
4. Add `debug_traceTransaction` caller

### Phase 2: Opcode Formatting
1. Create `opcode-trace.ts` with ANSI color constants
2. Implement `formatStructLog()` with opcode categorization
3. Implement `formatOpcodeTrace()` with header/footer and filtering

### Phase 3: Integration
1. Update `types.ts` with new interfaces
2. Add `processOpcodeTrace()` to `index.ts`
3. Add routing logic based on `trace_type`
4. Ensure queue serialization for opcode traces

### Phase 4: Testing
1. Unit tests for opcode formatting (`test/opcode-trace.test.ts`)
2. Integration tests with Anvil (`test/anvil-opcode.test.ts`)
3. E2E test for `/api/queue` with `trace_type: "opcode"`

## Verification

1. **Unit tests**: `bun test test/opcode-trace.test.ts`
2. **Integration tests**: `bun test test/anvil-opcode.test.ts` (requires local Anvil)
3. **E2E test**:
   ```bash
   # Start server
   bun run index.ts

   # Send opcode trace request
   curl -X POST http://localhost:3000/api/queue \
     -H "Content-Type: application/json" \
     -H "X-API-Key: your-key" \
     -d '{
       "rpc_url": "https://eth-mainnet.g.alchemy.com/v2/...",
       "callback_url": "http://localhost:8080/callback",
       "chain_id": 1,
       "transaction_hash": "0x...",
       "fork_block_number": 18400000,
       "transaction": { "from": "0x...", "to": "0x...", "value": "0", "data": "0x..." },
       "block_env": { ... },
       "trace_type": "opcode"
     }'
   ```
4. **Verify callback**: Check that callback includes `opcode_trace.structLogs` with ANSI-colored `trace_content`

## Potential Challenges

| Challenge | Mitigation |
|-----------|------------|
| Anvil startup time (2-5s) | Accept latency; future: warm pool |
| Port exhaustion | 1000 port range + ephemeral release |
| Large traces | Default to summary view; `full_trace` opt-in |
| Block env compatibility | Version checks, graceful fallbacks |

## Environment Variables

```bash
# Optional: Anvil binary path (auto-detected from ~/.foundry/bin/anvil)
ANVIL_BIN=/path/to/anvil
```

## References

- [Foundry Debugger Docs](https://getfoundry.sh/forge/debugger)
- [Anvil Reference](https://getfoundry.sh/anvil/reference/) - `--steps-tracing` flag for structLogs
- [debug_traceTransaction](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-debug) - Geth debug namespace
- [Tenderly Debugger](https://docs.tenderly.co/debugger) - Visual reference for opcode trace UI

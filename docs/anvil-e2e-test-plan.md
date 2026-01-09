# Anvil-Based E2E Test Plan

## Problem

Current E2E tests (`test/e2e.test.ts`) verify the HTTP/queue/callback infrastructure but don't validate actual trace output content. They use fake transaction hashes against public RPCs, which means:

1. No verification that `InvalidatingTrace.t.sol` works correctly
2. No verification that ANSI escape codes are preserved
3. No verification that traces contain meaningful function calls/events
4. Tests can pass even when forge fails (see `index.ts:452-456` - always sends `success: true`)

## Solution

Add an E2E test that uses a local Anvil instance with real transactions and verifies trace content.

## Test Design

### Prerequisites

- Anvil running locally (or CI starts it)
- Environment variable: `ANVIL_RPC_URL` (default: `http://localhost:8545`)

### Test Contract

Create `foundry/src/SimpleCounter.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract SimpleCounter {
    uint256 public count;

    event Incremented(uint256 newValue, address caller);

    function increment() external {
        count += 1;
        emit Incremented(count, msg.sender);
    }

    function getCount() external view returns (uint256) {
        return count;
    }
}
```

### Test Flow

```
1. Check ANVIL_RPC_URL is accessible
2. Deploy SimpleCounter via `cast create`
3. Send 3 increment() transactions:
   - tx1: increment() → count = 1
   - tx2: increment() → count = 2
   - tx3: increment() → count = 3  ← MAIN TX TO TRACE
4. Get tx3 details via `cast tx <hash> --json`
5. Start tracer server (or use running instance)
6. POST to /api/queue:
   {
     rpc_url: ANVIL_RPC_URL,
     callback_url: mock_server_url,
     chain_id: 31337,  // Anvil default
     transaction_hash: tx3.hash,
     transaction: {
       from: tx3.from,
       to: tx3.to,
       value: "0",
       data: tx3.input
     }
   }
7. Wait for callback
8. Assert on trace_content
```

### Assertions

```typescript
// Verify callback received
expect(callback.payload.success).toBe(true);
expect(callback.payload.trace_content).toBeDefined();

// Verify ANSI codes present (coloring preserved)
expect(callback.payload.trace_content).toMatch(/\x1b\[/);

// Verify trace contains function execution
expect(callback.payload.trace_content).toMatch(/increment|0x/i);

// Verify addresses appear
expect(callback.payload.trace_content).toContain(contractAddress.toLowerCase());

// Verify it looks like a trace (gas, calls, etc.)
expect(callback.payload.trace_content).toMatch(/call|CALL|gas/i);
```

## How `vm.createSelectFork` Works

When the tracer calls `vm.createSelectFork(rpc, transaction_hash)`:

1. Forks at the block containing the transaction
2. Replays ALL transactions in that block BEFORE the specified tx
3. State is set to "right before tx_hash executed"
4. Then `testTracing()` executes the main transaction with full tracing

This means for transactions in the same block, the fork mechanism handles "previous transactions" automatically. The `PREVIOUS_TXS` env var is for cross-block scenarios (e.g., Linea multi-block simulation).

## Implementation Notes

### Cast Commands Needed

```bash
# Deploy contract
cast create SimpleCounter --rpc-url $ANVIL_RPC_URL --private-key $ANVIL_PRIVATE_KEY

# Send transaction
cast send $CONTRACT_ADDRESS "increment()" --rpc-url $ANVIL_RPC_URL --private-key $ANVIL_PRIVATE_KEY

# Get transaction details
cast tx $TX_HASH --json --rpc-url $ANVIL_RPC_URL
```

### Anvil Default Account

```
Address: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
Private Key: 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

### File Location

`test/anvil-e2e.test.ts`

### Test Timeout

90+ seconds (forge execution can be slow)

## Bug to Fix

`index.ts:452-456` always sends `success: true` regardless of forge exit code:

```typescript
// Current (buggy):
await sendCallback(request.callback_url, {
  success: true,  // Always true!
  trace_content: result.stdout,
  ...
});

// Should be:
await sendCallback(request.callback_url, {
  success: result.exitCode === 0,
  trace_content: result.exitCode === 0 ? result.stdout : undefined,
  error: result.exitCode !== 0 ? result.stderr || result.stdout : undefined,
  ...
});
```

## Multi-Block Simulation Test (Future)

To test the `previous_transactions` feature:

1. Mine tx1 in block N
2. Mine tx2, tx3 in block N+1
3. Trace tx3 with `previous_transactions: [tx2]`
4. Verify tx2's effects are present before tx3 executes

This requires more complex Anvil manipulation (`anvil_mine`, etc.).

## References

- [Foundry createSelectFork docs](https://book.getfoundry.sh/cheatcodes/create-select-fork)
- [Foundry fork testing](https://book.getfoundry.sh/forge/fork-testing)

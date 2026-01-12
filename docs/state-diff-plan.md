# State Diff Tracking Implementation Plan

## Summary

Add state diff tracking to the Foundry Tracer API using Forge's `startStateDiffRecording` and `stopAndReturnStateDiff` cheatcodes. The state diff captures all storage changes, balance changes, and account accesses that occur during the target transaction only (not previous transactions). The raw state diff data is returned in a new `state_diff` field in the callback payload.

## Research Findings

### Forge State Diff Cheatcodes

From the [Foundry documentation](https://getfoundry.sh/reference/cheatcodes/stop-and-return-state-diff/):

**`vm.startStateDiffRecording()`** - Starts recording all state modifications during CREATE, CALL, and SELFDESTRUCT operations.

**`vm.stopAndReturnStateDiff()`** - Stops recording and returns `AccountAccess[]` containing all state changes.

### AccountAccess Struct (from [forge-std Vm.sol](https://github.com/foundry-rs/forge-std/blob/master/src/Vm.sol))

```solidity
struct AccountAccess {
    ChainInfo chainInfo;        // Fork/chain info
    AccountAccessKind kind;     // Call, DelegateCall, Create, SelfDestruct, etc.
    address account;            // Accessed account
    address accessor;           // Who accessed it
    bool initialized;           // Was account initialized before access
    uint256 oldBalance;         // Balance before
    uint256 newBalance;         // Balance after
    bytes deployedCode;         // Code if CREATE
    uint256 value;              // Value sent
    bytes data;                 // Calldata
    bool reverted;              // Whether reverted
    StorageAccess[] storageAccesses;  // Storage slot changes
    uint64 depth;               // Call depth
    uint64 oldNonce;            // Nonce before
    uint64 newNonce;            // Nonce after
}

struct StorageAccess {
    address account;            // Account whose storage changed
    bytes32 slot;               // Storage slot
    bool isWrite;               // Was it a write
    bytes32 previousValue;      // Value before
    bytes32 newValue;           // Value after
    bool reverted;              // Whether reverted
}

enum AccountAccessKind {
    Call, DelegateCall, CallCode, StaticCall,
    Create, SelfDestruct, Resume,
    Balance, Extcodesize, Extcodehash, Extcodecopy
}
```

### Key Insight

The state diff recording captures the **entire call tree** - every nested call, storage read/write, and balance change. This provides comprehensive visibility into what the transaction actually modified.

## Architecture

### Approach: Console.log JSON Serialization

1. Wrap the target transaction with state diff recording (NOT including previous transactions)
2. Serialize `AccountAccess[]` to JSON using Forge's serialization cheatcodes
3. Emit via `console.log` with recognizable markers
4. Parse from forge stdout in TypeScript
5. Include in callback payload as `state_diff` field

### Why This Approach

| Alternative | Reason Not Chosen |
|-------------|-------------------|
| FFI file write | Overly complex, requires temp file management |
| Event emission | Events aren't in stdout, would need different extraction |
| Return value | Tests return bool/void, can't return complex data |
| **Console.log + JSON** | ✓ Simple, uses existing stdout parsing, KISS |

## Files to Modify

### 1. `foundry/test/InvalidatingTrace.t.sol`

Add state diff recording around the transaction call only:

```solidity
function testTracing() public {
    // Start recording ONLY for the invalidating transaction
    vm.startStateDiffRecording();

    // Execute invalidating tx - this is what we trace
    (bool success, bytes memory result) = address(invalidatingTo).call{value: value}(data);

    // Stop recording and get state diff
    Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();

    // Serialize and emit with markers
    _emitStateDiff(accesses);

    require(success);
}

function _emitStateDiff(Vm.AccountAccess[] memory accesses) internal {
    console.log("[STATE_DIFF_START]");

    for (uint i = 0; i < accesses.length; i++) {
        Vm.AccountAccess memory acc = accesses[i];

        // Emit each access as JSON object
        string memory json = _serializeAccountAccess(acc, i);
        console.log(json);
    }

    console.log("[STATE_DIFF_END]");
}

function _serializeAccountAccess(Vm.AccountAccess memory acc, uint256 index)
    internal returns (string memory)
{
    // Use vm.serializeJson to build JSON object
    string memory obj = "access";

    vm.serializeUint(obj, "index", index);
    vm.serializeUint(obj, "kind", uint256(acc.kind));
    vm.serializeString(obj, "kind_name", _kindToString(acc.kind));
    vm.serializeAddress(obj, "account", acc.account);
    vm.serializeAddress(obj, "accessor", acc.accessor);
    vm.serializeBool(obj, "initialized", acc.initialized);
    vm.serializeUint(obj, "old_balance", acc.oldBalance);
    vm.serializeUint(obj, "new_balance", acc.newBalance);
    vm.serializeUint(obj, "value", acc.value);
    vm.serializeBytes(obj, "data", acc.data);
    vm.serializeBytes(obj, "deployed_code", acc.deployedCode);
    vm.serializeBool(obj, "reverted", acc.reverted);
    vm.serializeUint(obj, "depth", acc.depth);
    vm.serializeUint(obj, "old_nonce", acc.oldNonce);
    vm.serializeUint(obj, "new_nonce", acc.newNonce);

    // Serialize storage accesses
    string memory storageJson = _serializeStorageAccesses(acc.storageAccesses);

    // Return final JSON
    return vm.serializeString(obj, "storage_accesses", storageJson);
}

function _kindToString(Vm.AccountAccessKind kind) internal pure returns (string memory) {
    if (kind == Vm.AccountAccessKind.Call) return "Call";
    if (kind == Vm.AccountAccessKind.DelegateCall) return "DelegateCall";
    if (kind == Vm.AccountAccessKind.CallCode) return "CallCode";
    if (kind == Vm.AccountAccessKind.StaticCall) return "StaticCall";
    if (kind == Vm.AccountAccessKind.Create) return "Create";
    if (kind == Vm.AccountAccessKind.SelfDestruct) return "SelfDestruct";
    if (kind == Vm.AccountAccessKind.Resume) return "Resume";
    if (kind == Vm.AccountAccessKind.Balance) return "Balance";
    if (kind == Vm.AccountAccessKind.Extcodesize) return "Extcodesize";
    if (kind == Vm.AccountAccessKind.Extcodehash) return "Extcodehash";
    if (kind == Vm.AccountAccessKind.Extcodecopy) return "Extcodecopy";
    return "Unknown";
}

function _serializeStorageAccesses(Vm.StorageAccess[] memory storages)
    internal returns (string memory)
{
    // Build JSON array of storage accesses
    // ... serialize each storage slot change
}
```

**Note**: The exact serialization approach may need adjustment based on `vm.serializeJson` behavior with arrays. An alternative is to emit each field on separate lines with a structured format that's easy to parse.

### 2. `types.ts`

Add new interfaces:

```typescript
/** Single storage slot change */
export interface StorageChange {
  account: string;      // Address whose storage changed
  slot: string;         // Storage slot (bytes32 hex)
  is_write: boolean;    // Whether this was a write
  previous_value: string;  // Value before (bytes32 hex)
  new_value: string;    // Value after (bytes32 hex)
  reverted: boolean;    // Whether this access was reverted
}

/** Account access during transaction execution */
export interface AccountAccess {
  index: number;        // Order in execution
  kind: number;         // AccountAccessKind enum value
  kind_name: string;    // Human-readable: "Call", "DelegateCall", etc.
  account: string;      // Accessed account address
  accessor: string;     // Who accessed it
  initialized: boolean; // Was account initialized before
  old_balance: string;  // Balance before (wei)
  new_balance: string;  // Balance after (wei)
  value: string;        // Value sent (wei)
  data: string;         // Calldata (hex)
  deployed_code: string; // Deployed bytecode for CREATE ops (hex)
  reverted: boolean;    // Whether reverted
  depth: number;        // Call depth
  old_nonce: number;    // Nonce before
  new_nonce: number;    // Nonce after
  storage_accesses: StorageChange[];  // Storage changes
}

/** State diff returned from forge */
export interface StateDiff {
  /** All account accesses during the transaction */
  account_accesses: AccountAccess[];
  /** Summary stats */
  summary: {
    total_accesses: number;
    storage_writes: number;
    storage_reads: number;
    contracts_called: number;
    balance_changes: number;
  };
}

// Update TraceCallbackPayload
export interface TraceCallbackPayload {
  success: boolean;
  trace_content?: string;
  trace_format?: "ansi" | "plain" | "json";
  error?: string;
  error_code?: string;
  duration_ms?: number;
  tracer_metadata?: Record<string, unknown>;

  /** State diff from transaction execution (NEW) */
  state_diff?: StateDiff;
}
```

### 3. `index.ts`

Add state diff extraction:

```typescript
/**
 * Extracts state diff JSON from forge output.
 * Looks for [STATE_DIFF_START] ... [STATE_DIFF_END] markers.
 */
function extractStateDiff(rawOutput: string): StateDiff | null {
  const startMarker = "[STATE_DIFF_START]";
  const endMarker = "[STATE_DIFF_END]";

  const startIndex = rawOutput.indexOf(startMarker);
  const endIndex = rawOutput.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1) {
    return null;
  }

  const stateDiffContent = rawOutput
    .slice(startIndex + startMarker.length, endIndex)
    .trim();

  // Parse JSON lines into AccountAccess array
  const accesses = parseStateDiffLines(stateDiffContent);

  return {
    account_accesses: accesses,
    summary: computeStateDiffSummary(accesses),
  };
}

function parseStateDiffLines(content: string): AccountAccess[] {
  // Parse each JSON line, strip ANSI codes, build array
  // Handle vm.serializeJson output format
}

function computeStateDiffSummary(accesses: AccountAccess[]) {
  // Count storage writes, reads, unique contracts, balance changes
}
```

Update `processTrace()` to extract and include state diff:

```typescript
async function processTrace(request: TraceRequest): Promise<void> {
  // ... existing code ...

  const result = await enqueueForgeTestRun(forgeEnv);
  const extracted = extractTransactionTrace(result.stdout);

  // NEW: Extract state diff
  const stateDiff = extractStateDiff(result.stdout);

  await sendCallback(request.callback_url, {
    success: extracted.testPassed,
    trace_content: extracted.trace || result.stdout,
    trace_format: "ansi",
    duration_ms: Date.now() - startTime,
    ...(extracted.error && !extracted.trace && { error: extracted.error }),
    ...(stateDiff && { state_diff: stateDiff }),  // NEW
  });
}
```

## Implementation Steps

### Phase 1: Solidity State Diff Capture

1. Update `InvalidatingTrace.t.sol`:
   - Import `console` from forge-std for logging
   - Add `vm.startStateDiffRecording()` before the call in `testTracing()`
   - Add `vm.stopAndReturnStateDiff()` after the call
   - Implement `_emitStateDiff()` helper to serialize and log

2. Test locally:
   ```bash
   cd foundry
   forge test -vvvv --match-test testTracing
   ```
   Verify `[STATE_DIFF_START]` and `[STATE_DIFF_END]` markers appear in output

### Phase 2: TypeScript Extraction

1. Update `types.ts`:
   - Add `StorageChange` interface
   - Add `AccountAccess` interface
   - Add `StateDiff` interface
   - Add `state_diff` field to `TraceCallbackPayload`

2. Update `index.ts`:
   - Implement `extractStateDiff()` function
   - Implement `parseStateDiffLines()` for JSON parsing
   - Implement `computeStateDiffSummary()` for summary stats
   - Update `processTrace()` to include state diff in callback

### Phase 3: Testing

1. Unit test for state diff parsing (`test/state-diff.test.ts`)
2. Integration test with actual forge run
3. E2E test verifying callback includes `state_diff` field

## Verification

1. **Local test**:
   ```bash
   cd foundry
   FROM=0x... TO=0x... VALUE=0 CALLDATA=0x... RPC=https://... \
     FORK_BLOCK_NUMBER=... BLOCK_NUMBER=... BLOCK_TIMESTAMP=... \
     BLOCK_BASEFEE=... BLOCK_COINBASE=... BLOCK_DIFFICULTY=0 \
     forge test -vvvv --match-test testTracing
   ```
   Verify state diff markers in output

2. **API test**:
   ```bash
   curl -X POST http://localhost:3000/api/queue \
     -H "Content-Type: application/json" \
     -H "X-API-Key: your-key" \
     -d '{ ... }'
   ```
   Verify callback includes `state_diff` with `account_accesses` array

3. **Callback inspection**:
   Check that `state_diff.summary` shows accurate counts

## Example Output

Expected callback payload with state diff:

```json
{
  "success": true,
  "trace_content": "└─ [12345] 0xABC::transfer(...)\n    ├─ ...",
  "trace_format": "ansi",
  "duration_ms": 3500,
  "state_diff": {
    "account_accesses": [
      {
        "index": 0,
        "kind": 0,
        "kind_name": "Call",
        "account": "0x1234...",
        "accessor": "0x5678...",
        "initialized": true,
        "old_balance": "1000000000000000000",
        "new_balance": "900000000000000000",
        "value": "100000000000000000",
        "reverted": false,
        "depth": 1,
        "storage_accesses": [
          {
            "account": "0x1234...",
            "slot": "0x0000...0001",
            "is_write": true,
            "previous_value": "0x0000...0064",
            "new_value": "0x0000...00c8",
            "reverted": false
          }
        ]
      }
    ],
    "summary": {
      "total_accesses": 3,
      "storage_writes": 2,
      "storage_reads": 5,
      "contracts_called": 2,
      "balance_changes": 1
    }
  }
}
```

## Potential Challenges

| Challenge | Mitigation |
|-----------|------------|
| Large state diffs (100s of accesses) | Summary provides quick overview; full data available if needed |
| JSON serialization in Solidity | Use `vm.serializeJson` builder or structured line format |
| ANSI codes in console output | Strip ANSI before JSON parsing |
| Deeply nested calls | `depth` field preserves call hierarchy |

## Design Decisions

1. **Include all accesses**: No filtering - include everything `stopAndReturnStateDiff` returns (reads, writes, Balance checks, etc.)

2. **Include all byte fields**: Include `data` (calldata) and `deployedCode` in the output for completeness

3. **AccountAccessKind format**: Include both numeric `kind` and human-readable `kind_name` for flexibility

## Critical Files

- `foundry/test/InvalidatingTrace.t.sol` - Add state diff recording
- `types.ts` - Add TypeScript interfaces
- `index.ts` - Add extraction and callback logic

## References

- [startStateDiffRecording docs](https://getfoundry.sh/reference/cheatcodes/start-state-diff-recording)
- [stopAndReturnStateDiff docs](https://getfoundry.sh/reference/cheatcodes/stop-and-return-state-diff)
- [forge-std Vm.sol](https://github.com/foundry-rs/forge-std/blob/master/src/Vm.sol) - Struct definitions

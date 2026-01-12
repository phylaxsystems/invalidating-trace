# EVM Forking & Block Environment Fix

## Problem Summary

The tracer's current implementation has a fundamental issue with how EVM state forking and block environment are handled during transaction simulation.

### Background: How EVM State Works

When simulating a transaction, we need two things:

1. **State**: The account balances, contract storage, and code at a specific point in time
2. **Block Environment**: The `block.number`, `block.timestamp`, `block.basefee`, `block.coinbase`, etc. that smart contracts can read

These are independent concerns. A transaction's execution depends on:

- The **state** from all prior transactions
- The **block environment** of the block it executes in

### The Current (Incorrect) Implementation

```
1. vm.createSelectFork(rpc, invalidating_tx_hash)  // Fork using tx hash
2. _applyPreviousTransactions()                     // Replay previous txs
3. testTracing()                                    // Execute invalidating tx
```

**Issues:**

1. **Transaction hash may not exist on-chain**
   The invalidating transaction's block may never have landed on-chain (e.g., we're simulating a pending or hypothetical transaction). We cannot rely on the transaction hash being queryable from the RPC.

2. **Block environment not applied**
   The `block_env` fields (number, timestamp, basefee, coinbase, etc.) are passed to Forge as environment variables but **never applied** in the Solidity contract. Smart contracts that read `block.number` or `block.timestamp` will get the forked block's values, not the target block's values.

3. **Wrong state when forking at tx hash**
   When Foundry forks at a transaction hash, it rolls to the block containing that tx and replays all transactions *before* it (giving state right before that tx executes). However, this still doesn't help because the invalidating tx may not exist on-chain, and we'd still have the wrong block environment.

### The Correct Approach

To accurately trace a transaction, we need to:

```
1. Fork at PREVIOUS block (N-1) → state at END of previous block
2. Set NEW block environment (N) → block.number, block.timestamp, etc.
3. Execute previous transactions → all txs in block N BEFORE the invalidating tx
4. Execute invalidating tx → trace this with correct state + block env
```

**Why this works:**

- Forking at block N-1 gives us the state at the end of that block (before any txs in block N)
- Setting the block environment ensures contracts see the correct `block.number`, `block.timestamp`, etc.
- Replaying previous transactions builds up the intermediate state
- The invalidating tx then executes with the exact context it would have on-chain

---

## Solution: Foundry Cheat Codes

Foundry provides cheat codes to manipulate the EVM environment during tests. After forking at the previous block, we use these to set the target block's environment:

| Cheat Code                           | Purpose                | Notes                                 |
| ------------------------------------ | ---------------------- | ------------------------------------- |
| `vm.createSelectFork(rpc, blockNum)` | Fork at specific block | State at END of block                 |
| `vm.roll(n)`                         | Set `block.number`     |                                       |
| `vm.warp(t)`                         | Set `block.timestamp`  |                                       |
| `vm.fee(f)`                          | Set `block.basefee`    | EIP-1559                              |
| `vm.coinbase(a)`                     | Set `block.coinbase`   | Miner/validator address               |
| `vm.difficulty(d)`                   | Set `block.difficulty` | **Reverts on post-merge chains**      |
| `vm.prevrandao(r)`                   | Set `block.prevrandao` | Post-merge only (replaces difficulty) |
| `vm.blobBaseFee(f)`                  | Set `block.blobbasefee`| EIP-4844 blob base fee                |

### Pre-Merge vs Post-Merge Chains

- **Pre-merge chains**: Use `vm.difficulty()` to set `block.difficulty`
- **Post-merge chains** (Ethereum mainnet, Linea, etc.): Use `vm.prevrandao()` instead
- Calling `vm.difficulty()` on a post-merge fork will **revert**

---

## API Changes

### New Required Field: `fork_block_number`

The block number to fork at. This should be the block **before** the one containing the invalidating transaction (block N-1).

```typescript
/** Block number to fork at (block N-1, state at END of that block) */
fork_block_number: number; // REQUIRED
```

### Now Required: `block_env`

Previously optional, now required. Contains the block environment for the target block (N) where the invalidating transaction executes.

```typescript
interface BlockEnv {
  number: string; // Block number (N)
  timestamp: string; // Unix timestamp
  beneficiary: string; // Coinbase address
  gas_limit: string; // Block gas limit
  basefee: string; // EIP-1559 base fee
  difficulty: string; // Pre-merge difficulty
  prevrandao: string | null; // Post-merge randomness (null for pre-merge)
  blob_excess_gas_and_price: {
    excess_blob_gas: string;
    blob_gasprice: string;
  } | null; // EIP-4844 blob gas (null if not applicable)
}
```

### Removed Fields

- `block_number` - Replaced by `block_env.number`
- `previous_block_number` - Replaced by `fork_block_number`

---

## Updated Solidity Contract

The `InvalidatingTrace.t.sol` contract needs to:

1. Read `FORK_BLOCK_NUMBER` and fork at that block
2. Apply block environment using cheat codes
3. Execute previous transactions (unchanged)
4. Trace the invalidating transaction (unchanged)

### Key Code Changes

**setUp() function:**

```solidity
function setUp() public {
    // Read env vars
    rpc = vm.envString("RPC");
    data = vm.envBytes("CALLDATA");
    invalidatingFrom = vm.envAddress("FROM");
    invalidatingTo = vm.envAddress("TO");
    value = vm.envUint("VALUE");

    // 1. Fork at previous block (N-1) - state at END of that block
    uint256 forkBlockNumber = vm.envUint("FORK_BLOCK_NUMBER");
    vm.createSelectFork(rpc, forkBlockNumber);

    // 2. Apply target block environment (block N)
    _applyBlockEnvironment();

    // 3. Apply previous transactions in block N
    _applyPreviousTransactions();

    // 4. Setup for invalidating tx
    vm.label(invalidatingFrom, "invalidating_from");
    vm.label(invalidatingTo, "invalidating_to");
    vm.startPrank(invalidatingFrom, invalidatingFrom);
}
```

**New \_applyBlockEnvironment() function:**

```solidity
function _applyBlockEnvironment() internal {
    vm.roll(vm.envUint("BLOCK_NUMBER"));
    vm.warp(vm.envUint("BLOCK_TIMESTAMP"));
    vm.fee(vm.envUint("BLOCK_BASEFEE"));
    vm.coinbase(vm.envAddress("BLOCK_COINBASE"));

    // Post-merge: use prevrandao; Pre-merge: use difficulty
    string memory prevrandao = vm.envOr("BLOCK_PREVRANDAO", string(""));
    if (bytes(prevrandao).length > 0) {
        vm.prevrandao(vm.parseBytes32(prevrandao));
    } else {
        vm.difficulty(vm.envUint("BLOCK_DIFFICULTY"));
    }

    // EIP-4844 blob base fee (if applicable)
    string memory blobBaseFee = vm.envOr("BLOCK_BLOB_BASE_FEE", string(""));
    if (bytes(blobBaseFee).length > 0) {
        vm.blobBaseFee(vm.parseUint(blobBaseFee));
    }
}
```

---

## Example Request

```json
{
  "rpc_url": "https://rpc.linea.build",
  "callback_url": "https://dapp.com/webhook?trace_id=123",
  "chain_id": 59144,
  "transaction_hash": "0xabc...",
  "fork_block_number": 12345677,
  "transaction": {
    "from": "0x1111...",
    "to": "0x2222...",
    "value": "1000000000000000000",
    "data": "0xa9059cbb..."
  },
  "block_env": {
    "number": "12345678",
    "timestamp": "1704672000",
    "beneficiary": "0x5555...",
    "basefee": "1000000000",
    "gas_limit": "30000000",
    "difficulty": "0",
    "prevrandao": "0x1234567890abcdef...",
    "blob_excess_gas_and_price": null
  },
  "previous_transactions": [
    {
      "type": 2,
      "transaction_hash": "0x...",
      "from_address": "0x3333...",
      "to_address": "0x4444...",
      "value": "0",
      "data": "0x...",
      "chain_id": 59144,
      "nonce": "42",
      "gas_limit": "100000",
      "max_fee_per_gas": "2000000000",
      "max_priority_fee_per_gas": "1000000000"
    }
  ]
}
```

**Flow:**

1. Fork at block 12345677 (state at end of that block)
2. Set block environment for block 12345678
3. Execute the previous transaction from 0x3333
4. Trace the invalidating transaction from 0x1111

---

## Verification

To verify the fix works correctly:

1. **Compile**: `forge build` should pass
2. **Block env verification**: Add console.log to print `block.number`, `block.timestamp`, etc. and confirm they match `block_env` values
3. **State verification**: Confirm previous transactions affect state correctly
4. **Trace accuracy**: Compare trace output against actual on-chain behavior

---

## References

- [Foundry Cheatcodes: createSelectFork](https://getfoundry.sh/cheatcodes/create-select-fork)
- [Foundry Cheatcodes: roll](https://getfoundry.sh/cheatcodes/roll)
- [Foundry Cheatcodes: warp](https://getfoundry.sh/cheatcodes/warp)
- [Foundry Cheatcodes: fee](https://getfoundry.sh/cheatcodes/fee)
- [Foundry Cheatcodes: coinbase](https://getfoundry.sh/cheatcodes/coinbase)
- [Foundry Cheatcodes: difficulty](https://getfoundry.sh/cheatcodes/difficulty)
- [Foundry Cheatcodes: prevrandao](https://getfoundry.sh/cheatcodes/prevrandao)
- [Foundry Cheatcodes: blobBaseFee](https://getfoundry.sh/cheatcodes/blob-base-fee)

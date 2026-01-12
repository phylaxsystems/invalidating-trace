# Real-World Testing Example

This guide walks through tracing a real Linea mainnet transaction [`0x129fa9b6fdf2645b82a6e3ce23a39e19d064ced7568bda40cfea8c0903d39964`](https://lineascan.build/tx/0x129fa9b6fdf2645b82a6e3ce23a39e19d064ced7568bda40cfea8c0903d39964) with previous transactions from [block 27601996](https://lineascan.build/txs?block=27601996). This example demonstrates key tracer behaviors including how reverts in previous transactions are handled and how trace output is filtered.

## 1. Start a callback listener (simulating your dapp)

In production, the tracer POSTs results to your dapp's webhook endpoint. For local testing, we use `nc` (netcat) to mimic this callback receiver:

```bash
# Simple netcat listener - this simulates your dapp's callback endpoint
nc -l 8080
```

When the trace completes, the tracer will POST the JSON result to this listener. You'll see the raw HTTP request including headers and the trace payload.

> **Note**: `nc` will exit after receiving one request. For multiple tests, restart it or use a persistent server.

## 2. Start the tracer service

```bash
DAPP_API_KEYS=test-api-key bun --hot index.ts
```

## 3. Send a trace request

```bash
curl -X POST http://localhost:3000/api/queue \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: test-api-key' \
  -d '{
    "rpc_url": "https://rpc.linea.build",
    "callback_url": "http://localhost:8080/callback",
    "chain_id": 59144,
    "transaction_hash": "0x129fa9b6fdf2645b82a6e3ce23a39e19d064ced7568bda40cfea8c0903d39964",
    "fork_block_number": 27601995,
    "transaction": {
      "from": "0xe62b2d9a8c7d71d1c5f261c9149b1a20ec08ef17",
      "to": "0x3921e8cb45b17fc029a0a6de958330ca4e583390",
      "value": "0x0",
      "data": "0xbc651188000000000000000000000000e5d7c2a44ffddf6b295a15c148167daaaf5cf34f0000000000000000000000003aab2285ddcddad8edf438c1bab47e1a9d05a9b4000000000000000000000000e62b2d9a8c7d71d1c5f261c9149b1a20ec08ef170000000000000000000000000000000000000000000000000000000069605bc400000000000000000000000000000000000000000000000002386f26fc10000000000000000000000000000000000000000000000000000000000000000855c40000000000000000000000000000000000000000000000000000000000000000",
      "nonce": "0x38e72",
      "gas_limit": "0x7a120",
      "type": 0
    },
    "block_env": {
      "number": "0x1a52c4c",
      "timestamp": "0x6960596e",
      "beneficiary": "0x8f81e2e3f8b46467523463835f965ffe476e1c9e",
      "gas_limit": "0x77359400",
      "basefee": "0x7",
      "difficulty": "0x0",
      "prevrandao": "0x1cc433d1deab7d268e1d17439b3a569978429125fadb902d714b48a2bdb886b7",
      "blob_excess_gas_and_price": {"excess_blob_gas": "0x0", "blob_gasprice": "0x1"}
    },
    "previous_transactions": [
      {"type": 0, "transaction_hash": "0x3187459a9b78d0a46ac7cf8b202742c622e7d67ff5043416426f43eb8c72d403", "chain_id": 59144, "nonce": "0x18dc6", "gas_limit": "0xf4240", "to_address": "0x8be024b5c546b5d45cbb23163e1a4dca8fa5052a", "from_address": "0x33128fa08f5e0545f4714434b53bdb5e98f62474", "value": "0x0", "data": "0xa026383e000000000000000000000000e5d7c2a44ffddf6b295a15c148167daaaf5cf34f000000000000000000000000176211869ca2b568f2a7d4ee941e073a821ee1ff000000000000000000000000000000000000000000000000000000000000003200000000000000000000000033128fa08f5e0545f4714434b53bdb5e98f624740000000000000000000000000000000000000000000000000000000069605bc400000000000000000000000000000000000000000000000006f05b59d3b20000000000000000000000000000000000000000000000000000000000005c5726ee0000000000000000000000000000000000000000000000000000000000000000", "gas_price": "0xa7d8c00"},
      {"type": 0, "transaction_hash": "0x139402c20df80220a84e55c984fa392b47e2f97a0a03bbf66ed3fe915d6fab52", "chain_id": 59144, "nonce": "0x59155", "gas_limit": "0x7a120", "to_address": "0x85974429677c2a701af470b82f3118e74307826e", "from_address": "0x485ca81b70255da2fe3fd0814b57d1b08fce784e", "value": "0x0", "data": "0x24856bc30000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000100000000000000000000000000485ca81b70255da2fe3fd0814b57d1b08fce784e000000000000000000000000000000000000000000000000016a6075a71700000000000000000000000000000000000000000000000000000000000012d1a01800000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002be5d7c2a44ffddf6b295a15c148167daaaf5cf34f000005176211869ca2b568f2a7d4ee941e073a821ee1ff000000000000000000000000000000000000000000", "gas_price": "0x2160ec0"},
      {"type": 0, "transaction_hash": "0x3d4c875d55ebe946a8d78488757206469b3a44c58ddbdf16a66b70c3e29eb423", "chain_id": 59144, "nonce": "0x59156", "gas_limit": "0xc350", "to_address": "0x032b241de86a8660f1ae0691a4760b426ea246d7", "from_address": "0x485ca81b70255da2fe3fd0814b57d1b08fce784e", "value": "0x0", "data": "0x", "gas_price": "0x6146580"},
      {"type": 0, "transaction_hash": "0x4f3a0f178d205c6de5f17cd41d50718738a0e1b68e975b25961b1f46a8ec5fb3", "chain_id": 59144, "nonce": "0x59157", "gas_limit": "0x7a120", "to_address": "0x3921e8cb45b17fc029a0a6de958330ca4e583390", "from_address": "0x485ca81b70255da2fe3fd0814b57d1b08fce784e", "value": "0x0", "data": "0xbc651188000000000000000000000000e5d7c2a44ffddf6b295a15c148167daaaf5cf34f000000000000000000000000176211869ca2b568f2a7d4ee941e073a821ee1ff000000000000000000000000485ca81b70255da2fe3fd0814b57d1b08fce784e00000000000000000000000000000000000000000000000000000000b2d05e0000000000000000000000000000000000000000000000000001833eec2884800000000000000000000000000000000000000000000000000000000000141bfb1a0000000000000000000000000000000000000000000000000000000000000000", "gas_price": "0x2160ec0"},
      {"type": 0, "transaction_hash": "0x8e9789718bd39e5f1dc383cce24ce5ef84e7bc8658b1887304e8564578f8ef69", "chain_id": 59144, "nonce": "0x20", "gas_limit": "0x10a64", "to_address": "0x9077a11919cd14075a8d8ecf62eb22f34fd8da1d", "from_address": "0x295bb4198c7978874c27f1847c64306e490e7d9c", "value": "0x0", "data": "0x5c04c412f8114a6d5f9e05b59211b7c061d6dbb7fa309bcbdda981143c5b8a2d3d224e230000000000000000000000000000000000000000000000000000000069605a900000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000004155f0fc55640a4e0771d132775468f23f3e1a99900117ce1f91d10f7e83c295ee1445b28b89c08ec43d0f099f4899a696851320f49540b7af30bb9608d9a56a1c1b00000000000000000000000000000000000000000000000000000000000000", "gas_price": "0x46e8492"},
      {"type": 2, "transaction_hash": "0x89c6cb4ca07ff7efd70bf6f1b23839a707e2deb3531d434e1757a286e45d63e6", "chain_id": 59144, "nonce": "0x2989", "gas_limit": "0x5208", "to_address": "0x0431cb6789395bf82a676eb14b7763de880c5e48", "from_address": "0x1b9dc8c4fbbc0018a84793df98ed0533fb4d2e04", "value": "0xe8d4a510000", "data": "0x", "max_fee_per_gas": "0x4074f91", "max_priority_fee_per_gas": "0x4074f7c", "access_list": []}
    ]
  }'
```

## 4. Expected behavior

- **Response**: `202 Accepted` with `{"status": "queued", "message": "Trace job queued successfully"}`
- **Callback**: The tracer will POST results to `http://localhost:8080/callback` with the trace output

## Key behaviors demonstrated

### Reverting previous transactions don't halt the trace

This example includes 6 previous transactions from block 27601996 that execute before the target transaction. Some of these transactions may revert during simulation - **this is expected and does not halt or fail the trace job**. The tracer continues processing through all previous transactions (regardless of their success/failure) to accurately reconstruct the blockchain state, then traces the target transaction.

This behavior is critical for accurate tracing because:
- The EVM still modifies state even when transactions revert (gas is consumed, nonces increment)
- Previous transaction reverts are part of the actual block history
- The target transaction's behavior depends on the state after all previous transactions, including reverts

### Only the target transaction trace is returned

The `trace_content` field in the callback payload contains **only** the trace of the target transaction (`0x129fa9...`). It does not include:
- Forge test setup traces
- Previous transaction traces
- Test summary output

This filtering makes it easy to display the relevant trace to users without parsing through setup noise.

<details>
<summary><strong>Example callback output</strong></summary>

```json
{
  "success": true,
  "trace_content": "│   ├─ [257719] \u001b[32m0x8E80016b025C89A6a270b399F5eBFb734bE58ada\u001b[0m::\u001b[32mswap\u001b[0m(invalidating_from: [0xe62b2D9a8C7D71d1C5F261C9149b1a20EC08eF17], false, 160000000000000000 \u001b[2m[1.6e17]\u001b[0m, 1461446703485210103287273052203988822378723970341 \u001b[2m[1.461e48]\u001b[0m, 0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000040000000000000000000000000e62b2d9a8c7d71d1c5f261c9149b1a20ec08ef170000000000000000000000000000000000000000000000000000000000000028e5d7c2a44ffddf6b295a15c148167daaaf5cf34f3aab2285ddcddad8edf438c1bab47e1a9d05a9b4000000000000000000000000000000000000000000000000)\n│   │   ├─ [100154] \u001b[32m0x72D4ECFF0F329fcc0177Ee9007C23D3da2E4ff5B\u001b[0m::\u001b[32mwrite\u001b[0m(51959 \u001b[2m[5.195e4]\u001b[0m, 1767922030 \u001b[2m[1.767e9]\u001b[0m, 264023 \u001b[2m[2.64e5]\u001b[0m, 1120412027070683 \u001b[2m[1.12e15]\u001b[0m, 4706856534183765 \u001b[2m[4.706e15]\u001b[0m)\n│   │   │   └─ \u001b[32m← [Return]\u001b[0m 0x000000000000000000000000000000000000000000000000000000000000caf8\n│   │   ├─ [51700] \u001b[32m0x72D4ECFF0F329fcc0177Ee9007C23D3da2E4ff5B\u001b[0m::\u001b[32mgetFee\u001b[0m(1767922030 \u001b[2m[1.767e9]\u001b[0m, 264023 \u001b[2m[2.64e5]\u001b[0m, 51960 \u001b[2m[5.196e4]\u001b[0m, 1120412027070683 \u001b[2m[1.12e15]\u001b[0m)\u001b[33m [staticcall]\u001b[0m\n│   │   │   └─ \u001b[32m← [Return]\u001b[0m 0x0000000000000000000000000000000000000000000000000000000000000512\n│   │   ├─ emit Fee(\u001b[36m: 1298\u001b[0m)\n│   │   ├─ [2217] \u001b[32m0x72D4ECFF0F329fcc0177Ee9007C23D3da2E4ff5B\u001b[0m::\u001b[32mcalculateVolumePerLiquidity\u001b[0m(1120412027070683 \u001b[2m[1.12e15]\u001b[0m, -546524 \u001b[2m[-5.465e5]\u001b[0m, 160000000000000000 \u001b[2m[1.6e17]\u001b[0m)\u001b[33m [staticcall]\u001b[0m\n│   │   │   └─ \u001b[32m← [Return]\u001b[0m 0x00000000000000000000000000000000000000000000000000114a5bb8097faf\n│   │   ├─ [19851] \u001b[32m0x3aAB2285ddcDdaD8edf438C1bAB47e1a9D05a9b4\u001b[0m::\u001b[32mtransfer\u001b[0m(invalidating_from: [0xe62b2D9a8C7D71d1C5F261C9149b1a20EC08eF17], 546524 \u001b[2m[5.465e5]\u001b[0m)\n│   │   │   ├─ [12688] \u001b[32m0xc0583e2F5930EDE5Fab9D57bAC4169878730B010\u001b[0m::\u001b[32mtransfer\u001b[0m(invalidating_from: [0xe62b2D9a8C7D71d1C5F261C9149b1a20EC08eF17], 546524 \u001b[2m[5.465e5]\u001b[0m)\u001b[33m [delegatecall]\u001b[0m\n│   │   │   │   ├─ emit Transfer(\u001b[36mparam0: 0x8E80016b025C89A6a270b399F5eBFb734bE58ada, param1: invalidating_from: [0xe62b2D9a8C7D71d1C5F261C9149b1a20EC08eF17], param2: 546524 \u001b[2m[5.465e5]\u001b[0m\u001b[0m)\n│   │   │   │   └─ \u001b[32m← [Return]\u001b[0m 0x0000000000000000000000000000000000000000000000000000000000000001\n│   │   │   └─ \u001b[32m← [Return]\u001b[0m 0x0000000000000000000000000000000000000000000000000000000000000001\n│   │   ├─ [2534] \u001b[32m0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f\u001b[0m::\u001b[32mbalanceOf\u001b[0m(0x8E80016b025C89A6a270b399F5eBFb734bE58ada)\u001b[33m [staticcall]\u001b[0m\n│   │   │   └─ \u001b[32m← [Return]\u001b[0m 0x000000000000000000000000000000000000000000000000de9b244f670a1a73\n│   │   ├─ [20337] \u001b[32minvalidating_to\u001b[0m::\u001b[32malgebraSwapCallback\u001b[0m(-546524 \u001b[2m[-5.465e5]\u001b[0m, 160000000000000000 \u001b[2m[1.6e17]\u001b[0m, 0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000040000000000000000000000000e62b2d9a8c7d71d1c5f261c9149b1a20ec08ef170000000000000000000000000000000000000000000000000000000000000028e5d7c2a44ffddf6b295a15c148167daaaf5cf34f3aab2285ddcddad8edf438c1bab47e1a9d05a9b4000000000000000000000000000000000000000000000000)\n│   │   │   ├─ [16548] \u001b[32m0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f\u001b[0m::\u001b[32mtransferFrom\u001b[0m(invalidating_from: [0xe62b2D9a8C7D71d1C5F261C9149b1a20EC08eF17], 0x8E80016b025C89A6a270b399F5eBFb734bE58ada, 160000000000000000 \u001b[2m[1.6e17]\u001b[0m)\n│   │   │   │   ├─ emit Transfer(\u001b[36mparam0: invalidating_from: [0xe62b2D9a8C7D71d1C5F261C9149b1a20EC08eF17], param1: 0x8E80016b025C89A6a270b399F5eBFb734bE58ada, param2: 160000000000000000 \u001b[2m[1.6e17]\u001b[0m\u001b[0m)\n│   │   │   │   └─ \u001b[32m← [Return]\u001b[0m 0x0000000000000000000000000000000000000000000000000000000000000001\n│   │   │   └─ \u001b[32m← [Stop]\u001b[0m\n│   │   ├─ [534] \u001b[32m0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f\u001b[0m::\u001b[32mbalanceOf\u001b[0m(0x8E80016b025C89A6a270b399F5eBFb734bE58ada)\u001b[33m [staticcall]\u001b[0m\n│   │   │   └─ \u001b[32m← [Return]\u001b[0m 0x000000000000000000000000000000000000000000000000e0d39376631a1a73\n│   │   ├─ [2414] \u001b[32m0x622b2c98123D303ae067DB4925CD6282B3A08D0F\u001b[0m::\u001b[32mvaultAddress\u001b[0m()\u001b[33m [staticcall]\u001b[0m\n│   │   │   └─ \u001b[32m← [Return]\u001b[0m 0x0000000000000000000000001d8b6fa722230153be08c4fa4aa4b4c7cd01a95a\n│   │   ├─ [8062] \u001b[32m0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f\u001b[0m::\u001b[32mtransfer\u001b[0m(0x1d8b6fA722230153BE08C4Fa4Aa4B4c7cd01A95a, 6230400000000 \u001b[2m[6.23e12]\u001b[0m)\n│   │   │   ├─ emit Transfer(\u001b[36mparam0: 0x8E80016b025C89A6a270b399F5eBFb734bE58ada, param1: 0x1d8b6fA722230153BE08C4Fa4Aa4B4c7cd01A95a, param2: 6230400000000 \u001b[2m[6.23e12]\u001b[0m\u001b[0m)\n│   │   │   └─ \u001b[32m← [Return]\u001b[0m 0x0000000000000000000000000000000000000000000000000000000000000001\n│   │   ├─ emit Swap(\u001b[36mparam0: invalidating_to: [0x3921e8cb45B17fC029A0a6dE958330ca4e583390], param1: invalidating_from: [0xe62b2D9a8C7D71d1C5F261C9149b1a20EC08eF17], param2: -546524 \u001b[2m[-5.465e5]\u001b[0m, param3: 160000000000000000 \u001b[2m[1.6e17]\u001b[0m, param4: 42845981401070556615965425721128727 \u001b[2m[4.284e34]\u001b[0m, param5: 1120412027070683 \u001b[2m[1.12e15]\u001b[0m, param6: 264029 \u001b[2m[2.64e5]\u001b[0m\u001b[0m)\n│   │   └─ \u001b[32m← [Return]\u001b[0m 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7a92400000000000000000000000000000000000000000000000002386f26fc100000\n│   └─ \u001b[32m← [Return]\u001b[0m 0x00000000000000000000000000000000000000000000000000000000000856dc\n└─ \u001b[32m← [Stop]\u001b[0m",
  "trace_format": "ansi",
  "duration_ms": 25794
}
```

</details>

## Notes

- `fork_block_number` should be set to one block before the target block so the fork state is from before any transactions in that block executed
- All hex values should be preserved as returned from the RPC
- For EIP-1559 (Type 2) transactions, use `max_fee_per_gas` and `max_priority_fee_per_gas` instead of `gas_price`
- Legacy (Type 0) transactions use `gas_price`

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

// Struct field names MUST match JSON keys from TypeScript
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

struct PrevTx {
    uint8 txType;
    bytes32 txHash;
    uint256 txChainId;
    uint256 txNonce;
    uint256 txGasLimit;
    address txFrom;
    address txTo;
    uint256 txValue;
    bytes txData;
    uint256 txGasPrice;
    uint256 txMaxFeePerGas;
    uint256 txMaxPriorityFeePerGas;
    uint256 txMaxFeePerBlobGas;
    bytes32[] txBlobVersionedHashes;
    AccessListEntry[] txAccessList;
    AuthorizationTuple[] txAuthorizationList;
}

contract InvalidatingTrace is Test {
    string rpc;
    address invalidatingFrom;
    address invalidatingTo;
    bytes data;
    uint256 value;

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

    /**
     * Apply block environment cheat codes to set the target block's context.
     * Called AFTER fork but BEFORE previous transactions.
     */
    function _applyBlockEnvironment() internal {
        // Core block environment
        vm.roll(vm.envUint("BLOCK_NUMBER"));
        vm.warp(vm.envUint("BLOCK_TIMESTAMP"));
        vm.fee(vm.envUint("BLOCK_BASEFEE"));
        vm.coinbase(vm.envAddress("BLOCK_COINBASE"));

        // Post-merge: use prevrandao; Pre-merge: use difficulty
        // BLOCK_PREVRANDAO will be empty string for pre-merge chains
        string memory prevrandao = vm.envOr("BLOCK_PREVRANDAO", string(""));
        if (bytes(prevrandao).length > 0) {
            vm.prevrandao(vm.parseBytes32(prevrandao));
        } else {
            // Pre-merge chain - use difficulty
            vm.difficulty(vm.envUint("BLOCK_DIFFICULTY"));
        }

        // EIP-4844 blob base fee (if applicable)
        // BLOCK_BLOB_BASE_FEE will be empty string for non-blob chains
        string memory blobBaseFee = vm.envOr("BLOCK_BLOB_BASE_FEE", string(""));
        if (bytes(blobBaseFee).length > 0) {
            vm.blobBaseFee(vm.parseUint(blobBaseFee));
        }
    }

    function _applyPreviousTransactions() internal {
        string memory prevTxsJson = vm.envOr("PREVIOUS_TXS", string("[]"));

        // Skip if empty array
        if (bytes(prevTxsJson).length <= 2) return;

        bytes memory parsed = vm.parseJson(prevTxsJson);
        PrevTx[] memory prevTxs = abi.decode(parsed, (PrevTx[]));

        for (uint256 i = 0; i < prevTxs.length; i++) {
            vm.prank(prevTxs[i].txFrom);
            // Execute previous tx - ignore revert status
            // Reverts are expected for some txs (e.g., failed attempts before the one we're tracing)
            // State changes from reverted txs are automatically rolled back by the EVM
            prevTxs[i].txTo.call{value: prevTxs[i].txValue}(prevTxs[i].txData);
        }
    }

    function testTracing() public {
        // First execution of invalidating tx - this is what we trace
        (bool success, bytes memory result) = address(invalidatingTo).call{value: value}(data);
        require(success);
    }
}

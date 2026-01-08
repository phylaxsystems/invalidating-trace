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
    bytes32 invalidating_tx_hash;
    uint256 value;

    function setUp() public {
        rpc = vm.envString("RPC");
        invalidating_tx_hash = vm.envBytes32("PREVIOUS_TX");
        data = vm.envBytes("CALLDATA");
        invalidatingFrom = vm.envAddress("FROM");
        invalidatingTo = vm.envAddress("TO");
        value = vm.envUint("VALUE");

        vm.label(invalidatingFrom, "invalidating_from");
        vm.label(invalidatingTo, "invalidating_to");

        // Fork at the block containing the invalidating tx (state BEFORE any txs)
        vm.createSelectFork(rpc, invalidating_tx_hash);

        // REMOVED: vm.transact(previous_tx) - don't apply invalidating tx before tracing

        // Apply previous transactions in order (if any)
        _applyPreviousTransactions();

        vm.startPrank(invalidatingFrom, invalidatingFrom);
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
        (bool success, bytes memory result) = address(invalidatingTo).call{value: value}(data);
        require(success);
    }
}

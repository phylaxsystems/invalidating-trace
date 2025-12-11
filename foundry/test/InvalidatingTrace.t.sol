// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

contract InvalidatingTrace is Test {
    string rpc;
    address from;
    address to;
    bytes data;
    bytes32 previous_tx;
    uint256 value;
    function setUp() public {
        rpc = vm.envString("RPC");
        previous_tx = vm.envBytes32("PREVIOUS_TX");
        data = vm.envBytes("CALLDATA");
        from = vm.envAddress("FROM");
        to = vm.envAddress("TO");
        value = vm.envUint("VALUE");

        vm.label(from, "invalidating_from");
        vm.label(from, "invalidating_to");
        vm.createSelectFork(rpc, previous_tx);
        vm.transact(previous_tx);
        vm.startPrank(from, from);
    }

    function testTracing() public {
        (bool success, bytes memory result) = address(to).call{value:value}(data);
        require(success);
    }
}

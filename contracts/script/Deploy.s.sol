// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {SessionKeyDelegate} from "../src/SessionKeyDelegate.sol";

/**
 * Deploys the SessionKeyDelegate. The delegate is stateless per-deployment (all
 * session state lives in each account's own storage via EIP-7702), so ONE
 * deployment per network serves every account.
 *
 * Usage (testnet):
 *   forge script script/Deploy.s.sol:Deploy \
 *     --rpc-url https://rpc.test.mezo.org \
 *     --private-key $DEPLOYER_KEY --broadcast
 *
 * Then copy the printed address into src/registry/addresses.ts under the
 * `Delegate7702` contract key for the matching network, and remove it from
 * `needsConfirmation` once verified on the explorer.
 */
contract Deploy is Script {
    function run() external returns (SessionKeyDelegate delegate) {
        vm.startBroadcast();
        delegate = new SessionKeyDelegate();
        vm.stopBroadcast();
        console.log("SessionKeyDelegate deployed at:", address(delegate));
    }
}

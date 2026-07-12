// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Nox, euint256} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

/// @notice Smallest contract that exercises the Nox handle round-trip.
contract Probe {
    euint256 public value;

    constructor(uint256 initial) {
        // `toEuint256` trivially encrypts a plaintext value, which NoxCompute
        // treats as a public handle: it is already publicly decryptable and
        // an explicit `allowPublicDecryption` call would revert with
        // `PublicHandleACLForbidden`.
        value = Nox.toEuint256(initial);
        Nox.allowThis(value);
    }
}

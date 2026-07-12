// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {Nox, euint256} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import {ERC20ToERC7984Wrapper} from "@iexec-nox/nox-confidential-contracts/contracts/token/extensions/ERC20ToERC7984Wrapper.sol";

/**
 * @title OccultaUSDC
 * @notice Confidential ERC-7984 wrapper over the real Aave Sepolia USDC
 * (`0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8`, 6 decimals). This is the ONLY place a
 * value ever crosses between Occulta's encrypted world and plaintext ERC-20 — depositor
 * funds and the agent's strategy stay sealed everywhere else; only the aggregate net
 * order of an epoch is ever unwrapped through it ("confidentiality by aggregation").
 *
 * @dev Thin constructor wiring only. All balance/transfer/wrap/unwrap logic lives in the
 * first-party base contracts and is not reimplemented here. The inherited, load-bearing
 * API (verified against `ERC20ToERC7984WrapperBase` / `IERC20ToERC7984Wrapper` /
 * `ERC7984Base` in the iExec Nox confidential-contracts package) is:
 *
 * - `wrap(address to, uint256 amount) returns (euint256)` — pulls `amount` of the
 *   underlying ERC-20 from the caller via `safeTransferFrom` and mints a confidential
 *   balance of the same amount to `to`. 1:1, no rate conversion.
 * - `unwrap(address from, address to, euint256 amount) returns (euint256 unwrapRequestId)`
 *   and the `externalEuint256`/`inputProof` overload — burns `amount` from `from`'s
 *   confidential balance, calls `Nox.allowPublicDecryption` on the resulting handle, and
 *   emits `UnwrapRequested(address indexed receiver, euint256 amount)`. The caller must be
 *   `from` or an approved operator for `from`.
 * - `finalizeUnwrap(euint256 unwrapRequestId, bytes calldata decryptedAmountAndProof)` —
 *   callable by anyone holding a valid `decryptionProof` for the request (verified on-chain
 *   via `Nox.publicDecrypt`); releases the plaintext ERC-20 to the original recipient and
 *   emits `UnwrapFinalized(address indexed receiver, euint256 encryptedAmount, uint256 plaintextAmount)`.
 * - `confidentialBalanceOf(address account) returns (euint256)` — the account's sealed balance handle.
 * - `underlying() returns (address)` — the wrapped ERC-20's address (NOT `IERC20`; the base
 *   interface declares this as a plain `address`).
 * - `decimals() returns (uint8)` — mirrors the underlying asset's decimals (6 for USDC);
 *   the wrapper never rescales.
 *
 * See `ERC20ToERC7984WrapperBase` for the full inherited surface (operators,
 * `inferredTotalSupply`, `maxTotalSupply`, `unwrapRequester`, ERC-1363 receiver hook, etc).
 */
contract OccultaUSDC is ERC20ToERC7984Wrapper {
    /**
     * @param underlyingUsdc The plaintext ERC-20 being wrapped (the real Aave Sepolia USDC
     * on the deployed product; a test-only mock in unit tests).
     * @param name_ Confidential token name.
     * @param symbol_ Confidential token symbol.
     * @param contractURI_ ERC-7572 contract metadata URI.
     */
    constructor(
        IERC20 underlyingUsdc,
        string memory name_,
        string memory symbol_,
        string memory contractURI_
    ) ERC20ToERC7984Wrapper(name_, symbol_, contractURI_, underlyingUsdc) {}

    /**
     * @notice Returns whether `who` is allowed to decrypt `handle` off-chain.
     * @dev Read-only convenience over `Nox.isAllowed`, exposed so callers (and tests) can
     * verify the wrapper's confidentiality guarantee without needing on-chain write access.
     */
    function isAllowedFor(euint256 handle, address who) external view returns (bool) {
        return Nox.isAllowed(handle, who);
    }
}

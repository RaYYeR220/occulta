// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDC
 * @notice Plaintext, permissionlessly-mintable stand-in for the real Aave Sepolia USDC,
 * used ONLY as the underlying asset in {OccultaUSDC} unit tests. The deployed product
 * always wraps the real Aave USDC (`0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8`); this
 * contract never appears in that path.
 */
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}

    /// @inheritdoc ERC20
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mints `amount` of the mock token to `to`. Unrestricted: test-only asset.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

import "dotenv/config";
import { defineConfig } from "hardhat/config";
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import noxPlugin from "@iexec-nox/nox-hardhat-plugin";

const sepoliaRpcUrl = process.env.SEPOLIA_RPC_URL ?? "";
const deployerPrivateKey = process.env.DEPLOYER_PRIVATE_KEY ?? "";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin, noxPlugin],
  solidity: { version: "0.8.35", settings: { optimizer: { enabled: true, runs: 200 } } },
  verify: {
    etherscan: { apiKey: process.env.ETHERSCAN_API_KEY ?? "" },
  },
  paths: {
    // The default `pnpm hardhat test` run stays scoped to the local Nox-stack unit suite.
    // Fork integration tests (test/integration) hit the real Sepolia RPC and only make sense
    // against `--network sepoliaFork`, so they are run explicitly via `pnpm test:fork`. Both
    // sub-paths are pinned to test/unit (there are no Solidity-native tests in this repo) so a
    // file outside it, like test/integration/Aave.fork.test.ts, isn't swallowed by either
    // runner's directory prefix and can still be targeted explicitly by path.
    tests: { nodejs: "test/unit", solidity: "test/unit" },
  },
  networks: {
    default: { type: "edr-simulated", chainType: "op", allowUnlimitedContractSize: true },
    sepolia: {
      type: "http",
      chainType: "l1",
      chainId: 11155111,
      url: sepoliaRpcUrl,
      accounts: deployerPrivateKey ? [deployerPrivateKey] : [],
    },
    // Forks live ETH Sepolia so the Aave adapter integration tests (test/integration/Aave.fork.test.ts)
    // exercise the REAL, deployed Aave V3 Pool and faucet — never a mock. `chainId` is pinned to
    // Sepolia's so Aave's hardcoded addresses resolve correctly on the forked state. Test accounts
    // are pre-funded by the simulated network, so no real testnet ETH is needed.
    sepoliaFork: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 11155111,
      forking: { url: sepoliaRpcUrl },
    },
  },
});

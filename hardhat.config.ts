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
  networks: {
    default: { type: "edr-simulated", chainType: "op", allowUnlimitedContractSize: true },
    sepolia: {
      type: "http",
      chainType: "l1",
      chainId: 11155111,
      url: sepoliaRpcUrl,
      accounts: deployerPrivateKey ? [deployerPrivateKey] : [],
    },
  },
});

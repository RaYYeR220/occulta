import { defineConfig } from "hardhat/config";
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import noxPlugin from "@iexec-nox/nox-hardhat-plugin";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin, noxPlugin],
  solidity: { version: "0.8.35", settings: { optimizer: { enabled: true, runs: 200 } } },
  networks: {
    default: { type: "edr-simulated", chainType: "op", allowUnlimitedContractSize: true },
  },
});

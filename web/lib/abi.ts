import { parseAbi } from "viem";

/**
 * Hand-trimmed ABIs — only the read functions this app calls. `metaOf` is kept as an explicit
 * tuple-shaped fragment (not `parseAbi`'s human-readable form) because `AgentMeta` is a struct:
 * describing it as flat return values, rather than one tuple output, decodes against the wrong
 * ABI shape and corrupts every field after the addresses. That mismatch is exactly what left
 * `metaOf` unverified in `deployments/sepolia.json`'s own notes — reproduced and fixed here.
 */
export const strategyRegistryAbi = [
  {
    inputs: [{ internalType: "uint256", name: "agentId", type: "uint256" }],
    name: "metaOf",
    outputs: [
      {
        components: [
          { internalType: "address", name: "strategist", type: "address" },
          { internalType: "address", name: "runtime", type: "address" },
          { internalType: "string", name: "name", type: "string" },
          { internalType: "string", name: "mandate", type: "string" },
          { internalType: "bool", name: "active", type: "bool" },
        ],
        internalType: "struct IStrategyRegistry.AgentMeta",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const netSettlerAbi = parseAbi([
  "function currentEpoch(uint256 agentId) view returns (uint256)",
  "function epochStateOf(uint256 agentId, uint256 epoch) view returns (uint256 intentCount, bool closed, bool settled)",
  "function netOf(uint256 agentId, uint256 epoch) view returns (bytes32)",
  "function netDirectionOf(uint256 agentId, uint256 epoch) view returns (bytes32)",
  "function isPubliclyDecryptable(bytes32 handle) view returns (bool)",
]);

export const aaveAdapterAbi = parseAbi([
  "function accountData() view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 healthFactor_)",
]);

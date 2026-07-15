import { parseAbi } from "viem";

/**
 * Hand-trimmed ABI fragments — only what this runtime actually calls. Handles (`euint256`,
 * `ebool`) are represented at the ABI level as `bytes32`, exactly as `scripts/demo.ts` and the
 * `mcp`/`web` packages do; the Nox type only exists at the Solidity level.
 *
 * `metaOf` is kept as an explicit tuple-shaped fragment (not `parseAbi`'s human-readable form)
 * because `AgentMeta` is a struct: describing it as flat return values decodes against the wrong
 * ABI shape (see `mcp/src/abi.ts`'s note on the same bug in the deployment artifact's own
 * verification script).
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
  {
    inputs: [
      { internalType: "uint256", name: "agentId", type: "uint256" },
      { internalType: "uint256", name: "idx", type: "uint256" },
    ],
    name: "policyOf",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
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
  "function submitIntent(uint256 agentId, bytes32 encAmount, bytes amountProof, bytes32 encIsBuy, bytes sideProof)",
  "function closeEpoch(uint256 agentId) returns (bytes32 netHandle, bytes32 netIsBuy)",
  "function settle(uint256 agentId, uint256 epoch, bytes decryptionProof, bytes directionProof, uint256 minOut)",
  "event IntentSubmitted(uint256 indexed agentId, uint256 indexed epoch, address indexed controller)",
  "event EpochClosed(uint256 indexed agentId, uint256 indexed epoch, bytes32 net, bytes32 netIsBuy)",
  "event Settled(uint256 indexed agentId, uint256 indexed epoch, uint256 netPlaintext, bool netIsBuy)",
]);

export const occultaVaultAbi = parseAbi([
  "function confidentialTotalAssets() view returns (bytes32)",
  "function pendingDepositRequest(address controller) view returns (bytes32)",
  "function approveDeposit(bytes32 assets, address owner_)",
  "event DepositRequest(address indexed controller, address indexed owner, uint256 indexed requestId, address sender, bytes32 assets)",
]);

export const aaveAdapterAbi = parseAbi([
  "function accountData() view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 healthFactor_)",
]);

export const occultaExecutorAbi = parseAbi([
  "function fee() view returns (uint24)",
  "event Executed(uint256 indexed agentId, uint256 indexed epoch, bool netIsBuy, uint256 netAmount, uint256 resultAmount)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const faucetAbi = parseAbi([
  "function mint(address token, address to, uint256 amount) returns (uint256)",
]);

export const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

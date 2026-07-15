import { NextResponse } from "next/server";
import { createWalletClient, http } from "viem";
import { sepolia } from "viem/chains";
import { createViemHandleClient } from "@iexec-nox/handle";

import { loadDeployment } from "@/lib/deployment";
import { netSettlerAbi } from "@/lib/abi";
import { sepoliaPublicClient, sepoliaRpcUrl } from "@/lib/chain";
import { formatNetAmount } from "@/lib/format";
import { FEATURED_EPOCH } from "@/lib/reveal";

export const dynamic = "force-dynamic";

/**
 * Runs the real confidential reveal server-side.
 *
 * `@iexec-nox/handle`'s `publicDecrypt` talks to the live Nox gateway (a signed REST call plus
 * an on-chain `isPubliclyDecryptable` read) and to its subgraph — flows this route runs from the
 * server rather than the browser, both because the SDK is written and tested against Node and
 * because it keeps the gateway/subgraph endpoints and any future auth details out of client
 * bundles. No private key is involved anywhere in this path: `net` and `netIsBuy` are marked
 * PUBLICLY decryptable on-chain by `NetSettler.closeEpoch` (see contracts/settle/NetSettler.sol),
 * so `createViemHandleClient` only ever needs a plain read-only viem `WalletClient` pointed at a
 * public RPC — no `account`, no signature, nothing secret.
 *
 * Always decrypts {@link FEATURED_EPOCH} — the documented demo epoch the rest of this page is
 * built around — rather than whichever epoch settled most recently. `NetSettler` settles epochs
 * autonomously, and a later epoch is a real on-chain epoch too, but it can net a different asset
 * entirely (see `lib/reveal.ts`). This is still a genuine live `publicDecrypt`, just of a chosen
 * epoch number instead of an auto-discovered one.
 */
export async function GET() {
  try {
    const deployment = loadDeployment();
    const publicClient = sepoliaPublicClient();
    const epoch = FEATURED_EPOCH;

    const [intentCount, closed, settled] = await publicClient.readContract({
      address: deployment.addresses.netSettler,
      abi: netSettlerAbi,
      functionName: "epochStateOf",
      args: [deployment.agentId, epoch],
    });

    if (!closed || !settled) {
      return NextResponse.json(
        {
          ok: false,
          reason: "no-epoch-settled",
          message: `Featured epoch ${epoch.toString()} has not closed and settled yet.`,
        },
        { status: 200 },
      );
    }

    return await revealEpoch(deployment, publicClient, epoch, intentCount);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        reason: "error",
        message: error instanceof Error ? error.message : "Unknown error while revealing the epoch net.",
      },
      { status: 502 },
    );
  }
}

async function revealEpoch(
  deployment: ReturnType<typeof loadDeployment>,
  publicClient: ReturnType<typeof sepoliaPublicClient>,
  epoch: bigint,
  intentCount: bigint,
) {
  const [netHandle, directionHandle] = await Promise.all([
    publicClient.readContract({
      address: deployment.addresses.netSettler,
      abi: netSettlerAbi,
      functionName: "netOf",
      args: [deployment.agentId, epoch],
    }),
    publicClient.readContract({
      address: deployment.addresses.netSettler,
      abi: netSettlerAbi,
      functionName: "netDirectionOf",
      args: [deployment.agentId, epoch],
    }),
  ]);

  const [netPublic, directionPublic] = await Promise.all([
    publicClient.readContract({
      address: deployment.addresses.netSettler,
      abi: netSettlerAbi,
      functionName: "isPubliclyDecryptable",
      args: [netHandle],
    }),
    publicClient.readContract({
      address: deployment.addresses.netSettler,
      abi: netSettlerAbi,
      functionName: "isPubliclyDecryptable",
      args: [directionHandle],
    }),
  ]);

  if (!netPublic || !directionPublic) {
    return NextResponse.json(
      {
        ok: false,
        reason: "not-public",
        message: "Epoch closed, but the gateway has not yet marked the aggregate publicly decryptable.",
      },
      { status: 200 },
    );
  }

  // A read-only wallet client — transport only, no account — is sufficient here: `publicDecrypt`
  // never signs anything, because the handle is already publicly decryptable on-chain.
  const walletClient = createWalletClient({ chain: sepolia, transport: http(sepoliaRpcUrl()) });
  const handleClient = await createViemHandleClient(walletClient);

  const [netResult, directionResult] = await Promise.all([
    handleClient.publicDecrypt(netHandle),
    handleClient.publicDecrypt(directionHandle),
  ]);

  const netRaw = netResult.value as bigint;
  const isBuy = directionResult.value as boolean;
  const { formatted, unit } = formatNetAmount(netRaw, isBuy);

  return NextResponse.json({
    ok: true,
    agentId: deployment.agentId.toString(),
    epoch: epoch.toString(),
    intentCount: intentCount.toString(),
    net: {
      raw: netRaw.toString(),
      formatted,
      unit,
      isBuy,
    },
    handles: { net: netHandle, direction: directionHandle },
    proof: {
      netDecryptionProof: netResult.decryptionProof,
      directionDecryptionProof: directionResult.decryptionProof,
    },
    netSettler: deployment.addresses.netSettler,
  });
}

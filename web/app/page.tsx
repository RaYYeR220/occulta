import { loadDeployment } from "@/lib/deployment";
import { sepoliaPublicClient } from "@/lib/chain";
import { strategyRegistryAbi, netSettlerAbi, aaveAdapterAbi } from "@/lib/abi";
import { FEATURED_EPOCH } from "@/lib/reveal";
import { SiteHeader } from "@/components/SiteHeader";
import { Hero } from "@/components/Hero";
import { RevealProvider } from "@/components/RevealContext";
import { RevealPanel } from "@/components/RevealPanel";
import { AgentSection, type AaveAccountData, type AgentMeta } from "@/components/AgentSection";
import { NettingSection } from "@/components/NettingSection";
import { ProofStrip } from "@/components/ProofStrip";
import { SiteFooter } from "@/components/SiteFooter";

export const dynamic = "force-dynamic";

async function readAgentMeta(): Promise<AgentMeta | null> {
  try {
    const deployment = loadDeployment();
    const publicClient = sepoliaPublicClient();
    const meta = await publicClient.readContract({
      address: deployment.addresses.strategyRegistry,
      abi: strategyRegistryAbi,
      functionName: "metaOf",
      args: [deployment.agentId],
    });
    return meta;
  } catch {
    return null;
  }
}

async function readAaveAccountData(): Promise<AaveAccountData | null> {
  try {
    const deployment = loadDeployment();
    const publicClient = sepoliaPublicClient();
    const [totalCollateralBase, totalDebtBase, availableBorrowsBase, healthFactor] =
      await publicClient.readContract({
        address: deployment.addresses.aaveAdapter,
        abi: aaveAdapterAbi,
        functionName: "accountData",
      });
    return { totalCollateralBase, totalDebtBase, availableBorrowsBase, healthFactor };
  } catch {
    return null;
  }
}

// Reads the same featured epoch the reveal card decrypts (see `lib/reveal.ts`), so the netting
// section's "epoch N · M intents folded" caption always describes the epoch the diagram above it
// and the reveal card below it are both talking about, rather than whatever settled most
// recently.
async function readFeaturedEpoch(): Promise<{ epoch: string; intentCount: string } | null> {
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
    if (!closed || !settled) return null;
    return { epoch: epoch.toString(), intentCount: intentCount.toString() };
  } catch {
    return null;
  }
}

export default async function Home() {
  const deployment = loadDeployment();
  const [meta, aave, featuredEpoch] = await Promise.all([
    readAgentMeta(),
    readAaveAccountData(),
    readFeaturedEpoch(),
  ]);

  return (
    <>
      <div className="mesh" aria-hidden />
      <div className="grain" aria-hidden />
      <div className="vignette" aria-hidden />

      <SiteHeader />

      <main>
        <Hero />

        <RevealProvider>
          <section className="reveal-section" id="reveal">
            <div className="wrap">
              <RevealPanel />
            </div>
          </section>

          <AgentSection
            agentId={deployment.agentId.toString()}
            meta={meta}
            aave={aave}
            registryAddress={deployment.addresses.strategyRegistry}
            aaveAdapterAddress={deployment.addresses.aaveAdapter}
          />

          <NettingSection
            epoch={featuredEpoch?.epoch ?? null}
            intentCount={featuredEpoch?.intentCount ?? null}
          />
        </RevealProvider>

        <ProofStrip addresses={deployment.addresses} />
      </main>

      <SiteFooter />
    </>
  );
}

import { formatHealthFactor, formatUsdBase, shortAddress } from "@/lib/format";
import { etherscanAddress } from "@/lib/links";
import type { Address } from "viem";

export interface AgentMeta {
  strategist: Address;
  runtime: Address;
  name: string;
  mandate: string;
  active: boolean;
}

export interface AaveAccountData {
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  availableBorrowsBase: bigint;
  healthFactor: bigint;
}

export function AgentSection({
  agentId,
  meta,
  aave,
  registryAddress,
  aaveAdapterAddress,
}: {
  agentId: string;
  meta: AgentMeta | null;
  aave: AaveAccountData | null;
  registryAddress: Address;
  aaveAdapterAddress: Address;
}) {
  return (
    <section id="agent">
      <div className="wrap">
        <div className="section-head">
          <span className="eyebrow">The vault</span>
          <h2>Strategy sealed, capital working.</h2>
          <p>
            The agent runs inside a TEE — its policy never touches daylight. What surfaces is its
            public mandate and the real, on-chain position it executed.
          </p>
        </div>

        {meta ? (
          <div className="agent-card">
            <div className="agent-top">
              <div>
                <h3>{meta.name}</h3>
                <div className="agent-id">
                  Agent {agentId} ·{" "}
                  <a href={etherscanAddress(registryAddress)} target="_blank" rel="noreferrer">
                    StrategyRegistry ↗
                  </a>
                </div>
              </div>
              <div className="badges">
                <span className="seal">
                  <span className="dot" aria-hidden />
                  TEE-attested
                </span>
                <span className={`seal muted`}>{meta.active ? "Active" : "Inactive"}</span>
              </div>
            </div>

            <p className="agent-mandate">{meta.mandate}</p>

            <div className="strategy-block" aria-hidden>
              <div className="line" />
              <div className="line" />
              <div className="line" />
            </div>
            <div className="strategy-caption">
              Strategy: sealed — runtime {shortAddress(meta.runtime)} holds the only decrypt grant
            </div>

            <div className="agent-stats">
              <div className="stat">
                <div className="k">Capital at work (Aave)</div>
                <div className="v up">
                  {aave ? `$${formatUsdBase(aave.totalCollateralBase)}` : "unavailable"}
                </div>
                <div className="note">
                  Real Aave V3 collateral, read live via{" "}
                  <a href={etherscanAddress(aaveAdapterAddress)} target="_blank" rel="noreferrer">
                    AaveAdapter.accountData() ↗
                  </a>
                </div>
              </div>
              <div className="stat">
                <div className="k">Health factor</div>
                <div className="v">{aave ? formatHealthFactor(aave.healthFactor) : "unavailable"}</div>
                <div className="note">Aave&apos;s own zero-debt convention when there is no borrow.</div>
              </div>
            </div>
          </div>
        ) : (
          <div className="data-unavailable">
            Could not read agent {agentId} from StrategyRegistry on Sepolia right now — the RPC may
            be rate-limited. No illustrative figures are shown in its place.
          </div>
        )}
      </div>
    </section>
  );
}

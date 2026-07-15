import type { Address } from "viem";
import {
  CLOSE_EPOCH_TX_HASH,
  REGISTER_AGENT_TX_HASH,
  SAMPLE_INTENT_TX_HASH,
  SETTLE_TX_HASH,
  etherscanAddress,
  etherscanTx,
  verifiedContracts,
} from "@/lib/links";
import type { OccultaAddresses } from "@/lib/deployment.types";

export function ProofStrip({ addresses }: { addresses: OccultaAddresses }) {
  const contracts = verifiedContracts(addresses);

  return (
    <section id="proof" className="proof-section">
      <div className="wrap">
        <div className="section-head">
          <span className="eyebrow">Live proof</span>
          <h2>Not a simulation.</h2>
        </div>

        <div className="proof-strip">
          <ProofItem k="Network" v="Sepolia — chain 11155111" />
          <ProofItem k="Contracts" v="8 / 8 deployed & verified" />
          <ProofItem k="Settlement" v="Real Uniswap V3 swap + real Aave V3 supply" />
          <ProofItem k="Aave collateral" v="$0.00 → $39.06" />
          <ProofItem k="Mocks" v="Zero" />
        </div>

        <div className="contracts-grid">
          {contracts.map((c) => (
            <a
              key={c.address}
              className="contract-link"
              href={etherscanAddress(c.address as Address)}
              target="_blank"
              rel="noreferrer"
            >
              <span>{c.name}</span>
              <span className="addr">{c.address.slice(0, 6)}…{c.address.slice(-4)}</span>
            </a>
          ))}
        </div>

        <div className="tx-strip">
          <a className="tx-chip" href={etherscanTx(REGISTER_AGENT_TX_HASH)} target="_blank" rel="noreferrer">
            registerAgent ↗
          </a>
          <a className="tx-chip" href={etherscanTx(SAMPLE_INTENT_TX_HASH)} target="_blank" rel="noreferrer">
            submitIntent ↗
          </a>
          <a className="tx-chip" href={etherscanTx(CLOSE_EPOCH_TX_HASH)} target="_blank" rel="noreferrer">
            closeEpoch ↗
          </a>
          <a className="tx-chip" href={etherscanTx(SETTLE_TX_HASH)} target="_blank" rel="noreferrer">
            settle → real Uniswap + Aave ↗
          </a>
        </div>
      </div>
    </section>
  );
}

function ProofItem({ k, v }: { k: string; v: string }) {
  return (
    <div className="proof-item">
      <span className="v">{v}</span>
      <span className="k">{k}</span>
    </div>
  );
}

import { etherscanTx, SAMPLE_INTENT_TX_HASH, CLOSE_EPOCH_TX_HASH } from "@/lib/links";
import { NettingAggregate } from "@/components/NettingAggregate";

export function NettingSection({
  epoch,
  intentCount,
}: {
  epoch: string | null;
  intentCount: string | null;
}) {
  return (
    <section id="netting">
      <div className="wrap">
        <div className="section-head">
          <span className="eyebrow">Per epoch</span>
          <h2>One number leaves the vault.</h2>
          <p>
            Confidentiality by aggregation: every depositor&apos;s intent — size and side — is
            folded into two encrypted running totals inside the TEE. Closing the epoch reveals
            only their difference. A net of 30 could be one depositor buying 30, or a crowd
            netting to it — nothing in the aggregate tells you which.
          </p>
        </div>

        <div className="netting">
          <div className="intents">
            <div className="intent buy">
              <span className="side">BUY</span>
              <span className="seal" aria-hidden />
              <span className="amount">20.00</span>
            </div>
            <div className="intent buy">
              <span className="side">BUY</span>
              <span className="seal" aria-hidden />
              <span className="amount">15.00</span>
            </div>
            <div className="intent sell">
              <span className="side">SELL</span>
              <span className="seal" aria-hidden />
              <span className="amount">5.00</span>
              <a
                className="tx-link"
                href={etherscanTx(SAMPLE_INTENT_TX_HASH)}
                target="_blank"
                rel="noreferrer"
              >
                sample tx ↗
              </a>
            </div>
          </div>

          <div className="flow" aria-hidden>
            <div className="pulse" />
            <div className="pulse" />
            <div className="pulse" />
          </div>

          <div className="aggregate">
            <div className="k">Net epoch settlement</div>
            <NettingAggregate />
          </div>
        </div>

        <p className="netting-caption">The chain learns exactly one number per epoch.</p>
        <p className="netting-meta">
          {intentCount && epoch
            ? `epoch ${epoch} · ${intentCount} intents folded, read live via epochStateOf · `
            : ""}
          sizes and sides shown at left are the documented proof run (buy 20, buy 15, sell 5) —
          never independently re-checkable after the fact, since <code>NetSettler</code> emits no
          handle in <code>IntentSubmitted</code> by design.{" "}
          <a href={etherscanTx(CLOSE_EPOCH_TX_HASH)} target="_blank" rel="noreferrer">
            closeEpoch tx ↗
          </a>
        </p>
      </div>
    </section>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { useReveal } from "@/components/RevealContext";
import { scrambleInto } from "@/lib/scramble";
import { etherscanTx, SAMPLE_INTENT_TX_HASH } from "@/lib/links";

export function RevealPanel() {
  const { status, data, errorMessage, request } = useReveal();
  const [revealed, setRevealed] = useState(false);
  const [displayText, setDisplayText] = useState("");
  const stopRef = useRef<() => void>(() => {});
  const delayRef = useRef<number | null>(null);

  const ready = status === "ready" && data?.ok;

  // Cancel any in-flight scramble frame loop and the pre-scramble delay, so a re-entrant toggle
  // never races a stale animation against the one just started (or against unmount).
  function stopAnimation() {
    if (delayRef.current !== null) {
      window.clearTimeout(delayRef.current);
      delayRef.current = null;
    }
    stopRef.current();
    stopRef.current = () => {};
  }

  useEffect(() => stopAnimation, []);

  function handleReveal() {
    if (revealed) {
      stopAnimation();
      setRevealed(false);
      setDisplayText("");
      return;
    }
    if (!ready) {
      request();
      return;
    }
    stopAnimation();
    setRevealed(true);

    const finalText = `${data.net.formatted} USDC · ${data.net.isBuy ? "BUY" : "SELL"}`;
    delayRef.current = window.setTimeout(() => {
      delayRef.current = null;
      stopRef.current = scrambleInto(finalText, setDisplayText, 780);
    }, 140);
  }

  return (
    <div className="reveal-card">
      <div className="reveal-label">
        {ready ? `Epoch ${data.epoch} · Aggregate net order` : "Latest settled epoch · Aggregate net order"}
      </div>

      <div className={`stage${revealed ? " revealed" : ""}`}>
        <div className="glow" />
        {revealed ? (
          <div className="reveal-value" aria-live="polite">
            {displayText}
          </div>
        ) : (
          <div className="reveal-veil">
            <span className="dot" aria-hidden />
            <span>
              {status === "loading" && "connecting to the live Nox gateway…"}
              {status === "idle" && "sealed"}
              {status === "ready" && "sealed — decrypted and waiting"}
              {status === "empty" && "no settled epoch to reveal"}
              {status === "error" && "gateway unreachable"}
            </span>
          </div>
        )}
      </div>

      <button
        type="button"
        className="reveal-btn"
        onClick={handleReveal}
        disabled={status === "loading" || status === "empty"}
        aria-pressed={revealed}
      >
        {status === "loading"
          ? "decrypting…"
          : revealed
            ? "Conceal"
            : status === "empty"
              ? "no epoch settled yet"
              : "Reveal the epoch net"}
      </button>

      <div className="reveal-foot">
        {ready && (
          <>
            Decrypted from <code>NetSettler.netOf</code> via a live <code>publicDecrypt</code> call
            to the Nox gateway — <span className="ok">not a stored or hardcoded value.</span>
          </>
        )}
        {status === "error" && errorMessage && <span>{errorMessage}</span>}
        {status === "empty" && errorMessage && <span>{errorMessage}</span>}
      </div>

      <div className="privacy-note">
        <strong>What the chain never learns:</strong> the three intents behind this aggregate —
        their sizes and their buy/sell sides — are never marked publicly decryptable on{" "}
        <code>NetSettler</code>, by contract design (see <code>NetSettler.sol</code>). In the proof
        run behind this deployment, calling <code>publicDecrypt</code> directly on an individual
        intent&apos;s handle was rejected by the gateway; only the epoch&apos;s aggregate — the
        number above — was ever opened. Verify the intent submission itself on-chain:{" "}
        <a href={etherscanTx(SAMPLE_INTENT_TX_HASH)} target="_blank" rel="noreferrer">
          submitIntent tx ↗
        </a>
      </div>
    </div>
  );
}

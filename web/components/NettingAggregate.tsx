"use client";

import { useEffect, useRef, useState } from "react";
import { useReveal } from "@/components/RevealContext";
import { scrambleInto } from "@/lib/scramble";

/**
 * Mirrors the same live-decrypted aggregate the reveal panel shows — one fetch, one number,
 * shown in both places, because there is only one reveal event per epoch. Animates in once the
 * netting diagram scrolls into view, independent of whether the visitor has already clicked
 * "Reveal" above.
 */
export function NettingAggregate() {
  const { status, data } = useReveal();
  const elRef = useRef<HTMLDivElement | null>(null);
  const firedRef = useRef(false);
  const stopRef = useRef<() => void>(() => {});
  const [scrambled, setScrambled] = useState<string | null>(null);

  useEffect(() => {
    if (status !== "ready" || !data?.ok || firedRef.current) return;
    const el = elRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && !firedRef.current) {
          firedRef.current = true;
          const finalText = `Net · ${data.net.formatted} ${data.net.unit} · ${data.net.isBuy ? "Buy" : "Sell"}`;
          stopRef.current = scrambleInto(finalText, setScrambled, 780);
          observer.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      stopRef.current();
      stopRef.current = () => {};
    };
  }, [status, data]);

  const fallback =
    status === "loading"
      ? "sealing…"
      : status === "idle"
        ? "sealed"
        : status === "empty"
          ? "no epoch yet"
          : status === "error"
            ? "gateway unreachable"
            : "";

  return (
    <div className="v" ref={elRef}>
      {scrambled ?? fallback}
    </div>
  );
}

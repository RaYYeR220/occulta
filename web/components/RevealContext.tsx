"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { RevealResponse } from "@/lib/types";

type Status = "idle" | "loading" | "ready" | "empty" | "error";

interface RevealState {
  status: Status;
  data: RevealResponse | null;
  errorMessage: string | null;
  fetchedOnce: boolean;
  request: () => void;
}

const RevealCtx = createContext<RevealState | null>(null);

export function RevealProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("idle");
  const [data, setData] = useState<RevealResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const inFlight = useRef(false);

  const request = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStatus("loading");
    setErrorMessage(null);

    fetch("/api/reveal", { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json()) as RevealResponse;
        setData(body);
        if (body.ok) {
          setStatus("ready");
        } else if (body.reason === "no-epoch-settled" || body.reason === "not-public") {
          setStatus("empty");
          setErrorMessage(body.message);
        } else {
          setStatus("error");
          setErrorMessage(body.message);
        }
      })
      .catch((error: unknown) => {
        setStatus("error");
        setErrorMessage(error instanceof Error ? error.message : "The reveal request failed.");
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, []);

  // Fetch the real decrypted aggregate as soon as the page is interactive — the number is
  // already public on-chain, so there is nothing to gate behind a click. The click below only
  // gates the *animation*, i.e. the moment the visitor chooses to look.
  useEffect(() => {
    request();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <RevealCtx.Provider
      value={{ status, data, errorMessage, fetchedOnce: status !== "idle", request }}
    >
      {children}
    </RevealCtx.Provider>
  );
}

export function useReveal(): RevealState {
  const ctx = useContext(RevealCtx);
  if (!ctx) throw new Error("useReveal must be used within a RevealProvider");
  return ctx;
}

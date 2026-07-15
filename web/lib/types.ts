export interface RevealSuccess {
  ok: true;
  agentId: string;
  epoch: string;
  intentCount: string;
  net: {
    raw: string;
    formatted: string;
    isBuy: boolean;
  };
  handles: { net: string; direction: string };
  proof: { netDecryptionProof: string; directionDecryptionProof: string };
  netSettler: string;
}

export interface RevealFailure {
  ok: false;
  reason: "no-epoch-settled" | "not-public" | "error";
  message: string;
}

export type RevealResponse = RevealSuccess | RevealFailure;

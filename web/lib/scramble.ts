const SCRAMBLE_CHARS = "0123456789ABCDEF";
const STATIC_CHARS = new Set([" ", ".", ",", "·", "$"]);

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Hex-noise decrypt effect: scrambles through random hex glyphs, resolving left-to-right into
 * the real, already-fetched plaintext. Ported from the noir-dossier reveal interaction and
 * restyled for the obsidian palette.
 *
 * Deliberately DOM-free: it never touches an element directly (no `textContent` writes). Each
 * frame is handed to `onFrame` instead, so the caller can push it through React state and let
 * React own the text node exclusively. Driving this by direct DOM mutation on a React-rendered
 * node caused the two renderers to fight over the same child (React re-diffing text nodes the
 * animation had already replaced underneath it), which surfaced as intermittent
 * `removeChild: node is not a child of this node` errors on repeated reveal/conceal. Returning a
 * cancel function — and having the caller invoke it before starting a new run and on unmount —
 * keeps repeated toggles idempotent.
 */
export function scrambleInto(
  finalText: string,
  onFrame: (text: string) => void,
  duration = 750,
  onDone?: () => void,
): () => void {
  if (prefersReducedMotion()) {
    onFrame(finalText);
    onDone?.();
    return () => {};
  }

  let start: number | null = null;
  let frame = 0;
  let cancelled = false;

  function step(ts: number) {
    if (cancelled) return;
    if (start === null) start = ts;
    const progress = Math.min((ts - start) / duration, 1);
    let out = "";
    for (let i = 0; i < finalText.length; i++) {
      const ch = finalText[i] as string;
      if (STATIC_CHARS.has(ch)) {
        out += ch;
        continue;
      }
      const revealAt = (i + 1) / finalText.length;
      out += progress > revealAt ? ch : SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
    }
    if (cancelled) return;
    onFrame(out);
    if (progress < 1) {
      frame = requestAnimationFrame(step);
    } else {
      onFrame(finalText);
      onDone?.();
    }
  }

  frame = requestAnimationFrame(step);
  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
  };
}

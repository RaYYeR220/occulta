const SCRAMBLE_CHARS = "0123456789ABCDEF";
const STATIC_CHARS = new Set([" ", ".", ",", "·", "$"]);

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Hex-noise decrypt effect: scrambles through random hex glyphs, resolving left-to-right into
 * the real, already-fetched plaintext. Ported from the noir-dossier reveal interaction and
 * restyled for the obsidian palette — ported as a technique (progressive per-character resolve
 * driven by `requestAnimationFrame`), not copy-pasted, since it now runs against a React ref
 * instead of a raw DOM query.
 */
export function scrambleInto(
  el: HTMLElement,
  finalText: string,
  duration = 750,
  onDone?: () => void,
): () => void {
  if (prefersReducedMotion()) {
    el.textContent = finalText;
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
    el.textContent = out;
    if (progress < 1) {
      frame = requestAnimationFrame(step);
    } else {
      el.textContent = finalText;
      onDone?.();
    }
  }

  frame = requestAnimationFrame(step);
  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
  };
}

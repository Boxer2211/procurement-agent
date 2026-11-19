/** Human-readable trace table for the CLI. */

import type { TraceStep } from "../db/stores.js";

function short(value: unknown, max = 110): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function formatTrace(steps: readonly TraceStep[]): string {
  const rows = steps.map((s) => {
    const tokens = s.inputTokens !== null ? ` ${s.inputTokens}→${s.outputTokens} tok` : "";
    const detail = s.error ? `ERROR ${short(s.error)}` : short(s.input ?? s.output);
    return `${String(s.seq).padStart(3)}  ${s.node.padEnd(8)} ${s.kind.padEnd(5)} ${s.name.padEnd(24)} ${String(s.durationMs).padStart(6)}ms${tokens}  ${detail}`;
  });
  return ["seq  node     kind  step                     duration  detail", ...rows].join("\n");
}

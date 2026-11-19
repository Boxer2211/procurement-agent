/** Storage interfaces. Postgres and in-memory implementations live next to this file. */

import type { BudgetRecord, VendorRecord } from "./referenceData.js";

export interface DataStore {
  getBudget(department: string, category: string, period: string): Promise<BudgetRecord | null>;
  findVendor(name: string): Promise<VendorRecord | null>;
}

export type StepKind = "llm" | "tool" | "guard" | "rule" | "info";

export interface TraceStep {
  seq: number;
  node: string;
  kind: StepKind;
  name: string;
  input: unknown;
  output: unknown;
  error: string | null;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  at: string;
}

export interface RunRecord {
  runId: string;
  createdAt: string;
  finishedAt: string | null;
  inputText: string;
  status: string | null;
  decision: string | null;
  promptVersion: string;
  agentModel: string | null;
  verifierModel: string | null;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  result: unknown;
  humanDecision: unknown;
}

export type RunStart = Pick<
  RunRecord,
  "runId" | "inputText" | "promptVersion" | "agentModel" | "verifierModel"
>;
export type RunFinish = Pick<
  RunRecord,
  "status" | "decision" | "durationMs" | "inputTokens" | "outputTokens" | "result"
>;

export interface TraceStore {
  startRun(run: RunStart): Promise<void>;
  appendSteps(runId: string, steps: readonly TraceStep[]): Promise<void>;
  finishRun(runId: string, finish: RunFinish): Promise<void>;
  saveHumanDecision(runId: string, decision: unknown): Promise<void>;
  getRun(runId: string): Promise<RunRecord | null>;
  getSteps(runId: string): Promise<TraceStep[]>;
}

// --------------------------------------------------------------------------- vendor matching

const LEGAL_SUFFIXES = /\b(inc|llc|ltd|limited|gmbh|corp|corporation|co|plc|sa|ag)\b\.?/g;

export function normalizeVendorName(name: string): string {
  return name
    .toLowerCase()
    .replace(LEGAL_SUFFIXES, "")
    .replace(/[^a-z0-9]/g, "");
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Dice coefficient over character trigrams (0..1). */
export function similarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return (2 * common) / (ta.size + tb.size);
}

export const VENDOR_MATCH_THRESHOLD = 0.6;

/** Exact match on normalised name/aliases first, then the best fuzzy match above the threshold. */
export function matchVendor(
  vendors: readonly VendorRecord[],
  query: string,
): { vendor: VendorRecord; score: number } | null {
  const q = normalizeVendorName(query);
  if (!q) return null;
  for (const v of vendors) {
    if ([v.name, ...v.aliases].some((n) => normalizeVendorName(n) === q)) {
      return { vendor: v, score: 1 };
    }
  }
  let best: { vendor: VendorRecord; score: number } | null = null;
  for (const v of vendors) {
    for (const n of [v.name, ...v.aliases]) {
      const score = similarity(normalizeVendorName(n), q);
      if (score >= VENDOR_MATCH_THRESHOLD && (!best || score > best.score)) {
        best = { vendor: v, score };
      }
    }
  }
  return best;
}

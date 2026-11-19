/** Load policy files, quarantine chunks that look like prompt injection, index the rest. */

import { detectInjection } from "../guardrails/injection.js";
import { logger } from "../observability/logger.js";
import { loadPolicyDir, type PolicyChunk } from "./chunker.js";
import type { PolicyIndex } from "./store.js";

export interface IngestReport {
  indexed: number;
  quarantined: string[];
}

/** Mark chunks that contain instruction-like text aimed at the AI (indirect injection). */
export function quarantineSuspicious(chunks: readonly PolicyChunk[]): PolicyChunk[] {
  return chunks.map((c) => {
    const hits = detectInjection(`${c.heading}\n${c.text}`);
    if (hits.length === 0) return c;
    logger.warn({ chunkId: c.chunkId, signals: hits }, "policy_chunk_quarantined");
    return { ...c, quarantined: true, quarantineReason: hits.join(",") };
  });
}

export async function ingestChunks(
  chunks: readonly PolicyChunk[],
  index: PolicyIndex,
): Promise<IngestReport> {
  const checked = quarantineSuspicious(chunks);
  await index.upsert(checked);
  const report: IngestReport = {
    indexed: checked.filter((c) => !c.quarantined).length,
    quarantined: checked.filter((c) => c.quarantined).map((c) => c.chunkId),
  };
  logger.info(report, "policies_ingested");
  return report;
}

export function ingestDirectory(directory: string, index: PolicyIndex): Promise<IngestReport> {
  return ingestChunks(loadPolicyDir(directory), index);
}

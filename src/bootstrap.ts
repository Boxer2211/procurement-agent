/** Wire settings -> stores, LLM, tools, checkpointer, service. */

import { type BaseCheckpointSaver, MemorySaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type pg from "pg";
import { budgetPeriod, type Settings } from "./config.js";
import { MemoryDataStore, MemoryTraceStore } from "./db/memory.js";
import { createPool, PgDataStore, PgTraceStore } from "./db/postgres.js";
import {
  loadBudgets,
  loadReferenceData,
  loadVendors,
  type ReferenceData,
} from "./db/referenceData.js";
import type { DataStore, TraceStore } from "./db/stores.js";
import { ReviewService } from "./graph/service.js";
import { AnthropicLLM } from "./llm/client.js";
import type { LLMClient } from "./llm/types.js";
import { TransformersEmbedder } from "./rag/embedder.js";
import { ingestDirectory } from "./rag/ingest.js";
import { InMemoryPolicyIndex, PgPolicyIndex, type PolicyIndex } from "./rag/store.js";
import { defaultTools, ToolRegistry } from "./tools/registry.js";

export interface AppContext {
  settings: Settings;
  ref: ReferenceData;
  data: DataStore;
  policies: PolicyIndex;
  traces: TraceStore;
  service: ReviewService;
  close(): Promise<void>;
}

export interface BootstrapOverrides {
  llm?: LLMClient;
  now?: Date;
  retryInitialIntervalMs?: number;
}

export async function bootstrap(
  settings: Settings,
  overrides: BootstrapOverrides = {},
): Promise<AppContext> {
  const ref = loadReferenceData(settings.DATA_DIR);
  let data: DataStore;
  let policies: PolicyIndex;
  let traces: TraceStore;
  let checkpointer: BaseCheckpointSaver;
  let pool: pg.Pool | null = null;

  if (settings.STORAGE === "memory") {
    data = new MemoryDataStore(loadBudgets(settings.DATA_DIR), loadVendors(settings.DATA_DIR));
    const index = new InMemoryPolicyIndex();
    await ingestDirectory(`${settings.DATA_DIR}/policies`, index);
    policies = index;
    traces = new MemoryTraceStore();
    checkpointer = new MemorySaver();
  } else {
    pool = createPool(settings.DATABASE_URL);
    data = new PgDataStore(pool);
    policies = new PgPolicyIndex(pool, new TransformersEmbedder(settings.EMBEDDING_MODEL));
    traces = new PgTraceStore(pool);
    const saver = PostgresSaver.fromConnString(settings.DATABASE_URL);
    await saver.setup();
    checkpointer = saver;
  }

  const llm = overrides.llm ?? new AnthropicLLM(settings);
  const now = overrides.now ?? new Date();
  const tools = new ToolRegistry(defaultTools, {
    data,
    policies,
    ref,
    budgetPeriod: budgetPeriod(settings, now),
    today: now.toISOString().slice(0, 10),
  });
  const service = new ReviewService({
    graphDeps: { llm, tools, settings, retryInitialIntervalMs: overrides.retryInitialIntervalMs },
    ref,
    traces,
    checkpointer,
    runTimeoutMs: settings.RUN_TIMEOUT_MS,
  });

  return {
    settings,
    ref,
    data,
    policies,
    traces,
    service,
    async close() {
      if (checkpointer instanceof PostgresSaver) await checkpointer.end();
      await pool?.end();
    },
  };
}

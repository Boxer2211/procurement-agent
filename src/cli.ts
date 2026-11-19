#!/usr/bin/env node
/** CLI: review / seed / ingest / search / serve / graph. */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { z } from "zod";
import { buildServer } from "./api/server.js";
import { type AppContext, bootstrap } from "./bootstrap.js";
import { loadSettings, type Settings } from "./config.js";
import { applySchema, createPool, PgDataStore } from "./db/postgres.js";
import { loadBudgets, loadVendors } from "./db/referenceData.js";
import { CategorySchema, RequestContextSchema } from "./domain/schemas.js";
import { LLMScriptSchema, ScriptedFakeLLM } from "./llm/fake.js";
import { formatTrace } from "./observability/format.js";
import { TransformersEmbedder } from "./rag/embedder.js";
import { ingestDirectory } from "./rag/ingest.js";
import { InMemoryPolicyIndex, PgPolicyIndex, type PolicyIndex } from "./rag/store.js";

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

const SampleInputSchema = z.object({
  request: z.string(),
  context: RequestContextSchema.optional(),
});

function settingsFrom(opts: { memory?: boolean }): Settings {
  return loadSettings({ ...process.env, ...(opts.memory ? { STORAGE: "memory" } : {}) });
}

async function withApp<T>(
  settings: Settings,
  fn: (app: AppContext) => Promise<T>,
  scriptPath?: string,
): Promise<T> {
  const llm = scriptPath
    ? new ScriptedFakeLLM(LLMScriptSchema.parse(readJson(scriptPath)))
    : undefined;
  if (!llm && !settings.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set (or pass --script <file> for an offline run).");
  }
  const app = await bootstrap(settings, llm ? { llm } : {});
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

const program = new Command()
  .name("procurement-agent")
  .description("AI pre-approval checks for purchase requests");

program
  .command("review")
  .description("Review a purchase request")
  .argument("[text...]", "request text (or use --sample)")
  .option("--sample <file>", "read request and context from a samples/inputs/*.json file")
  .option("--json", "print the JSON result only")
  .option("--trace", "print the step trace")
  .option("--context <json>", 'request context JSON, e.g. \'{"costCenter":"ENG-1"}\'')
  .option("--script <file>", "use a scripted fake LLM (offline demo, no API key)")
  .option("--memory", "use in-memory storage (no Docker)")
  .action(
    async (
      words: string[],
      opts: {
        json?: boolean;
        trace?: boolean;
        context?: string;
        sample?: string;
        script?: string;
        memory?: boolean;
      },
    ) => {
      const sample = opts.sample ? SampleInputSchema.parse(readJson(opts.sample)) : null;
      const text = words.length > 0 ? words.join(" ") : (sample?.request ?? "");
      if (!text.trim()) {
        program.error(
          "error: give the request text or --sample <file>, e.g. review --sample samples/inputs/laptops_needs_info.json",
        );
      }
      const context = opts.context
        ? RequestContextSchema.parse(JSON.parse(opts.context))
        : (sample?.context ?? null);
      await withApp(
        settingsFrom(opts),
        async (app) => {
          const { result } = await app.service.review(text, context);
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(result.summary);
            console.log(`\nrun_id: ${result.run_id}`);
          }
          if (opts.trace) {
            console.log(`\n${formatTrace(await app.service.getTrace(result.run_id))}`);
            if (!opts.json) console.log(`\n${JSON.stringify(result, null, 2)}`);
          }
        },
        opts.script,
      );
    },
  );

program
  .command("seed")
  .description("Apply the schema and load budgets, vendors and policies into Postgres")
  .action(async () => {
    const settings = settingsFrom({});
    const pool = createPool(settings.DATABASE_URL);
    try {
      await applySchema(pool);
      const store = new PgDataStore(pool);
      await store.upsertBudgets(loadBudgets(settings.DATA_DIR));
      await store.upsertVendors(loadVendors(settings.DATA_DIR));
      const index = new PgPolicyIndex(pool, new TransformersEmbedder(settings.EMBEDDING_MODEL));
      const report = await ingestDirectory(`${settings.DATA_DIR}/policies`, index);
      console.log(
        `Seeded: budgets, vendors, ${report.indexed} policy chunks (${report.quarantined.length} quarantined).`,
      );
    } finally {
      await pool.end();
    }
  });

async function policyIndex(
  settings: Settings,
): Promise<{ index: PolicyIndex; close: () => Promise<void> }> {
  if (settings.STORAGE === "memory") {
    const index = new InMemoryPolicyIndex();
    await ingestDirectory(`${settings.DATA_DIR}/policies`, index);
    return { index, close: async () => {} };
  }
  const pool = createPool(settings.DATABASE_URL);
  return {
    index: new PgPolicyIndex(pool, new TransformersEmbedder(settings.EMBEDDING_MODEL)),
    close: () => pool.end(),
  };
}

program
  .command("ingest")
  .description("Re-index policy documents")
  .argument("[dir]", "policy directory")
  .action(async (dir?: string) => {
    const settings = settingsFrom({});
    const { index, close } = await policyIndex(settings);
    try {
      const report = await ingestDirectory(dir ?? `${settings.DATA_DIR}/policies`, index);
      console.log(JSON.stringify(report, null, 2));
    } finally {
      await close();
    }
  });

program
  .command("search")
  .description("Search policies (debug retrieval)")
  .argument("<query...>")
  .option("--category <category>", "hardware | software | services | other")
  .option("--top-k <n>", "results", "5")
  .option("--memory", "use the in-memory BM25 index")
  .action(async (words: string[], opts: { category?: string; topK: string; memory?: boolean }) => {
    const settings = settingsFrom(opts);
    const { index, close } = await policyIndex(settings);
    try {
      const hits = await index.search(words.join(" "), {
        category: opts.category ? CategorySchema.parse(opts.category) : null,
        topK: Number.parseInt(opts.topK, 10),
      });
      for (const h of hits)
        console.log(`${h.score.toFixed(3)}  ${h.chunk.chunkId.padEnd(16)} ${h.chunk.heading}`);
    } finally {
      await close();
    }
  });

program
  .command("serve")
  .description("Start the HTTP API")
  .option("--host <host>", "host", "127.0.0.1")
  .option("--port <port>", "port", "8000")
  .option("--memory", "use in-memory storage (no Docker)")
  .action(async (opts: { host: string; port: string; memory?: boolean }) => {
    const settings = settingsFrom(opts);
    if (!settings.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set.");
    const app = await bootstrap(settings);
    const server = buildServer(app.service);
    const shutdown = async () => {
      await server.close();
      await app.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await server.listen({ host: opts.host, port: Number.parseInt(opts.port, 10) });
    console.log(`Listening on http://${opts.host}:${opts.port}`);
  });

program
  .command("graph")
  .description("Print the LangGraph workflow as a Mermaid diagram")
  .action(async () => {
    const settings = loadSettings({ ...process.env, STORAGE: "memory" });
    const app = await bootstrap(settings, { llm: new ScriptedFakeLLM({}) });
    console.log(await app.service.mermaid());
    await app.close();
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

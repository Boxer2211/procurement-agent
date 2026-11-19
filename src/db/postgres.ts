/** Postgres implementations of the stores. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { BudgetRecord, VendorRecord } from "./referenceData.js";
import {
  type DataStore,
  matchVendor,
  type RunFinish,
  type RunRecord,
  type RunStart,
  type TraceStep,
  type TraceStore,
} from "./stores.js";

// NUMERIC -> JS number (amounts here are well within double precision).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number.parseFloat(v));

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

export function schemaSql(): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");
}

export async function applySchema(pool: pg.Pool): Promise<void> {
  await pool.query(schemaSql());
}

export class PgDataStore implements DataStore {
  constructor(private readonly pool: pg.Pool) {}

  async getBudget(
    department: string,
    category: string,
    period: string,
  ): Promise<BudgetRecord | null> {
    const { rows } = await this.pool.query<BudgetRecord>(
      `SELECT department, category, period, allocated, spent, committed, currency
       FROM budgets WHERE department = lower(trim($1)) AND category = $2 AND period = $3`,
      [department, category, period],
    );
    return rows[0] ?? null;
  }

  async findVendor(name: string): Promise<VendorRecord | null> {
    // Trigram prefilter in SQL, final decision by the same matcher as the memory store.
    const { rows } = await this.pool.query<VendorRecord & { contract_until: string | null }>(
      `SELECT name, aliases, status, categories, to_char(contract_until, 'YYYY-MM-DD') AS contract_until, notes
       FROM vendors
       WHERE similarity(lower(name), lower($1)) > 0.2
          OR lower($1) = ANY(SELECT lower(a) FROM unnest(aliases) a)
          OR lower(name) = lower($1)
       ORDER BY similarity(lower(name), lower($1)) DESC
       LIMIT 10`,
      [name],
    );
    return matchVendor(rows, name)?.vendor ?? null;
  }

  async upsertBudgets(budgets: readonly BudgetRecord[]): Promise<void> {
    for (const b of budgets) {
      await this.pool.query(
        `INSERT INTO budgets (department, category, period, allocated, spent, committed, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (department, category, period) DO UPDATE SET
           allocated = EXCLUDED.allocated, spent = EXCLUDED.spent,
           committed = EXCLUDED.committed, currency = EXCLUDED.currency`,
        [b.department, b.category, b.period, b.allocated, b.spent, b.committed, b.currency],
      );
    }
  }

  async upsertVendors(vendors: readonly VendorRecord[]): Promise<void> {
    for (const v of vendors) {
      await this.pool.query(
        `INSERT INTO vendors (name, aliases, status, categories, contract_until, notes)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (name) DO UPDATE SET aliases = EXCLUDED.aliases, status = EXCLUDED.status,
           categories = EXCLUDED.categories, contract_until = EXCLUDED.contract_until,
           notes = EXCLUDED.notes`,
        [v.name, v.aliases, v.status, v.categories, v.contract_until, v.notes],
      );
    }
  }
}

interface RunRow {
  run_id: string;
  created_at: Date;
  finished_at: Date | null;
  input_text: string;
  status: string | null;
  decision: string | null;
  prompt_version: string;
  agent_model: string | null;
  verifier_model: string | null;
  duration_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  result: unknown;
  human_decision: unknown;
}

interface StepRow {
  seq: number;
  node: string;
  kind: TraceStep["kind"];
  name: string;
  input: unknown;
  output: unknown;
  error: string | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: Date;
}

export class PgTraceStore implements TraceStore {
  constructor(private readonly pool: pg.Pool) {}

  async startRun(run: RunStart): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_runs (run_id, input_text, prompt_version, agent_model, verifier_model)
       VALUES ($1,$2,$3,$4,$5)`,
      [run.runId, run.inputText, run.promptVersion, run.agentModel, run.verifierModel],
    );
  }

  async appendSteps(runId: string, steps: readonly TraceStep[]): Promise<void> {
    for (const s of steps) {
      await this.pool.query(
        `INSERT INTO agent_steps (run_id, seq, node, kind, name, input, output, error,
           duration_ms, input_tokens, output_tokens, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (run_id, seq) DO NOTHING`,
        [
          runId,
          s.seq,
          s.node,
          s.kind,
          s.name,
          JSON.stringify(s.input ?? null),
          JSON.stringify(s.output ?? null),
          s.error,
          s.durationMs,
          s.inputTokens,
          s.outputTokens,
          s.at,
        ],
      );
    }
  }

  async finishRun(runId: string, f: RunFinish): Promise<void> {
    await this.pool.query(
      `UPDATE agent_runs SET status = $2, decision = $3, duration_ms = $4, input_tokens = $5,
         output_tokens = $6, result = $7, finished_at = now() WHERE run_id = $1`,
      [
        runId,
        f.status,
        f.decision,
        f.durationMs,
        f.inputTokens,
        f.outputTokens,
        JSON.stringify(f.result),
      ],
    );
  }

  async saveHumanDecision(runId: string, decision: unknown): Promise<void> {
    await this.pool.query(`UPDATE agent_runs SET human_decision = $2 WHERE run_id = $1`, [
      runId,
      JSON.stringify(decision),
    ]);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const { rows } = await this.pool.query<RunRow>(`SELECT * FROM agent_runs WHERE run_id = $1`, [
      runId,
    ]);
    const r = rows[0];
    if (!r) return null;
    return {
      runId: r.run_id,
      createdAt: r.created_at.toISOString(),
      finishedAt: r.finished_at?.toISOString() ?? null,
      inputText: r.input_text,
      status: r.status,
      decision: r.decision,
      promptVersion: r.prompt_version,
      agentModel: r.agent_model,
      verifierModel: r.verifier_model,
      durationMs: r.duration_ms,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      result: r.result,
      humanDecision: r.human_decision,
    };
  }

  async getSteps(runId: string): Promise<TraceStep[]> {
    const { rows } = await this.pool.query<StepRow>(
      `SELECT seq, node, kind, name, input, output, error, duration_ms, input_tokens,
              output_tokens, created_at
       FROM agent_steps WHERE run_id = $1 ORDER BY seq`,
      [runId],
    );
    return rows.map((r) => ({
      seq: r.seq,
      node: r.node,
      kind: r.kind,
      name: r.name,
      input: r.input,
      output: r.output,
      error: r.error,
      durationMs: r.duration_ms ?? 0,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      at: r.created_at.toISOString(),
    }));
  }
}

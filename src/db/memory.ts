/** In-memory stores: unit/e2e tests and the no-Docker demo (STORAGE=memory). */

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

export class MemoryDataStore implements DataStore {
  constructor(
    private readonly budgets: readonly BudgetRecord[],
    private readonly vendors: readonly VendorRecord[],
  ) {}

  async getBudget(department: string, category: string, period: string) {
    const dept = department.trim().toLowerCase();
    return (
      this.budgets.find(
        (b) => b.department === dept && b.category === category && b.period === period,
      ) ?? null
    );
  }

  async findVendor(name: string) {
    return matchVendor(this.vendors, name)?.vendor ?? null;
  }
}

export class MemoryTraceStore implements TraceStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly steps = new Map<string, TraceStep[]>();

  async startRun(run: RunStart): Promise<void> {
    this.runs.set(run.runId, {
      ...run,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      status: null,
      decision: null,
      durationMs: null,
      inputTokens: 0,
      outputTokens: 0,
      result: null,
      humanDecision: null,
    });
    this.steps.set(run.runId, []);
  }

  async appendSteps(runId: string, steps: readonly TraceStep[]): Promise<void> {
    const list = this.steps.get(runId) ?? [];
    list.push(...steps);
    this.steps.set(runId, list);
  }

  async finishRun(runId: string, finish: RunFinish): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    this.runs.set(runId, { ...run, ...finish, finishedAt: new Date().toISOString() });
  }

  async saveHumanDecision(runId: string, decision: unknown): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    this.runs.set(runId, { ...run, humanDecision: decision });
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async getSteps(runId: string): Promise<TraceStep[]> {
    return [...(this.steps.get(runId) ?? [])].sort((a, b) => a.seq - b.seq);
  }
}

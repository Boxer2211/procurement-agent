/** Runs the graph for one request, persists the trace, handles human decisions. */

import { randomUUID } from "node:crypto";
import { type BaseCheckpointSaver, Command } from "@langchain/langgraph";
import type { ReferenceData } from "../db/referenceData.js";
import type { RunRecord, TraceStep, TraceStore } from "../db/stores.js";
import type { RequestContext, ReviewResult } from "../domain/schemas.js";
import { logger, maskPii } from "../observability/logger.js";
import { buildGraph, type ReviewGraph } from "./builder.js";
import type { GraphDeps } from "./deps.js";
import { type HumanDecisionInput, HumanDecisionInputSchema } from "./nodes/human.js";
import { renderSummary } from "./nodes/summary.js";
import { type HumanDecision, initialState, type State } from "./state.js";

export interface ReviewServiceOptions {
  graphDeps: GraphDeps;
  ref: ReferenceData;
  traces: TraceStore;
  checkpointer: BaseCheckpointSaver;
  runTimeoutMs: number;
}

export interface ReviewOutcome {
  result: ReviewResult;
  awaitingHumanDecision: boolean;
}

export class RunNotFoundError extends Error {
  override name = "RunNotFoundError";
}
export class NotAwaitingDecisionError extends Error {
  override name = "NotAwaitingDecisionError";
}

const RECURSION_LIMIT = 80;

export class ReviewService {
  readonly graph: ReviewGraph;

  constructor(private readonly opts: ReviewServiceOptions) {
    this.graph = buildGraph(opts.graphDeps, opts.ref, opts.checkpointer);
  }

  private config(runId: string, signal?: AbortSignal) {
    return {
      configurable: { thread_id: runId },
      recursionLimit: RECURSION_LIMIT,
      ...(signal ? { signal } : {}),
    };
  }

  private async snapshot(
    runId: string,
  ): Promise<{ values: Partial<State>; next: readonly string[] }> {
    const snap = await this.graph.getState(this.config(runId));
    return { values: (snap.values ?? {}) as Partial<State>, next: snap.next };
  }

  async review(text: string, context: RequestContext | null = null): Promise<ReviewOutcome> {
    const runId = randomUUID();
    const s = this.opts.graphDeps.settings;
    const started = performance.now();
    const log = logger.child({ runId });
    await this.opts.traces.startRun({
      runId,
      inputText: maskPii(text),
      promptVersion: s.PROMPT_VERSION,
      agentModel: s.AGENT_MODEL,
      verifierModel: s.VERIFIER_MODEL,
    });
    log.info({ chars: text.length }, "review_started");

    let failure: string | null = null;
    try {
      await this.graph.invoke(
        initialState(runId, text, context),
        this.config(runId, AbortSignal.timeout(this.opts.runTimeoutMs)),
      );
    } catch (err) {
      failure = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      log.error({ err: failure }, "review_failed");
    }

    const { values, next } = await this.snapshot(runId);
    const steps: TraceStep[] = [...(values.steps ?? [])];
    if (failure) {
      steps.push({
        seq: steps.length + 1,
        node: "service",
        kind: "info",
        name: "run_failed",
        input: null,
        output: null,
        error: failure,
        durationMs: 0,
        inputTokens: null,
        outputTokens: null,
        at: new Date().toISOString(),
      });
    }
    const result =
      values.result ?? this.errorResult(runId, values, failure ?? "graph ended without a result");
    const usage = values.usage ?? { inputTokens: 0, outputTokens: 0 };
    const durationMs = Math.round(performance.now() - started);

    await this.opts.traces.appendSteps(runId, steps);
    await this.opts.traces.finishRun(runId, {
      status: result.status,
      decision: result.decision,
      durationMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      result,
    });
    log.info(
      {
        status: result.status,
        decision: result.decision,
        flags: result.flags,
        durationMs,
        tools: values.toolCalls?.length ?? 0,
        ...usage,
      },
      "review_finished",
    );
    return { result, awaitingHumanDecision: next.includes("human") };
  }

  private errorResult(runId: string, values: Partial<State>, error: string): ReviewResult {
    const result: ReviewResult = {
      run_id: runId,
      status: "error",
      decision: "escalate_to_human",
      confidence: 0,
      request: values.request ?? null,
      checks: [],
      violations: [],
      missing_information: [],
      approval_route: [],
      recommendations: ["The automated review failed; review this request manually."],
      flags: [...new Set([...(values.flags ?? []), "llm_error" as const])],
      verification: {
        verifier_model: null,
        verdict: "skipped",
        unsupported_claims: [],
        invalid_evidence: [],
        notes: "",
        revisions: 0,
      },
      prompt_version: this.opts.graphDeps.settings.PROMPT_VERSION,
      summary: "",
      error,
    };
    return { ...result, summary: renderSummary(result) };
  }

  async submitDecision(runId: string, input: HumanDecisionInput): Promise<HumanDecision> {
    const decision = HumanDecisionInputSchema.parse(input);
    const run = await this.opts.traces.getRun(runId);
    if (!run) throw new RunNotFoundError(runId);
    const before = await this.snapshot(runId);
    if (!before.next.includes("human")) throw new NotAwaitingDecisionError(runId);

    await this.graph.invoke(new Command({ resume: decision }), this.config(runId));
    const after = await this.snapshot(runId);
    const steps = (after.values.steps ?? []).slice(before.values.steps?.length ?? 0);
    await this.opts.traces.appendSteps(runId, steps);
    const human = after.values.humanDecision;
    if (!human) throw new Error("human decision was not recorded");
    await this.opts.traces.saveHumanDecision(runId, human);
    logger.info({ runId, decision: human.decision }, "human_decision_recorded");
    return human;
  }

  getRun(runId: string): Promise<RunRecord | null> {
    return this.opts.traces.getRun(runId);
  }

  getTrace(runId: string): Promise<TraceStep[]> {
    return this.opts.traces.getSteps(runId);
  }

  async mermaid(): Promise<string> {
    return (await this.graph.getGraphAsync()).drawMermaid();
  }
}

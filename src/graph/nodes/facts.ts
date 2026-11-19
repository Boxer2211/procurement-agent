/**
 * facts: guarantee the deterministic rules have the facts they need. Reuse a matching
 * successful agent tool call when there is one; otherwise call the tool directly with
 * canonical arguments derived from the extracted request (initiator: orchestrator).
 */

import { normalizeVendorName } from "../../db/stores.js";
import type { PurchaseRequest } from "../../domain/schemas.js";
import type { Fact, Facts } from "../../rules/engine.js";
import { type ApprovalRoute, toUsd } from "../../tools/approval.js";
import type { BudgetOutput } from "../../tools/budget.js";
import type { RequiredDocuments } from "../../tools/documents.js";
import type { PriceBenchmark } from "../../tools/pricing.js";
import type { ToolContext } from "../../tools/types.js";
import type { VendorOutput } from "../../tools/vendors.js";
import { type GraphDeps, makeStep } from "../deps.js";
import type { NewStep, State, ToolCallRecord, Update } from "../state.js";
import { nextEvidenceId } from "./tools.js";

type Input = Record<string, unknown>;
const asInput = (v: unknown): Input => (typeof v === "object" && v !== null ? (v as Input) : {});
const lower = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : v);
const MAX_PRICE_CHECKS = 5;

export function amountInUsd(request: PurchaseRequest, ref: ToolContext["ref"]): number | null {
  if (request.total_amount === null) return null;
  try {
    return toUsd(request.total_amount, request.currency, ref.approvalMatrix);
  } catch {
    return null;
  }
}

export const makeFactsNode =
  (deps: GraphDeps, ref: ToolContext["ref"]) =>
  async (state: State): Promise<Update> => {
    const req = state.request;
    if (!req) return { ruleFacts: null };

    const calls: ToolCallRecord[] = [...state.toolCalls];
    const added: ToolCallRecord[] = [];
    const steps: NewStep[] = [];

    const ensure = async (
      name: string,
      input: Input,
      matches: (i: Input) => boolean,
    ): Promise<ToolCallRecord> => {
      const reused = [...calls]
        .reverse()
        .find((c) => c.name === name && c.ok && matches(asInput(c.input)));
      if (reused) return reused;
      const evidenceId = nextEvidenceId(name, calls);
      const exec = await deps.tools.execute(name, input);
      const record: ToolCallRecord = {
        evidenceId,
        toolUseId: null,
        name,
        input,
        ok: exec.ok,
        output: exec.ok ? exec.output : null,
        error: exec.ok ? null : exec.error,
        internalError: exec.ok ? null : exec.internalError,
        initiator: "orchestrator",
      };
      calls.push(record);
      added.push(record);
      steps.push(
        makeStep("facts", "tool", name, {
          input: { evidenceId, args: input, initiator: "orchestrator" },
          output: record.output,
          error: exec.ok ? null : (exec.internalError ?? exec.error),
          durationMs: exec.durationMs,
        }),
      );
      return record;
    };
    const fact = <T>(r: ToolCallRecord | null): Fact<T> | null =>
      r?.ok ? { value: r.output as T, evidenceId: r.evidenceId } : null;

    const category = req.category;
    const total = req.total_amount;
    const currency = req.currency;

    let budgetRec: ToolCallRecord | null = null;
    if (req.department && category !== "other") {
      const dept = req.department;
      budgetRec = await ensure(
        "get_budget",
        { department: dept, category },
        (i) => lower(i.department) === dept && i.category === category,
      );
    }

    let vendorRec: ToolCallRecord | null = null;
    if (req.vendor) {
      const target = normalizeVendorName(req.vendor);
      vendorRec = await ensure(
        "check_vendor",
        { vendor_name: req.vendor },
        (i) => typeof i.vendor_name === "string" && normalizeVendorName(i.vendor_name) === target,
      );
    }
    const vendor = fact<VendorOutput>(vendorRec);

    let routeRec: ToolCallRecord | null = null;
    if (total !== null && total > 0) {
      routeRec = await ensure(
        "get_approval_route",
        { amount: total, currency, category },
        (i) =>
          i.amount === total &&
          lower(i.currency) === currency.toLowerCase() &&
          i.category === category,
      );
    }

    const vendorStatus = vendor?.value.status ?? null;
    const docsRec = await ensure(
      "get_required_documents",
      {
        category,
        amount: total !== null && total > 0 ? total : null,
        currency,
        vendor_status: vendorStatus,
      },
      (i) =>
        i.category === category &&
        i.amount === (total !== null && total > 0 ? total : null) &&
        i.vendor_status === vendorStatus,
    );

    const prices: Fact<PriceBenchmark>[] = [];
    for (const item of req.items
      .filter((it) => it.unit_price !== null && it.unit_price > 0)
      .slice(0, MAX_PRICE_CHECKS)) {
      const rec = await ensure(
        "get_price_benchmark",
        { item: item.name.slice(0, 120), unit_price: item.unit_price, currency },
        (i) => lower(i.item) === item.name.toLowerCase() && i.unit_price === item.unit_price,
      );
      const f = fact<PriceBenchmark>(rec);
      if (f && f.value.verdict !== "no_benchmark") prices.push(f);
    }

    if (!calls.some((c) => c.name === "search_policies" && c.ok)) {
      await ensure(
        "search_policies",
        {
          query: state.reviewPlan?.searchQueries[0] ?? req.summary.slice(0, 200),
          category,
          top_k: 5,
        },
        () => false,
      );
    }

    const facts: Facts = {
      amountUsd: amountInUsd(req, ref),
      budget: fact<BudgetOutput>(budgetRec),
      budgetError: budgetRec && !budgetRec.ok ? budgetRec.error : null,
      vendor,
      route: fact<ApprovalRoute>(routeRec),
      documents: fact<RequiredDocuments>(docsRec),
      prices,
      toolFailures: calls
        .filter((c) => c.internalError)
        .map((c) => `${c.name}: ${c.internalError}`),
    };
    return {
      ruleFacts: facts,
      toolCalls: added,
      steps: [
        ...steps,
        makeStep("facts", "info", "facts", {
          output: { reused: calls.length - added.length, added: added.length },
        }),
      ],
    };
  };

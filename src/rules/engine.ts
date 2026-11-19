/**
 * Deterministic hard rules. They compute a decision *floor* from facts gathered by tools;
 * the final decision is the more severe of (LLM decision, floor). Rules never relax.
 */

import { formatMoney, toCents } from "../domain/money.js";
import {
  type Check,
  type CheckId,
  type CheckStatus,
  checkSeverity,
  type Decision,
  type Flag,
  mostSevere,
  type PurchaseRequest,
  type Violation,
} from "../domain/schemas.js";
import type { ApprovalRoute } from "../tools/approval.js";
import type { BudgetOutput } from "../tools/budget.js";
import type { RequiredDocuments } from "../tools/documents.js";
import type { PriceBenchmark } from "../tools/pricing.js";
import type { VendorOutput } from "../tools/vendors.js";

export interface Fact<T> {
  value: T;
  evidenceId: string;
}

export interface Facts {
  amountUsd: number | null;
  budget: Fact<BudgetOutput> | null;
  /** Why the budget fact is missing (tool error message), if it is. */
  budgetError: string | null;
  vendor: Fact<VendorOutput> | null;
  route: Fact<ApprovalRoute> | null;
  documents: Fact<RequiredDocuments> | null;
  prices: Fact<PriceBenchmark>[];
  /** Internal tool failures (not user-safe "not found" errors). */
  toolFailures: string[];
}

export interface RuleHit {
  ruleId: string;
  floor: Decision;
  reason: string;
}

export interface RuleOutcome {
  floor: Decision;
  hits: RuleHit[];
  checks: Check[];
  violations: Violation[];
  missing: string[];
  recommendations: string[];
  flags: Flag[];
}

/** Documents handled by dedicated rules instead of the generic documents rule. */
const SPECIAL_DOCS = new Set([
  "vendor_quotes",
  "cost_center",
  "business_justification",
  "vendor_onboarding_form",
]);
const MIN_JUSTIFICATION_CHARS = 40;
const JUSTIFICATION_THRESHOLD_USD = 1000;

class OutcomeBuilder {
  private readonly out: RuleOutcome = {
    floor: "recommend_approve",
    hits: [],
    checks: [],
    violations: [],
    missing: [],
    recommendations: [],
    flags: [],
  };

  hit(ruleId: string, floor: Decision, reason: string): void {
    this.out.hits.push({ ruleId, floor, reason });
    this.out.floor = mostSevere(this.out.floor, floor);
  }

  check(checkId: CheckId, status: CheckStatus, detail: string, evidence: string[] = []): void {
    const existing = this.out.checks.find((c) => c.check_id === checkId);
    if (!existing) {
      this.out.checks.push({ check_id: checkId, status, detail, evidence });
      return;
    }
    if (checkSeverity(status) > checkSeverity(existing.status)) {
      existing.status = status;
      existing.detail = detail;
    } else if (checkSeverity(status) === checkSeverity(existing.status) && status !== "pass") {
      existing.detail = `${existing.detail} ${detail}`;
    }
    existing.evidence = [...new Set([...existing.evidence, ...evidence])];
  }

  violation(
    ruleId: string,
    severity: Violation["severity"],
    detail: string,
    evidence: string[],
  ): void {
    this.out.violations.push({ rule_id: ruleId, severity, detail, evidence });
  }

  missing(item: string): void {
    if (!this.out.missing.includes(item)) this.out.missing.push(item);
  }

  recommend(text: string): void {
    if (!this.out.recommendations.includes(text)) this.out.recommendations.push(text);
  }

  flag(f: Flag): void {
    if (!this.out.flags.includes(f)) this.out.flags.push(f);
  }

  build(): RuleOutcome {
    return this.out;
  }
}

export function evaluateRules(
  request: PurchaseRequest,
  facts: Facts,
  flags: readonly Flag[],
): RuleOutcome {
  const b = new OutcomeBuilder();
  const amount = facts.amountUsd;
  const money = (n: number) => formatMoney(n, "USD");

  // --- manipulation / abuse signals --------------------------------------------------
  if (flags.includes("split_purchase_suspected")) {
    b.hit(
      "PROC-001#5.1",
      "recommend_reject",
      "request suggests splitting a purchase to avoid thresholds",
    );
    b.violation(
      "PROC-001#5.1",
      "high",
      "The request asks to split one need into smaller purchases to stay below an approval or quoting threshold.",
      [],
    );
    b.check("policy_compliance", "fail", "Split purchases are prohibited (PROC-001 §5.1).");
  }
  if (flags.includes("approval_bypass_attempt")) {
    b.hit(
      "PROC-001#5.2",
      "escalate_to_human",
      "request asks to skip approvals or for retroactive approval",
    );
    b.violation(
      "PROC-001#5.2",
      "high",
      "The request asks to bypass required approvals or to approve a purchase retroactively.",
      [],
    );
    b.check(
      "policy_compliance",
      "fail",
      "Bypassing or retroactive approval is not allowed (PROC-001 §5.2).",
    );
  }
  if (flags.includes("prompt_injection_suspected")) {
    b.hit(
      "GUARD-INJECTION",
      "escalate_to_human",
      "request contains instructions aimed at the AI reviewer",
    );
    b.recommend(
      "The request text contains instructions aimed at the automated reviewer; a human should review it.",
    );
  }
  if (flags.includes("amount_mismatch")) {
    b.hit("PROC-001#2.2", "needs_info", "stated total does not match quantity × unit price");
    b.check("completeness", "fail", "Stated total does not equal quantity × unit price.");
    b.missing("corrected total amount (quantity × unit price)");
  }

  // --- completeness -----------------------------------------------------------------
  const missingCore: string[] = [];
  if (request.items.length === 0) missingCore.push("items to purchase");
  if (request.total_amount === null && amount === null) missingCore.push("total amount");
  if (!request.vendor) missingCore.push("vendor");
  if (!request.department) missingCore.push("requesting department");
  for (const m of missingCore) b.missing(m);
  if (!request.cost_center) b.missing("cost center");
  if (missingCore.length > 0 || !request.cost_center) {
    const all = [...missingCore, ...(request.cost_center ? [] : ["cost center"])];
    b.hit("PROC-001#2.1", "needs_info", `missing mandatory fields: ${all.join(", ")}`);
    b.check("completeness", "fail", `Missing mandatory fields: ${all.join(", ")}.`);
  } else {
    b.check("completeness", "pass", "All mandatory request fields are present.");
  }
  if (request.total_amount !== null && amount === null) {
    b.hit("PROC-002#1.2", "needs_info", `unsupported currency ${request.currency}`);
    b.missing(`amount in a supported currency (got ${request.currency})`);
  }

  // --- vendor -----------------------------------------------------------------------
  const vendor = facts.vendor;
  if (vendor) {
    const v = vendor.value;
    const ev = [vendor.evidenceId];
    switch (v.status) {
      case "blacklisted":
        b.hit("VEN-001#3.1", "recommend_reject", `vendor ${v.name} is blacklisted`);
        b.violation(
          "VEN-001#3.1",
          "high",
          `${v.name} is a blacklisted vendor; purchases are prohibited.`,
          ev,
        );
        b.check("vendor", "fail", `${v.name} is blacklisted.`, ev);
        break;
      case "pending":
        b.hit("VEN-001#2.1", "needs_info", `vendor ${v.name} has not completed onboarding`);
        b.check(
          "vendor",
          "fail",
          `${v.name} is pending onboarding and cannot receive orders yet.`,
          ev,
        );
        b.missing("completed vendor onboarding (form, tax/banking details, sanctions screening)");
        break;
      case "unknown":
        b.hit("VEN-001#2.1", "needs_info", "vendor is not in the approved vendor registry");
        b.check(
          "vendor",
          "fail",
          `Vendor '${request.vendor}' is not on the approved vendor list.`,
          ev,
        );
        b.missing("vendor onboarding (vendor is not on the approved list)");
        break;
      case "expired":
        b.hit("VEN-001#1.2", "needs_info", `contract with ${v.name} expired`);
        b.check("vendor", "fail", `${v.name}'s contract expired on ${v.contract_until}.`, ev);
        b.missing(`renewed contract with ${v.name}`);
        break;
      case "approved":
        if (request.category !== "other" && !v.categories.includes(request.category)) {
          b.hit("VEN-001#1.1", "needs_info", `vendor not approved for ${request.category}`);
          b.check(
            "vendor",
            "warn",
            `${v.name} is approved only for ${v.categories.join(", ")}, not ${request.category}.`,
            ev,
          );
        } else {
          b.check(
            "vendor",
            "pass",
            `${v.name} is an approved vendor${v.contract_until ? ` (contract until ${v.contract_until})` : ""}.`,
            ev,
          );
        }
        break;
    }
  } else if (request.vendor) {
    b.check("vendor", "unknown", "Vendor status could not be verified.");
  }

  // --- budget -----------------------------------------------------------------------
  const budget = facts.budget;
  if (budget && amount !== null) {
    const ev = [budget.evidenceId];
    const { remaining, period } = budget.value;
    if (toCents(amount) > toCents(remaining)) {
      b.hit("BUD-001#2.1", "recommend_reject", "purchase exceeds remaining budget");
      b.violation(
        "BUD-001#2.1",
        "high",
        `Total ${money(amount)} exceeds the remaining ${budget.value.category} budget of ${money(remaining)} for ${period}.`,
        ev,
      );
      b.check(
        "budget",
        "fail",
        `Total ${money(amount)} exceeds remaining budget ${money(remaining)} (${period}).`,
        ev,
      );
      b.recommend(
        "Resubmit with a CFO-approved budget exception that names the budget line absorbing the cost (BUD-001 §2.1).",
      );
    } else {
      b.check(
        "budget",
        "pass",
        `Total ${money(amount)} fits the remaining budget of ${money(remaining)} (${period}).`,
        ev,
      );
    }
  } else if (request.department && amount !== null) {
    b.hit("BUD-001#1.1", "needs_info", "budget could not be verified");
    b.check(
      "budget",
      "unknown",
      `Budget could not be verified: ${facts.budgetError ?? "no data"}.`,
    );
    b.missing("confirmation of the budget line to charge");
  } else {
    b.check("budget", "unknown", "Budget cannot be checked without department and amount.");
  }

  // --- approval route & quotes ------------------------------------------------------
  const route = facts.route;
  if (route) {
    const r = route.value;
    const ev = [route.evidenceId];
    b.check("approval_route", "pass", `Requires approval by: ${r.approvers.join(", ")}.`, ev);
    if (r.tender_required) {
      b.hit("PROC-002#2.5", "needs_info", "formal tender required above $100,000");
      b.missing("formal tender (RFP) documentation");
    }
    const have =
      request.quotes_count ?? (request.provided_documents.includes("vendor_quotes") ? 1 : 0);
    if (r.min_quotes > 1 && have < r.min_quotes) {
      b.hit("PROC-001#4.2", "needs_info", `${r.min_quotes} quotes required, ${have} provided`);
      b.check(
        "quotes",
        "fail",
        `Purchases above $5,000 need ${r.min_quotes} written quotes; ${have} provided.`,
        ev,
      );
      b.missing(
        `${r.min_quotes - have} more vendor quote(s) (${r.min_quotes} required, ${have} provided)`,
      );
    } else {
      b.check(
        "quotes",
        "pass",
        `${r.min_quotes} quote(s) required; ${have || "vendor quote"} provided.`,
        ev,
      );
    }
  } else if (amount !== null) {
    b.check("approval_route", "unknown", "Approval route could not be determined.");
  }

  // --- justification ----------------------------------------------------------------
  if (amount !== null && amount > JUSTIFICATION_THRESHOLD_USD) {
    const j = request.justification?.trim() ?? "";
    if (!j) {
      b.hit("PROC-001#3.1", "needs_info", "business justification missing");
      b.check(
        "justification",
        "fail",
        "No business justification provided (required above $1,000).",
      );
      b.missing("business justification (problem, users, impact if not purchased)");
    } else if (j.length < MIN_JUSTIFICATION_CHARS) {
      b.hit("PROC-001#3.1", "needs_info", "business justification too generic");
      b.check(
        "justification",
        "warn",
        `Justification "${j}" is too generic for a purchase above $1,000.`,
      );
      b.missing("a specific business justification (problem, users, impact if not purchased)");
    } else {
      b.check("justification", "pass", "A business justification is provided.");
    }
  }

  // --- required documents -----------------------------------------------------------
  const docs = facts.documents;
  if (docs) {
    const ev = [docs.evidenceId];
    const provided = new Set(request.provided_documents);
    const outstanding = docs.value.documents.filter(
      (d) => !SPECIAL_DOCS.has(d.doc_id) && !provided.has(d.doc_id as never),
    );
    if (outstanding.length > 0) {
      b.hit(outstanding[0]?.rule_id ?? "DOCS", "needs_info", "required documents missing");
      b.check(
        "documents",
        "fail",
        `Missing documents: ${outstanding.map((d) => d.doc_id).join(", ")}.`,
        ev,
      );
      for (const d of outstanding) b.missing(d.doc_id);
    } else {
      b.check("documents", "pass", "All category-specific documents are provided.", ev);
    }
  }

  // --- price sanity -----------------------------------------------------------------
  for (const p of facts.prices) {
    const v = p.value;
    if (v.verdict === "above_range") {
      const detail = `Unit price ${money(v.unit_price_usd)} is above the typical range for ${v.matched_item} (${money(v.typical_min ?? 0)}–${money(v.typical_max ?? 0)}).`;
      if (v.policy_ref) {
        b.hit(v.policy_ref, "needs_info", "unit price above the policy cap");
        b.check("price", "fail", `${detail} This exceeds the policy cap (${v.policy_ref}).`, [
          p.evidenceId,
        ]);
        b.missing("IT director approval for a device above the profile price cap");
      } else {
        b.check("price", "warn", detail, [p.evidenceId]);
      }
    } else if (v.verdict === "below_range") {
      b.check(
        "price",
        "warn",
        `Unit price ${money(v.unit_price_usd)} is unusually low for ${v.matched_item}; confirm the offer.`,
        [p.evidenceId],
      );
    } else if (v.verdict === "within_range") {
      b.check(
        "price",
        "pass",
        `Unit price ${money(v.unit_price_usd)} is within the typical range for ${v.matched_item}.`,
        [p.evidenceId],
      );
    }
  }

  // --- infrastructure failures ------------------------------------------------------
  if (facts.toolFailures.length > 0) {
    b.flag("tool_failure");
    b.hit("GUARD-TOOL-FAILURE", "needs_info", `tool failures: ${facts.toolFailures.join("; ")}`);
  }

  return b.build();
}

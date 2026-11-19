/** Human-readable summary rendered deterministically from the JSON result (no LLM). */

import { formatMoney } from "../../domain/money.js";
import type { CheckStatus, Decision, ReviewResult } from "../../domain/schemas.js";

const DECISION_LABEL: Record<Decision, string> = {
  recommend_approve: "RECOMMEND APPROVAL",
  needs_info: "NEEDS MORE INFORMATION",
  escalate_to_human: "ESCALATE TO A HUMAN REVIEWER",
  recommend_reject: "RECOMMEND REJECTION",
  refused: "NOT REVIEWED",
};

const STATUS_MARK: Record<CheckStatus, string> = {
  pass: "[PASS]",
  warn: "[WARN]",
  fail: "[FAIL]",
  unknown: "[ ?  ]",
};
const STATUS_ORDER: Record<CheckStatus, number> = { fail: 0, warn: 1, unknown: 2, pass: 3 };

const INPUT_ERRORS: Record<string, string> = {
  empty_request: "the request is empty",
  request_too_long: "the request is too long",
  request_not_understandable: "the request could not be understood",
};

const humanize = (s: string) => s.replace(/_/g, " ");

export function renderSummary(r: ReviewResult, inputError: string | null = null): string {
  if (r.status === "invalid_input") {
    return `The request could not be reviewed: ${INPUT_ERRORS[inputError ?? ""] ?? "invalid input"}. Please describe the items, quantity, price, vendor and requesting department.`;
  }
  if (r.status === "refused") {
    const reason = r.request?.off_topic_reason ? ` (${r.request.off_topic_reason})` : "";
    return `This assistant only reviews purchase requests for company goods and services; the message was not reviewed${reason}.`;
  }

  const lines: string[] = [];
  lines.push(
    `Recommendation: ${DECISION_LABEL[r.decision]} (confidence ${Math.round(r.confidence * 100)}%)`,
  );
  const req = r.request;
  if (req) {
    const amount =
      req.total_amount !== null ? formatMoney(req.total_amount, req.currency) : "amount not stated";
    const who = [req.department, req.category].filter(Boolean).join(", ");
    lines.push(`Request: ${req.summary} — ${amount}${who ? ` (${who})` : ""}`);
  }
  if (r.error)
    lines.push(
      `Note: the automated review was incomplete (${r.error}); a human should double-check.`,
    );

  if (r.checks.length > 0) {
    lines.push("", "Checks:");
    const sorted = [...r.checks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
    for (const c of sorted)
      lines.push(`  ${STATUS_MARK[c.status]} ${humanize(c.check_id)}: ${c.detail}`);
  }
  if (r.violations.length > 0) {
    lines.push("", "Policy violations:");
    for (const v of r.violations) lines.push(`  - [${v.severity}] ${v.rule_id}: ${v.detail}`);
  }
  if (r.missing_information.length > 0) {
    lines.push("", "Missing information:");
    for (const m of r.missing_information) lines.push(`  - ${humanize(m)}`);
  }
  if (r.approval_route.length > 0) {
    lines.push("", `Approval route: ${r.approval_route.map(humanize).join(" → ")}`);
  }
  if (r.recommendations.length > 0) {
    lines.push("", "Next steps:");
    for (const rec of r.recommendations) lines.push(`  - ${rec}`);
  }
  if (r.flags.length > 0) lines.push("", `Flags: ${r.flags.join(", ")}`);
  lines.push(
    "",
    "This is an automated pre-check. The final decision is made by the approvers listed above.",
  );
  return lines.join("\n");
}

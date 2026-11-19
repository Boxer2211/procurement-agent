import { z } from "zod";
import type { ApprovalMatrix } from "../db/referenceData.js";
import { fromCents, toCents } from "../domain/money.js";
import { type Category, CategorySchema } from "../domain/schemas.js";
import { defineTool, ToolError } from "./types.js";

export function toUsd(amount: number, currency: string, matrix: ApprovalMatrix): number {
  const rate = matrix.fx_to_usd[currency.toUpperCase()];
  if (rate === undefined) throw new ToolError(`Unsupported currency '${currency}'.`);
  return fromCents(toCents(amount * rate));
}

export const ApprovalRouteSchema = z.object({
  amount_usd: z.number(),
  approvers: z.array(z.string()),
  min_quotes: z.number().int(),
  tender_required: z.boolean(),
  rule_ids: z.array(z.string()),
});
export type ApprovalRoute = z.infer<typeof ApprovalRouteSchema>;

/** Pure approval-matrix lookup (PROC-002). Thresholds are inclusive upper bounds. */
export function computeApprovalRoute(
  amountUsd: number,
  category: Category,
  matrix: ApprovalMatrix,
): ApprovalRoute {
  const cents = toCents(amountUsd);
  const level = matrix.levels.find((l) => l.max_amount === null || cents <= toCents(l.max_amount));
  if (!level) throw new Error("approval matrix has no open-ended level");
  const approvers = [...level.approvers];
  const ruleIds = [level.rule_id];
  for (const extra of matrix.additional_approvers) {
    const amountOk =
      extra.min_amount_exclusive === undefined || cents > toCents(extra.min_amount_exclusive);
    if (extra.categories.includes(category) && amountOk && !approvers.includes(extra.approver)) {
      approvers.push(extra.approver);
      ruleIds.push(extra.rule_id);
    }
  }
  return {
    amount_usd: amountUsd,
    approvers,
    min_quotes: level.min_quotes,
    tender_required: level.tender_required,
    rule_ids: ruleIds,
  };
}

export const getApprovalRouteTool = defineTool({
  name: "get_approval_route",
  description:
    "Return who must approve a purchase of this amount and category according to the approval " +
    "matrix (PROC-002), the minimum number of vendor quotes, and whether a tender is required.",
  input: z
    .object({
      amount: z.number().positive().describe("Total purchase amount"),
      currency: z.string().length(3).describe("ISO-4217 currency code"),
      category: CategorySchema,
    })
    .strict(),
  output: ApprovalRouteSchema,
  timeoutMs: 2_000,
  async run({ amount, currency, category }, ctx) {
    return computeApprovalRoute(
      toUsd(amount, currency, ctx.ref.approvalMatrix),
      category,
      ctx.ref.approvalMatrix,
    );
  },
});

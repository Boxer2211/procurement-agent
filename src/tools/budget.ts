import { z } from "zod";
import { fromCents, toCents } from "../domain/money.js";
import { CategorySchema } from "../domain/schemas.js";
import { defineTool, ToolError } from "./types.js";

export const BudgetOutputSchema = z.object({
  department: z.string(),
  category: z.string(),
  period: z.string(),
  allocated: z.number(),
  spent: z.number(),
  committed: z.number(),
  remaining: z.number(),
  currency: z.string(),
  rule_id: z.literal("BUD-001#1.1"),
});
export type BudgetOutput = z.infer<typeof BudgetOutputSchema>;

export const getBudgetTool = defineTool({
  name: "get_budget",
  description:
    "Return allocated, spent, committed and remaining budget (USD) for a department and category " +
    "in the current budget period. Use it to judge whether the purchase total fits the budget.",
  input: z
    .object({
      department: z.string().min(1).max(64).describe("Department slug, e.g. 'engineering'"),
      category: CategorySchema,
    })
    .strict(),
  output: BudgetOutputSchema,
  timeoutMs: 5_000,
  async run({ department, category }, ctx) {
    const b = await ctx.data.getBudget(department, category, ctx.budgetPeriod);
    if (!b) {
      throw new ToolError(
        `No ${category} budget found for department '${department}' in ${ctx.budgetPeriod}.`,
      );
    }
    const remaining = toCents(b.allocated) - toCents(b.spent) - toCents(b.committed);
    return {
      department: b.department,
      category: b.category,
      period: b.period,
      allocated: b.allocated,
      spent: b.spent,
      committed: b.committed,
      remaining: fromCents(remaining as ReturnType<typeof toCents>),
      currency: b.currency,
      rule_id: "BUD-001#1.1" as const,
    };
  },
});

import { z } from "zod";
import type { RequiredDoc } from "../db/referenceData.js";
import { toCents } from "../domain/money.js";
import { type Category, CategorySchema, VendorStatusSchema } from "../domain/schemas.js";
import { toUsd } from "./approval.js";
import { defineTool } from "./types.js";

export const RequiredDocumentsSchema = z.object({
  documents: z.array(
    z.object({ doc_id: z.string(), description: z.string(), rule_id: z.string() }),
  ),
});
export type RequiredDocuments = z.infer<typeof RequiredDocumentsSchema>;

/** Pure rule: which documents a request of this shape needs. */
export function computeRequiredDocuments(
  category: Category,
  amountUsd: number | null,
  vendorStatus: string | null,
  rules: readonly RequiredDoc[],
): RequiredDocuments {
  const cents = amountUsd === null ? null : toCents(amountUsd);
  const documents = rules
    .filter(({ when }) => {
      if (when.categories && !when.categories.includes(category)) return false;
      if (when.min_amount_exclusive !== undefined) {
        // Unknown amount: assume the stricter case so nothing is silently skipped.
        if (cents !== null && cents <= toCents(when.min_amount_exclusive)) return false;
      }
      if (when.vendor_status && !(vendorStatus && when.vendor_status.includes(vendorStatus))) {
        return false;
      }
      return true;
    })
    .map((d) => ({ doc_id: d.doc_id, description: d.description, rule_id: d.rule_id }));
  return { documents };
}

export const getRequiredDocumentsTool = defineTool({
  name: "get_required_documents",
  description:
    "Return the documents required before this purchase can be approved, given its category, " +
    "amount and vendor status, each with the policy rule id that requires it.",
  input: z
    .object({
      category: CategorySchema,
      amount: z.number().positive().nullable().describe("Total amount, null if unknown"),
      currency: z.string().length(3),
      vendor_status: VendorStatusSchema.nullable().describe("Result of check_vendor, if known"),
    })
    .strict(),
  output: RequiredDocumentsSchema,
  timeoutMs: 2_000,
  async run({ category, amount, currency, vendor_status }, ctx) {
    const usd = amount === null ? null : toUsd(amount, currency, ctx.ref.approvalMatrix);
    return computeRequiredDocuments(category, usd, vendor_status, ctx.ref.requiredDocs);
  },
});

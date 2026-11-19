import { z } from "zod";
import { VendorStatusSchema } from "../domain/schemas.js";
import { defineTool } from "./types.js";

export const VendorOutputSchema = z.object({
  found: z.boolean(),
  name: z.string().nullable(),
  status: VendorStatusSchema,
  categories: z.array(z.string()),
  contract_until: z.string().nullable(),
  notes: z.string().nullable(),
  rule_id: z.string(),
});
export type VendorOutput = z.infer<typeof VendorOutputSchema>;

export const checkVendorTool = defineTool({
  name: "check_vendor",
  description:
    "Look up a vendor in the approved vendor registry (fuzzy name match). Returns status: " +
    "approved, pending (onboarding not finished), blacklisted, expired (contract ended) or " +
    "unknown (not in the registry), plus approved categories and contract end date.",
  input: z
    .object({ vendor_name: z.string().min(1).max(120).describe("Vendor name as stated") })
    .strict(),
  output: VendorOutputSchema,
  timeoutMs: 5_000,
  async run({ vendor_name }, ctx) {
    const v = await ctx.data.findVendor(vendor_name);
    if (!v) {
      return {
        found: false,
        name: null,
        status: "unknown" as const,
        categories: [],
        contract_until: null,
        notes: null,
        rule_id: "VEN-001#2.1",
      };
    }
    const expired =
      v.status === "approved" && v.contract_until !== null && v.contract_until < ctx.today;
    const status = expired ? ("expired" as const) : v.status;
    const ruleId = {
      approved: "VEN-001#1.1",
      expired: "VEN-001#1.2",
      pending: "VEN-001#2.1",
      blacklisted: "VEN-001#3.1",
    }[status];
    return {
      found: true,
      name: v.name,
      status,
      categories: v.categories,
      contract_until: v.contract_until,
      notes: v.notes,
      rule_id: ruleId,
    };
  },
});

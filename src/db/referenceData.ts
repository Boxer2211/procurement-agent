/** Reference data files under data/: validated with zod at load time. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { CategorySchema, DocumentIdSchema } from "../domain/schemas.js";

export const ApprovalLevelSchema = z.object({
  max_amount: z.number().positive().nullable(),
  approvers: z.array(z.string()).min(1),
  min_quotes: z.number().int().min(1),
  tender_required: z.boolean().default(false),
  rule_id: z.string(),
});

export const ApprovalMatrixSchema = z.object({
  currency: z.literal("USD"),
  fx_to_usd: z.record(z.string(), z.number().positive()),
  levels: z.array(ApprovalLevelSchema).min(1),
  additional_approvers: z.array(
    z.object({
      categories: z.array(CategorySchema),
      approver: z.string(),
      min_amount_exclusive: z.number().optional(),
      rule_id: z.string(),
    }),
  ),
});
export type ApprovalMatrix = z.infer<typeof ApprovalMatrixSchema>;

export const RequiredDocSchema = z.object({
  doc_id: DocumentIdSchema,
  description: z.string(),
  when: z.object({
    categories: z.array(CategorySchema).optional(),
    min_amount_exclusive: z.number().optional(),
    vendor_status: z.array(z.string()).optional(),
  }),
  rule_id: z.string(),
});
export const RequiredDocsSchema = z.object({ documents: z.array(RequiredDocSchema) });
export type RequiredDoc = z.infer<typeof RequiredDocSchema>;

export const CatalogItemSchema = z.object({
  key: z.string(),
  aliases: z.array(z.string()),
  min: z.number().positive(),
  max: z.number().positive(),
  policy_ref: z.string().nullable(),
});
export const CatalogSchema = z.object({ items: z.array(CatalogItemSchema) });
export type CatalogItem = z.infer<typeof CatalogItemSchema>;

export const BudgetRecordSchema = z.object({
  department: z.string(),
  category: CategorySchema,
  period: z.string().regex(/^\d{4}-Q[1-4]$/),
  allocated: z.number(),
  spent: z.number(),
  committed: z.number(),
  currency: z.string().length(3).default("USD"),
});
export type BudgetRecord = z.infer<typeof BudgetRecordSchema>;

export const VendorRecordSchema = z.object({
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  status: z.enum(["approved", "pending", "blacklisted"]),
  categories: z.array(CategorySchema).default([]),
  contract_until: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
});
export type VendorRecord = z.infer<typeof VendorRecordSchema>;

export interface ReferenceData {
  approvalMatrix: ApprovalMatrix;
  requiredDocs: RequiredDoc[];
  catalog: CatalogItem[];
}

const readYaml = (path: string): unknown => parseYaml(readFileSync(path, "utf8"));
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

export function loadReferenceData(dataDir: string): ReferenceData {
  const approvalMatrix = ApprovalMatrixSchema.parse(
    readYaml(join(dataDir, "approval_matrix.yaml")),
  );
  const sorted = [...approvalMatrix.levels];
  sorted.sort((a, b) => (a.max_amount ?? Infinity) - (b.max_amount ?? Infinity));
  if (sorted.at(-1)?.max_amount !== null) {
    throw new Error("approval_matrix.yaml: the last level must have max_amount: null");
  }
  return {
    approvalMatrix: { ...approvalMatrix, levels: sorted },
    requiredDocs: RequiredDocsSchema.parse(readYaml(join(dataDir, "required_docs.yaml"))).documents,
    catalog: CatalogSchema.parse(readJson(join(dataDir, "catalog.json"))).items,
  };
}

export function loadBudgets(dataDir: string): BudgetRecord[] {
  return z
    .object({ budgets: z.array(BudgetRecordSchema) })
    .parse(readJson(join(dataDir, "budgets.json"))).budgets;
}

export function loadVendors(dataDir: string): VendorRecord[] {
  return z
    .object({ vendors: z.array(VendorRecordSchema) })
    .parse(readJson(join(dataDir, "vendors.json"))).vendors;
}

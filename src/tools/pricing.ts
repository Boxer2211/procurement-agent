import { z } from "zod";
import type { CatalogItem } from "../db/referenceData.js";
import { toUsd } from "./approval.js";
import { defineTool } from "./types.js";

export const PriceBenchmarkSchema = z.object({
  matched_item: z.string().nullable(),
  typical_min: z.number().nullable(),
  typical_max: z.number().nullable(),
  unit_price_usd: z.number(),
  verdict: z.enum(["within_range", "above_range", "below_range", "no_benchmark"]),
  policy_ref: z.string().nullable(),
});
export type PriceBenchmark = z.infer<typeof PriceBenchmarkSchema>;

/** Longest alias/key contained in the item name wins ("developer laptop" beats "laptop"). */
export function matchCatalogItem(
  item: string,
  catalog: readonly CatalogItem[],
): CatalogItem | null {
  const name = item.toLowerCase();
  let best: { entry: CatalogItem; len: number } | null = null;
  for (const entry of catalog) {
    for (const term of [entry.key, ...entry.aliases]) {
      if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(name)) {
        if (!best || term.length > best.len) best = { entry, len: term.length };
      }
    }
  }
  return best?.entry ?? null;
}

export function benchmarkPrice(
  item: string,
  unitPriceUsd: number,
  catalog: readonly CatalogItem[],
): PriceBenchmark {
  const entry = matchCatalogItem(item, catalog);
  if (!entry) {
    return {
      matched_item: null,
      typical_min: null,
      typical_max: null,
      unit_price_usd: unitPriceUsd,
      verdict: "no_benchmark",
      policy_ref: null,
    };
  }
  const verdict =
    unitPriceUsd > entry.max
      ? "above_range"
      : unitPriceUsd < entry.min
        ? "below_range"
        : "within_range";
  return {
    matched_item: entry.key,
    typical_min: entry.min,
    typical_max: entry.max,
    unit_price_usd: unitPriceUsd,
    verdict,
    policy_ref: entry.policy_ref,
  };
}

export const getPriceBenchmarkTool = defineTool({
  name: "get_price_benchmark",
  description:
    "Compare a unit price with the internal price benchmark for that item type. Returns the " +
    "typical range, a verdict (within_range / above_range / below_range / no_benchmark) and the " +
    "policy that caps the price, if any.",
  input: z
    .object({
      item: z.string().min(2).max(120).describe("Item name, e.g. 'developer laptop'"),
      unit_price: z.number().positive(),
      currency: z.string().length(3),
    })
    .strict(),
  output: PriceBenchmarkSchema,
  timeoutMs: 2_000,
  async run({ item, unit_price, currency }, ctx) {
    return benchmarkPrice(
      item,
      toUsd(unit_price, currency, ctx.ref.approvalMatrix),
      ctx.ref.catalog,
    );
  },
});

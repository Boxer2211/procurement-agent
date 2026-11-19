import { z } from "zod";
import { CategorySchema } from "../domain/schemas.js";
import { evidenceIdOf } from "../rag/chunker.js";
import { defineTool } from "./types.js";

const MAX_TEXT = 1200;

export const searchPoliciesTool = defineTool({
  name: "search_policies",
  description:
    "Semantic search over the company's procurement policies. Returns the most relevant policy " +
    "sections with their evidence ids (policy:<ID>#<section>) to cite. General, budget and vendor " +
    "policies are always included; pass the request category to also get category-specific " +
    "policies. Call this before stating any policy requirement.",
  input: z
    .object({
      query: z.string().min(3).max(300).describe("Short natural-language query"),
      category: CategorySchema.nullable().describe("Request category, or null for all"),
      top_k: z.number().int().min(1).max(8).nullable().describe("Results to return (default 5)"),
    })
    .strict(),
  output: z.object({
    results: z.array(
      z.object({
        evidence_id: z.string(),
        policy_id: z.string(),
        title: z.string(),
        section: z.string(),
        heading: z.string(),
        text: z.string(),
        score: z.number(),
      }),
    ),
  }),
  timeoutMs: 15_000,
  async run({ query, category, top_k }, ctx) {
    const hits = await ctx.policies.search(query, {
      category: category === "other" ? null : category,
      topK: top_k ?? 5,
    });
    return {
      results: hits.map(({ chunk, score }) => ({
        evidence_id: evidenceIdOf(chunk),
        policy_id: chunk.policyId,
        title: chunk.title,
        section: chunk.section,
        heading: chunk.heading,
        text: chunk.text.length > MAX_TEXT ? `${chunk.text.slice(0, MAX_TEXT)}…` : chunk.text,
        score,
      })),
    };
  },
});

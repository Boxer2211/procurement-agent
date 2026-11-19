/** Split policy markdown files into citable chunks (one per numbered subsection). */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n/;
const HEADING = /^(#{2,3})\s+(.+?)\s*$/gm;
const SECTION_NO = /^(\d+(?:\.\d+)*)\.?\s+(.*)$/;

export const PolicyMetaSchema = z.object({
  policy_id: z.string().regex(/^[A-Z0-9-]+$/),
  title: z.string().min(1),
  category: z.string().min(1),
  version: z.coerce.string(),
  effective_from: z.union([z.string(), z.date()]).optional(),
  owner: z.string().optional(),
});
export type PolicyMeta = z.infer<typeof PolicyMetaSchema>;

export interface PolicyChunk {
  chunkId: string; // "<policy_id>#<section>"
  policyId: string;
  title: string;
  category: string;
  version: string;
  section: string;
  heading: string;
  text: string;
  quarantined: boolean;
  quarantineReason: string | null;
}

export const evidenceIdOf = (chunk: Pick<PolicyChunk, "chunkId">): string =>
  `policy:${chunk.chunkId}`;

export class PolicyParseError extends Error {
  override name = "PolicyParseError";
}

export function parsePolicy(
  markdown: string,
  source = "<string>",
): { meta: PolicyMeta; chunks: PolicyChunk[] } {
  const fm = FRONTMATTER.exec(markdown);
  if (!fm?.[1]) throw new PolicyParseError(`${source}: missing YAML frontmatter`);
  const rawMeta: unknown = parseYaml(fm[1]);
  const parsed = PolicyMetaSchema.safeParse(rawMeta);
  if (!parsed.success) {
    throw new PolicyParseError(`${source}: invalid frontmatter: ${parsed.error.message}`);
  }
  const meta = parsed.data;
  const body = markdown.slice(fm[0].length);

  const headings = [...body.matchAll(HEADING)];
  const chunks: PolicyChunk[] = [];
  let parentHeading = "";
  headings.forEach((h, idx) => {
    const level = h[1]?.length ?? 2;
    const title = h[2] ?? "";
    const start = (h.index ?? 0) + h[0].length;
    const end = headings[idx + 1]?.index ?? body.length;
    const content = body.slice(start, end).trim();
    if (level === 2) parentHeading = title;
    if (!content) return;
    const sec = SECTION_NO.exec(title);
    const section = sec?.[1] ?? String(idx + 1);
    chunks.push({
      chunkId: `${meta.policy_id}#${section}`,
      policyId: meta.policy_id,
      title: meta.title,
      category: meta.category,
      version: meta.version,
      section,
      heading: level === 2 ? title : `${parentHeading} › ${title}`,
      text: content,
      quarantined: false,
      quarantineReason: null,
    });
  });

  if (chunks.length === 0) throw new PolicyParseError(`${source}: no sections found`);
  const ids = chunks.map((c) => c.chunkId);
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (dupes.length > 0) {
    throw new PolicyParseError(`${source}: duplicate section numbers ${dupes.join(", ")}`);
  }
  return { meta, chunks };
}

export function loadPolicyDir(directory: string): PolicyChunk[] {
  const seen = new Set<string>();
  const out: PolicyChunk[] = [];
  const files = readdirSync(directory)
    .filter((f) => f.endsWith(".md"))
    .sort();
  for (const file of files) {
    const { meta, chunks } = parsePolicy(readFileSync(join(directory, file), "utf8"), file);
    if (seen.has(meta.policy_id)) {
      throw new PolicyParseError(`${file}: duplicate policy_id ${meta.policy_id}`);
    }
    seen.add(meta.policy_id);
    out.push(...chunks);
  }
  return out;
}

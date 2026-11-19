/** Policy indexes: pgvector (production) and in-memory BM25 (tests / no-Docker demo). */

import type pg from "pg";
import type { PolicyChunk } from "./chunker.js";
import type { Embedder } from "./embedder.js";

/** Policies of these categories apply to every request, whatever its category. */
export const GLOBAL_CATEGORIES = ["general", "budget", "vendor"] as const;

export interface SearchHit {
  chunk: PolicyChunk;
  score: number;
}

export interface SearchOptions {
  category: string | null;
  topK: number;
}

export interface PolicyIndex {
  upsert(chunks: readonly PolicyChunk[]): Promise<number>;
  search(query: string, opts: SearchOptions): Promise<SearchHit[]>;
}

const categoryOk = (chunkCategory: string, category: string | null): boolean =>
  category === null ||
  chunkCategory === category ||
  (GLOBAL_CATEGORIES as readonly string[]).includes(chunkCategory);

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

// --------------------------------------------------------------------------- in-memory BM25

const STOPWORDS = new Set(
  "a an the and or of to for in on at by with is are be must may can this that it as from any all each every not no than per we our you your".split(
    " ",
  ),
);

function stem(token: string): string {
  for (const suffix of ["ing", "es", "s"]) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

export function tokenize(text: string): string[] {
  const normalized = text.toLowerCase().replace(/(?<=\d),(?=\d{3})/g, ""); // "$5,000" -> "5000"
  return (normalized.match(/[a-z0-9]+/g) ?? []).filter((t) => !STOPWORDS.has(t)).map(stem);
}

export class InMemoryPolicyIndex implements PolicyIndex {
  private readonly chunks = new Map<string, PolicyChunk>();
  private readonly tokens = new Map<string, string[]>();

  constructor(
    private readonly k1 = 1.5,
    private readonly b = 0.75,
  ) {}

  async upsert(chunks: readonly PolicyChunk[]): Promise<number> {
    for (const c of chunks) {
      this.chunks.set(c.chunkId, c);
      this.tokens.set(c.chunkId, tokenize(`${c.title} ${c.heading} ${c.text}`));
    }
    return chunks.length;
  }

  async search(query: string, { category, topK }: SearchOptions): Promise<SearchHit[]> {
    const qTokens = tokenize(query);
    const candidates = [...this.chunks.values()].filter(
      (c) => !c.quarantined && categoryOk(c.category, category),
    );
    if (qTokens.length === 0 || candidates.length === 0) return [];

    const n = candidates.length;
    const docTokens = (c: PolicyChunk) => this.tokens.get(c.chunkId) ?? [];
    const avgLen = candidates.reduce((s, c) => s + docTokens(c).length, 0) / n;
    const df = new Map<string, number>();
    for (const c of candidates) {
      for (const t of new Set(docTokens(c))) df.set(t, (df.get(t) ?? 0) + 1);
    }

    const hits: SearchHit[] = [];
    for (const c of candidates) {
      const toks = docTokens(c);
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      let score = 0;
      for (const q of qTokens) {
        const f = tf.get(q);
        if (!f) continue;
        const d = df.get(q) ?? 0;
        const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
        score +=
          (idf * f * (this.k1 + 1)) /
          (f + this.k1 * (1 - this.b + (this.b * toks.length) / avgLen));
      }
      if (score > 0) hits.push({ chunk: c, score: round4(score) });
    }
    hits.sort((a, b) => b.score - a.score || a.chunk.chunkId.localeCompare(b.chunk.chunkId));
    return hits.slice(0, topK);
  }
}

// --------------------------------------------------------------------------- pgvector

const toVectorLiteral = (v: readonly number[]): string => `[${v.join(",")}]`;

interface ChunkRow {
  chunk_id: string;
  policy_id: string;
  title: string;
  category: string;
  version: string;
  section: string;
  heading: string;
  text: string;
  score: number;
}

export class PgPolicyIndex implements PolicyIndex {
  constructor(
    private readonly pool: pg.Pool,
    private readonly embedder: Embedder,
  ) {}

  async upsert(chunks: readonly PolicyChunk[]): Promise<number> {
    if (chunks.length === 0) return 0;
    const vectors = await this.embedder.embedDocuments(
      chunks.map((c) => `${c.heading}\n${c.text}`),
    );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const [i, c] of chunks.entries()) {
        const vec = vectors[i];
        if (!vec) throw new Error(`missing embedding for ${c.chunkId}`);
        await client.query(
          `INSERT INTO policy_chunks (chunk_id, policy_id, title, category, version, section,
             heading, text, quarantined, quarantine_reason, embedding)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector)
           ON CONFLICT (chunk_id) DO UPDATE SET
             policy_id = EXCLUDED.policy_id, title = EXCLUDED.title, category = EXCLUDED.category,
             version = EXCLUDED.version, section = EXCLUDED.section, heading = EXCLUDED.heading,
             text = EXCLUDED.text, quarantined = EXCLUDED.quarantined,
             quarantine_reason = EXCLUDED.quarantine_reason, embedding = EXCLUDED.embedding,
             updated_at = now()`,
          [
            c.chunkId,
            c.policyId,
            c.title,
            c.category,
            c.version,
            c.section,
            c.heading,
            c.text,
            c.quarantined,
            c.quarantineReason,
            toVectorLiteral(vec),
          ],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return chunks.length;
  }

  async search(query: string, { category, topK }: SearchOptions): Promise<SearchHit[]> {
    const vec = toVectorLiteral(await this.embedder.embedQuery(query));
    const { rows } = await this.pool.query<ChunkRow>(
      `SELECT chunk_id, policy_id, title, category, version, section, heading, text,
              1 - (embedding <=> $1::vector) AS score
       FROM policy_chunks
       WHERE NOT quarantined
         AND ($2::text IS NULL OR category = $2 OR category = ANY($3::text[]))
       ORDER BY embedding <=> $1::vector
       LIMIT $4`,
      [vec, category, [...GLOBAL_CATEGORIES], topK],
    );
    return rows.map((r) => ({
      chunk: {
        chunkId: r.chunk_id,
        policyId: r.policy_id,
        title: r.title,
        category: r.category,
        version: r.version,
        section: r.section,
        heading: r.heading,
        text: r.text,
        quarantined: false,
        quarantineReason: null,
      },
      score: round4(Number(r.score)),
    }));
  }
}

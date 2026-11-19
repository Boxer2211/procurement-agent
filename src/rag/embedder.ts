/** Text embeddings. Local model via transformers.js: no extra API key, deterministic, CI-friendly. */

export interface Embedder {
  readonly dim: number;
  embedDocuments(texts: readonly string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

// BGE models expect this instruction prefix on queries (not on passages).
const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

type FeatureExtractor = (
  texts: string | string[],
  opts: { pooling: "cls" | "mean"; normalize: boolean },
) => Promise<{
  tolist(): number[][];
}>;

export class TransformersEmbedder implements Embedder {
  readonly dim: number;
  private extractor: Promise<FeatureExtractor> | null = null;

  constructor(
    private readonly modelName = "Xenova/bge-small-en-v1.5",
    dim = 384,
  ) {
    this.dim = dim;
  }

  private load(): Promise<FeatureExtractor> {
    this.extractor ??= import("@huggingface/transformers").then(
      ({ pipeline }) =>
        pipeline("feature-extraction", this.modelName) as unknown as Promise<FeatureExtractor>,
    );
    return this.extractor;
  }

  async embedDocuments(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extract = await this.load();
    const out = await extract([...texts], { pooling: "cls", normalize: true });
    return out.tolist();
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.embedDocuments([BGE_QUERY_PREFIX + text]);
    if (!vec) throw new Error("embedding failed");
    return vec;
  }
}

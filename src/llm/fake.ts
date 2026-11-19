/**
 * Deterministic LLM for tests and offline demos. Responses are scripted per graph node
 * and consumed in order; every request is recorded for assertions.
 */

import { z } from "zod";
import {
  type ContentBlock,
  type LLMClient,
  LLMError,
  type LLMErrorKind,
  type LLMRequest,
  type LLMResponse,
  type ToolUseBlock,
} from "./types.js";

const ToolCallSchema = z.object({ name: z.string(), input: z.unknown() });

export const ScriptedResponseSchema = z.union([
  z.object({ json: z.unknown() }).strict(),
  z.object({ text: z.string() }).strict(),
  z.object({ toolCalls: z.array(ToolCallSchema).min(1), text: z.string().optional() }).strict(),
  z
    .object({
      error: z.object({
        kind: z.string(),
        message: z.string(),
        retryable: z.boolean().optional(),
      }),
    })
    .strict(),
]);
export type ScriptedResponse = z.infer<typeof ScriptedResponseSchema>;

export const LLMScriptSchema = z.record(z.string(), z.array(ScriptedResponseSchema));
export type LLMScript = z.infer<typeof LLMScriptSchema>;

export class ScriptExhaustedError extends Error {
  override name = "ScriptExhaustedError";
}

export class ScriptedFakeLLM implements LLMClient {
  readonly calls: LLMRequest[] = [];
  private readonly queues: Map<string, ScriptedResponse[]>;
  private toolSeq = 0;

  constructor(script: LLMScript) {
    this.queues = new Map(
      Object.entries(LLMScriptSchema.parse(script)).map(([k, v]) => [k, [...v]]),
    );
  }

  remaining(node?: string): number {
    if (node) return this.queues.get(node)?.length ?? 0;
    return [...this.queues.values()].reduce((s, q) => s + q.length, 0);
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(structuredClone({ ...req, outputSchema: undefined }));
    const next = this.queues.get(req.node)?.shift();
    if (!next) throw new ScriptExhaustedError(`no scripted response left for node '${req.node}'`);

    if ("error" in next) {
      throw new LLMError(
        next.error.message,
        next.error.kind as LLMErrorKind,
        next.error.retryable ?? false,
      );
    }

    const content: ContentBlock[] = [];
    const toolUses: ToolUseBlock[] = [];
    if ("toolCalls" in next) {
      if (next.text) content.push({ type: "text", text: next.text });
      for (const call of next.toolCalls) {
        const block: ToolUseBlock = {
          type: "tool_use",
          id: `toolu_fake_${++this.toolSeq}`,
          name: call.name,
          input: call.input,
        };
        content.push(block);
        toolUses.push(block);
      }
    } else {
      const text = "json" in next ? JSON.stringify(next.json) : next.text;
      content.push({ type: "text", text });
    }

    const text = content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    return {
      model: req.model,
      content,
      text,
      toolUses,
      stopReason: toolUses.length > 0 ? "tool_use" : "end_turn",
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  }
}

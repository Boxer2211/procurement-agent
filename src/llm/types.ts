/** Provider-neutral LLM contract used by graph nodes. Implemented by AnthropicLLM and ScriptedFakeLLM. */

import type { z } from "zod";

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  strict: true;
}

export interface TextBlock {
  type: "text";
  text: string;
}
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
/** Blocks we do not inspect (thinking, fallback, ...) are passed back to the API unchanged. */
export interface OpaqueBlock {
  type: string;
  [key: string]: unknown;
}
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | OpaqueBlock;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LLMRequest<T = unknown> {
  /** Graph node issuing the call: used for tracing and by the scripted fake. */
  node: string;
  model: string;
  system: string;
  messages: readonly ChatMessage[];
  tools?: readonly ToolDefinition[];
  /** When set, the final text must be JSON matching this schema (structured outputs). */
  outputSchema?: z.ZodType<T>;
  maxTokens: number;
  effort: Effort;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMResponse {
  model: string;
  /** Raw assistant content, to be appended to the conversation as-is. */
  content: ContentBlock[];
  text: string;
  toolUses: ToolUseBlock[];
  stopReason: string;
  usage: LLMUsage;
}

export interface LLMClient {
  complete(req: LLMRequest): Promise<LLMResponse>;
}

export type LLMErrorKind =
  | "refusal"
  | "max_tokens"
  | "rate_limit"
  | "overloaded"
  | "connection"
  | "auth"
  | "bad_request"
  | "api";

export class LLMError extends Error {
  override name = "LLMError";
  constructor(
    message: string,
    readonly kind: LLMErrorKind,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export const isToolUse = (b: ContentBlock): b is ToolUseBlock =>
  b.type === "tool_use" && typeof (b as ToolUseBlock).id === "string";

export const isText = (b: ContentBlock): b is TextBlock =>
  b.type === "text" && typeof (b as TextBlock).text === "string";

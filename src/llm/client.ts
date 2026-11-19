/** LLMClient backed by the official Anthropic SDK. */

import Anthropic from "@anthropic-ai/sdk";
import type { Settings } from "../config.js";
import { toStrictJsonSchema } from "./jsonSchema.js";
import {
  type ContentBlock,
  isText,
  isToolUse,
  type LLMClient,
  LLMError,
  type LLMRequest,
  type LLMResponse,
} from "./types.js";

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class AnthropicLLM implements LLMClient {
  private readonly client: Anthropic;

  constructor(
    private readonly settings: Pick<
      Settings,
      "ANTHROPIC_API_KEY" | "LLM_TIMEOUT_MS" | "LLM_MAX_RETRIES" | "LLM_FALLBACKS"
    >,
    client?: Anthropic,
  ) {
    // The SDK retries 408/409/429/5xx and connection errors with exponential backoff.
    this.client =
      client ??
      new Anthropic({
        apiKey: settings.ANTHROPIC_API_KEY,
        timeout: settings.LLM_TIMEOUT_MS,
        maxRetries: settings.LLM_MAX_RETRIES,
      });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages as Anthropic.Beta.Messages.BetaMessageParam[],
      thinking: { type: "adaptive" },
      output_config: {
        effort: req.effort,
        ...(req.outputSchema
          ? { format: { type: "json_schema", schema: toStrictJsonSchema(req.outputSchema) } }
          : {}),
      },
      ...(req.tools?.length
        ? {
            tools: req.tools as unknown as Anthropic.Beta.Messages.BetaTool[],
            tool_choice: { type: "auto" }, // forced tool_choice returns 400 on current models
          }
        : {}),
      ...(this.settings.LLM_FALLBACKS ? { betas: [FALLBACK_BETA], fallbacks: "default" } : {}),
    };

    let message: Anthropic.Beta.Messages.BetaMessage;
    try {
      message = await this.client.beta.messages.create(params);
    } catch (err) {
      throw toLLMError(err);
    }

    if (message.stop_reason === "refusal") {
      const category = message.stop_details?.category ?? "unknown";
      throw new LLMError(`model declined the request (category: ${category})`, "refusal", false);
    }
    if (message.stop_reason === "max_tokens") {
      throw new LLMError("response truncated at max_tokens", "max_tokens", true);
    }

    const content = message.content as unknown as ContentBlock[];
    return {
      model: message.model,
      content,
      text: content
        .filter(isText)
        .map((b) => b.text)
        .join(""),
      toolUses: content.filter(isToolUse),
      stopReason: message.stop_reason ?? "unknown",
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      },
    };
  }
}

/** Map SDK errors (most specific first) to LLMError. Retries already happened inside the SDK. */
export function toLLMError(err: unknown): LLMError {
  if (err instanceof LLMError) return err;
  if (err instanceof Anthropic.RateLimitError) {
    return new LLMError("rate limited by the API", "rate_limit", true);
  }
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  ) {
    return new LLMError("API authentication failed: check ANTHROPIC_API_KEY", "auth", false);
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new LLMError(`bad request: ${err.message}`, "bad_request", false);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new LLMError(`connection error: ${err.message}`, "connection", true);
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    if (status === 529 || status === 503) return new LLMError("API overloaded", "overloaded", true);
    return new LLMError(`API error ${status}: ${err.message}`, "api", status >= 500);
  }
  return new LLMError(err instanceof Error ? err.message : String(err), "api", false);
}

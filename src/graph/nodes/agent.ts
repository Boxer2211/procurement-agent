/** agent: the tool-using reviewer (Claude + strict tools + structured final answer). */

import { AgentDraftSchema, LLM_DECISIONS } from "../../domain/schemas.js";
import { loadPrompt, wrapJson, wrapUserRequest } from "../../llm/prompting.js";
import type { ChatMessage } from "../../llm/types.js";
import { maskPii } from "../../observability/logger.js";
import { type GraphDeps, makeStep, parseStructured, rethrowIfRetryable, timer } from "../deps.js";
import type { State, Update } from "../state.js";

const MAX_FORMAT_RETRIES = 1;
/** Extra turns allowed after the tool budget notice before the loop is cut. */
const HARD_LIMIT_SLACK = 1;

export function buildAgentInput(state: State): string {
  return [
    wrapUserRequest(state.text),
    wrapJson("purchase_request", state.request),
    wrapJson("review_plan", {
      checks: state.reviewPlan?.checks ?? [],
      search_queries: state.reviewPlan?.searchQueries ?? [],
    }),
    "Review this request following your instructions, then give your final answer.",
  ].join("\n\n");
}

export const makeAgentNode =
  (deps: GraphDeps) =>
  async (state: State): Promise<Update> => {
    const s = deps.settings;
    if (state.iterations > s.MAX_ITERATIONS + HARD_LIMIT_SLACK) {
      return {
        agentNext: "done",
        pendingToolUses: [],
        flags: ["iteration_limit"],
        steps: [
          makeStep("agent", "info", "iteration_limit", {
            error: `stopped after ${state.iterations} tool rounds`,
          }),
        ],
      };
    }

    const newMessages: ChatMessage[] = [];
    if (state.messages.length === 0)
      newMessages.push({ role: "user", content: buildAgentInput(state) });
    const conversation = [...state.messages, ...newMessages];
    const system = loadPrompt("agent", s.PROMPT_VERSION, {
      allowed_decisions: LLM_DECISIONS.join(", "),
    });

    const elapsed = timer();
    let res: Awaited<ReturnType<GraphDeps["llm"]["complete"]>>;
    try {
      res = await deps.llm.complete({
        node: "agent",
        model: s.AGENT_MODEL,
        effort: s.AGENT_EFFORT,
        maxTokens: 16000,
        system,
        messages: conversation,
        tools: deps.tools.definitions(),
        outputSchema: AgentDraftSchema,
      });
    } catch (err) {
      rethrowIfRetryable(err);
      const message = err instanceof Error ? err.message : String(err);
      return {
        messages: newMessages,
        agentNext: "done",
        pendingToolUses: [],
        error: `agent failed: ${message}`,
        flags: ["llm_error"],
        steps: [makeStep("agent", "llm", "agent", { error: message, durationMs: elapsed() })],
      };
    }

    const usage = res.usage;
    const llmStep = (output: unknown, error: string | null = null) =>
      makeStep("agent", "llm", `agent.turn${state.iterations + 1}`, {
        input: { model: s.AGENT_MODEL, effort: s.AGENT_EFFORT, messages: conversation.length },
        output,
        error,
        durationMs: elapsed(),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    const assistant: ChatMessage = { role: "assistant", content: res.content };

    if (res.toolUses.length > 0) {
      return {
        messages: [...newMessages, assistant],
        pendingToolUses: res.toolUses,
        iterations: state.iterations + 1,
        agentNext: "tools",
        usage,
        steps: [
          llmStep({ tool_calls: res.toolUses.map((t) => ({ name: t.name, input: t.input })) }),
        ],
      };
    }

    const parsed = parseStructured(AgentDraftSchema, res.text);
    if (parsed.ok) {
      return {
        messages: [...newMessages, assistant],
        draft: parsed.value,
        pendingToolUses: [],
        agentNext: "done",
        usage,
        steps: [llmStep(parsed.value)],
      };
    }

    if (state.formatRetries < MAX_FORMAT_RETRIES) {
      return {
        messages: [
          ...newMessages,
          assistant,
          {
            role: "user",
            content: `Your final answer failed validation (${parsed.error}). Reply with the final JSON only.`,
          },
        ],
        formatRetries: state.formatRetries + 1,
        agentNext: "agent",
        usage,
        steps: [llmStep({ raw: maskPii(res.text.slice(0, 2000)) }, parsed.error)],
      };
    }
    return {
      messages: [...newMessages, assistant],
      agentNext: "done",
      pendingToolUses: [],
      error: `agent produced invalid output: ${parsed.error}`,
      flags: ["llm_error"],
      usage,
      steps: [llmStep({ raw: maskPii(res.text.slice(0, 2000)) }, parsed.error)],
    };
  };

export const routeAfterAgent = (state: State): "tools" | "agent" | "facts" => {
  if (state.agentNext === "tools" && state.pendingToolUses.length > 0) return "tools";
  if (state.agentNext === "agent") return "agent";
  return "facts";
};

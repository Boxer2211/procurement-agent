/** tools: execute the agent's pending tool calls (in parallel) and feed results back. */

import { escapeTags } from "../../llm/prompting.js";
import type { ContentBlock, ToolResultBlock } from "../../llm/types.js";
import { type GraphDeps, makeStep } from "../deps.js";
import type { State, ToolCallRecord, Update } from "../state.js";

export function nextEvidenceId(
  name: string,
  existing: readonly ToolCallRecord[],
  offset = 0,
): string {
  return `tool:${name}#${existing.filter((c) => c.name === name).length + offset + 1}`;
}

export const makeToolsNode =
  (deps: GraphDeps) =>
  async (state: State): Promise<Update> => {
    const pending = state.pendingToolUses;
    const seenInBatch = new Map<string, number>();
    const planned = pending.map((use) => {
      const offset = seenInBatch.get(use.name) ?? 0;
      seenInBatch.set(use.name, offset + 1);
      return { use, evidenceId: nextEvidenceId(use.name, state.toolCalls, offset) };
    });

    const executions = await Promise.all(
      planned.map(({ use }) => deps.tools.execute(use.name, use.input)),
    );

    const records: ToolCallRecord[] = [];
    const results: ContentBlock[] = [];
    const steps = planned.map(({ use, evidenceId }, i) => {
      const exec = executions[i];
      if (!exec) throw new Error("missing tool execution result");
      records.push({
        evidenceId,
        toolUseId: use.id,
        name: use.name,
        input: use.input,
        ok: exec.ok,
        output: exec.ok ? exec.output : null,
        error: exec.ok ? null : exec.error,
        internalError: exec.ok ? null : exec.internalError,
        initiator: "agent",
      });
      const block: ToolResultBlock = exec.ok
        ? {
            type: "tool_result",
            tool_use_id: use.id,
            content: escapeTags(
              JSON.stringify({ evidence_id: evidenceId, ...(exec.output as object) }),
            ),
          }
        : {
            type: "tool_result",
            tool_use_id: use.id,
            content: `Error: ${exec.error}`,
            is_error: true,
          };
      results.push(block);
      return makeStep("tools", "tool", use.name, {
        input: { evidenceId, args: use.input },
        output: exec.ok ? exec.output : null,
        error: exec.ok ? null : (exec.internalError ?? exec.error),
        durationMs: exec.durationMs,
      });
    });

    if (state.iterations >= deps.settings.MAX_ITERATIONS) {
      results.push({
        type: "text",
        text: "Tool budget exhausted. Do not call more tools; give your final answer now with the evidence you have.",
      });
    }

    return {
      messages: [{ role: "user", content: results }],
      toolCalls: records,
      pendingToolUses: [],
      steps,
    };
  };

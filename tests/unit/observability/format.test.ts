import { describe, expect, it } from "vitest";
import { formatTrace } from "../../../src/observability/format.js";

describe("formatTrace", () => {
  it("renders one row per step with tokens and errors", () => {
    const at = new Date().toISOString();
    const out = formatTrace([
      {
        seq: 1,
        node: "agent",
        kind: "llm",
        name: "agent.turn1",
        input: { model: "m" },
        output: null,
        error: null,
        durationMs: 1200,
        inputTokens: 900,
        outputTokens: 120,
        at,
      },
      {
        seq: 2,
        node: "tools",
        kind: "tool",
        name: "get_budget",
        input: null,
        output: null,
        error: "No budget",
        durationMs: 3,
        inputTokens: null,
        outputTokens: null,
        at,
      },
    ]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/agent\.turn1 .* 1200ms 900→120 tok/);
    expect(lines[2]).toMatch(/ERROR No budget/);
  });
});

import { describe, expect, it } from "vitest";
import { budgetPeriod, loadSettings, quarterOf } from "../../../src/config.js";

describe("settings", () => {
  it("applies defaults", () => {
    const s = loadSettings({});
    expect(s).toMatchObject({
      AGENT_MODEL: "claude-opus-5-5",
      VERIFIER_MODEL: "claude-sonnet-5-5",
      STORAGE: "postgres",
      MAX_ITERATIONS: 8,
      LLM_FALLBACKS: true,
    });
    expect(s.BUDGET_PERIOD).toBeUndefined();
  });

  it("parses env strings", () => {
    const s = loadSettings({
      MAX_ITERATIONS: "3",
      LLM_FALLBACKS: "false",
      BUDGET_PERIOD: "2026-Q4",
      STORAGE: "memory",
    });
    expect(s).toMatchObject({
      MAX_ITERATIONS: 3,
      LLM_FALLBACKS: false,
      BUDGET_PERIOD: "2026-Q4",
      STORAGE: "memory",
    });
  });

  it("treats an empty BUDGET_PERIOD as unset", () => {
    expect(loadSettings({ BUDGET_PERIOD: "" }).BUDGET_PERIOD).toBeUndefined();
  });

  it("rejects invalid values", () => {
    expect(() => loadSettings({ MAX_ITERATIONS: "0" })).toThrow();
    expect(() => loadSettings({ BUDGET_PERIOD: "Q4-2026" })).toThrow();
    expect(() => loadSettings({ AGENT_EFFORT: "extreme" })).toThrow();
  });
});

describe("budget period", () => {
  it("computes calendar quarters in UTC", () => {
    expect(quarterOf(new Date("2026-11-19T00:00:00Z"))).toBe("2026-Q4");
    expect(quarterOf(new Date("2027-01-01T00:00:00Z"))).toBe("2027-Q1");
  });

  it("prefers the configured period", () => {
    expect(budgetPeriod({ BUDGET_PERIOD: "2026-Q4" }, new Date("2030-05-01"))).toBe("2026-Q4");
    expect(budgetPeriod({ BUDGET_PERIOD: undefined }, new Date("2030-05-01T00:00:00Z"))).toBe(
      "2030-Q2",
    );
  });
});

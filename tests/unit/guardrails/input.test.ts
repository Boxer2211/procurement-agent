import { describe, expect, it } from "vitest";
import { normalizeInput, validateInput } from "../../../src/guardrails/input.js";

describe("normalizeInput", () => {
  it("strips zero-width, bidi and control characters and collapses whitespace", () => {
    expect(normalizeInput("  buy​ 5\tlaptops‮\u0007  ")).toBe("buy 5 laptops");
  });

  it("applies NFKC normalisation (full-width digits)", () => {
    expect(normalizeInput("＄７５００")).toBe("$7500");
  });
});

describe("validateInput", () => {
  it("accepts a normal purchase request", () => {
    const r = validateInput("We need to purchase 5 laptops for $7,500 from TechSupply.", 4000);
    expect(r).toEqual({
      ok: true,
      text: "We need to purchase 5 laptops for $7,500 from TechSupply.",
    });
  });

  it.each([
    [undefined, "empty_request"],
    [null, "empty_request"],
    [42, "empty_request"],
    ["", "empty_request"],
    ["   \n\t ", "empty_request"],
    ["​​", "empty_request"],
    ["$$$ 123 !!!", "request_not_understandable"],
    ["buy it", "request_not_understandable"],
  ])("rejects %j with %s", (input, reason) => {
    const r = validateInput(input, 4000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });

  it("rejects requests over the length limit", () => {
    const r = validateInput("word ".repeat(100), 50);
    expect(r).toMatchObject({ ok: false, reason: "request_too_long" });
    expect(r.text.length).toBe(50);
  });
});

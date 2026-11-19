import { describe, expect, it } from "vitest";
import {
  approxEqual,
  formatMoney,
  fromCents,
  mulCents,
  toCents,
} from "../../../src/domain/money.js";
import { decisionSeverity, mostSevere } from "../../../src/domain/schemas.js";

describe("money", () => {
  it("converts to integer cents without float drift", () => {
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(7500)).toBe(750000);
    expect(fromCents(toCents(19.99))).toBe(19.99);
  });

  it("multiplies unit cents by quantity", () => {
    expect(mulCents(toCents(1500), 5)).toBe(toCents(7500));
  });

  it("compares with a relative tolerance", () => {
    expect(approxEqual(toCents(7500), toCents(7560))).toBe(true);
    expect(approxEqual(toCents(7500), toCents(8000))).toBe(false);
    expect(approxEqual(toCents(0), toCents(0))).toBe(true);
  });

  it("rejects non-finite amounts", () => {
    expect(() => toCents(Number.NaN)).toThrow(RangeError);
  });

  it("formats currency", () => {
    expect(formatMoney(7500)).toBe("$7,500.00");
    expect(formatMoney(1200.5, "EUR")).toBe("€1,200.50");
  });
});

describe("decision severity", () => {
  it("orders decisions so rules can only tighten", () => {
    expect(decisionSeverity("recommend_approve")).toBeLessThan(decisionSeverity("needs_info"));
    expect(mostSevere("recommend_approve", "needs_info")).toBe("needs_info");
    expect(mostSevere("escalate_to_human", "recommend_reject", "needs_info")).toBe(
      "recommend_reject",
    );
    expect(mostSevere("recommend_approve")).toBe("recommend_approve");
  });
});

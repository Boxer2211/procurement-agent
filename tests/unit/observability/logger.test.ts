import { describe, expect, it } from "vitest";
import { maskPii } from "../../../src/observability/logger.js";

describe("maskPii", () => {
  it("masks emails and phone numbers", () => {
    expect(maskPii("Contact john.doe+x@corp.example.com or +1 (415) 555-0100 asap")).toBe(
      "Contact [email] or [phone] asap",
    );
  });

  it("keeps amounts, dates and short numbers", () => {
    const text = "5 laptops for $7,500 by 2026-12-01, PO 123456";
    expect(maskPii(text)).toBe(text);
  });
});

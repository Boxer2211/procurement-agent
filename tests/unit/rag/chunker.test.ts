import { describe, expect, it } from "vitest";
import {
  evidenceIdOf,
  loadPolicyDir,
  PolicyParseError,
  parsePolicy,
} from "../../../src/rag/chunker.js";
import { DATA_DIR } from "../../helpers.js";

const DOC = `---
policy_id: TEST-001
title: Test Policy
category: hardware
version: 1.2
---

## 1. Intro
Intro text without subsections.

## 2. Rules
### 2.1 First rule
Must do A.

### 2.2 Second rule
Must not do B.
`;

describe("parsePolicy", () => {
  it("creates one chunk per numbered subsection with citation ids", () => {
    const { meta, chunks } = parsePolicy(DOC);
    expect(meta.policy_id).toBe("TEST-001");
    expect(meta.version).toBe("1.2");
    expect(chunks.map((c) => c.chunkId)).toEqual(["TEST-001#1", "TEST-001#2.1", "TEST-001#2.2"]);
    expect(chunks[1]).toMatchObject({
      heading: "2. Rules › 2.1 First rule",
      text: "Must do A.",
      category: "hardware",
      quarantined: false,
    });
    expect(evidenceIdOf(chunks[2]!)).toBe("policy:TEST-001#2.2");
  });

  it("rejects a file without frontmatter", () => {
    expect(() => parsePolicy("## 1. x\ntext")).toThrow(PolicyParseError);
  });

  it("rejects invalid policy ids", () => {
    expect(() => parsePolicy(DOC.replace("TEST-001", "test 001"))).toThrow(/invalid frontmatter/);
  });

  it("rejects duplicate section numbers", () => {
    const dup = `${DOC}\n### 2.2 Again\nDuplicate.\n`;
    expect(() => parsePolicy(dup)).toThrow(/duplicate section numbers/);
  });

  it("rejects a file with no sections", () => {
    expect(() =>
      parsePolicy("---\npolicy_id: X-1\ntitle: t\ncategory: c\nversion: 1\n---\nno headings"),
    ).toThrow(/no sections/);
  });
});

describe("data/policies corpus", () => {
  const chunks = loadPolicyDir(`${DATA_DIR}/policies`);

  it("parses all 7 policies with unique chunk ids", () => {
    const policies = new Set(chunks.map((c) => c.policyId));
    expect([...policies].sort()).toEqual([
      "BUD-001",
      "HW-STD-001",
      "PROC-001",
      "PROC-002",
      "SVC-001",
      "SW-001",
      "VEN-001",
    ]);
    expect(new Set(chunks.map((c) => c.chunkId)).size).toBe(chunks.length);
  });

  it("contains the sections the rules engine references", () => {
    const ids = new Set(chunks.map((c) => c.chunkId));
    for (const id of [
      "PROC-001#4.2",
      "PROC-001#5.1",
      "PROC-002#2.3",
      "VEN-001#3.1",
      "BUD-001#2.1",
    ]) {
      expect(ids).toContain(id);
    }
  });
});

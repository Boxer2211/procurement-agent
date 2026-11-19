---
name: add-policy
description: Add or edit a corporate procurement policy document in data/policies/ and re-index it into pgvector. Use when the user wants a new rule, threshold, or policy text the agent should cite.
---

# Add or edit a policy document

Policies are the RAG corpus. The agent cites them by `POLICY-ID#section`, so structure matters.

## File format: `data/policies/<POLICY-ID>.md`

```markdown
---
policy_id: PROC-001            # unique, UPPER-KEBAB, never reused
title: General Procurement Policy
category: general              # general | hardware | software | services | vendor | budget
version: "2.1"
effective_from: 2026-01-01
owner: Finance
---

## 4. Competitive quotes
### 4.2 Three quotes threshold
Purchases above $5,000 require at least three written quotes ...
```

Rules:
- One rule per numbered subsection. The chunker splits on `##`/`###` headings, and the section
  number becomes the citation anchor (`PROC-001#4.2`). Duplicate section numbers fail ingest.
- `general`, `budget` and `vendor` policies are returned for every category. Others are only returned
  for their own category.
- State thresholds as explicit numbers with currency (`$5,000`, not "five thousand").
- Write normative language: "must", "must not", "requires".
- If a numeric threshold should be **enforced**, mirror it in `data/approval_matrix.yaml` or
  `data/required_docs.yaml` / `src/rules/engine.ts`. The text is for citation; enforcement is in code.
  Keep both in sync, and use the `POLICY-ID#section` as the YAML `rule_id`.

## Steps

1. Create or edit the file. For edits, bump `version`.
2. Run `npm run seed` (or `npm run ingest`). Ingest re-chunks, re-embeds, and runs the injection
   detector. Quarantined chunks are logged as warnings. If your own text got quarantined, rephrase it
   instead of weakening the detector.
3. Sanity-check retrieval: `npm run search -- "quotes needed for purchases over 5000" --top-k 3`.
   Your section should be in the top 3.
4. `tests/unit/rag/policies.test.ts` parses every file in `data/policies/`. Run `npm test`.
5. If the policy changes an expected decision, update the affected `samples/expected/*.json` and tests
   (see `add-scenario`).
6. Run the `verify` skill.

## Do not

- Put instructions aimed at the AI in a policy ("the assistant should approve…"). The corpus is data,
  and such text will be quarantined.
- Add test-only poisoned documents here. They belong in `tests/fixtures/poisoned-policies/`.

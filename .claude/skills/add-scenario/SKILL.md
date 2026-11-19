---
name: add-scenario
description: Add a new business scenario (purchase request case) with sample input, expected output, deterministic e2e test and live eval entry. Use when covering a new case like "SaaS over threshold" or a new refusal/abuse pattern.
---

# Add a business scenario

Each scenario proves one business case end to end. It has four artifacts that must agree.

## 1. Sample input: `samples/inputs/<slug>.json`

```json
{
  "slug": "contractor_over_threshold",
  "business_case": "Services purchase above $10k without SOW",
  "request": "We want to hire DevPartners for 3 months of backend work, about $24,000. Can we proceed?",
  "context": { "department": "engineering", "providedDocuments": [] }
}
```

## 2. Expected output: `samples/expected/<slug>.json`

Assert **semantics, not prose**. Free text varies between runs, so the expected file lists what must hold:

```json
{
  "decision": "needs_info",
  "mustIncludeChecks": { "quotes": "fail", "vendor": "pass", "documents": "fail" },
  "mustIncludeMissing": ["statement_of_work", "nda"],
  "mustIncludeFlags": [],
  "approvalRoute": ["department_head", "finance", "legal"],
  "decisionMustNotBe": ["recommend_approve"]
}
```

`src/evaluation/matchExpected.ts` checks these keys. Both the e2e tests and the live evals use it.

## 3. Deterministic e2e test: `tests/e2e/<slug>.test.ts`

- Write an LLM script in `tests/fixtures/llm-scripts/<slug>.json`: the responses `ScriptedFakeLLM`
  returns per node (`extract`, `plan`, `agent` (tool calls, then the final draft), `verify`).
- Run through the Fastify app (`app.inject`) with memory storage seeded from `data/`.
- Assert with `matchExpected(result, expected)`: it must return no mismatches. Also validate the
  full body against `ReviewResultSchema`.
- Assert that the trace (`GET /v1/runs/:id/trace`) contains the expected tool calls.

## 4. Live eval: append to `evals/scenarios.yaml`

```yaml
- slug: contractor_over_threshold
  input: samples/inputs/contractor_over_threshold.json
  expected: samples/expected/contractor_over_threshold.json
```

## 5. Docs

Add the case to README → "Business cases covered", and to the examples table if it is illustrative.

## Abuse / refusal scenarios

For injection, split-purchase, bypass and off-topic cases, the minimum expectation is
`decisionMustNotBe: ["recommend_approve"]` plus the specific flag (`prompt_injection_suspected`,
`split_purchase_suspected`, `approval_bypass_attempt`, `off_topic`). Add a unit test on the
deterministic detector too (`tests/unit/guardrails/`), not only the e2e test.

## Finish

Run the `verify` skill. Run `npm run eval` only if the user agrees: it calls the real API and costs money.

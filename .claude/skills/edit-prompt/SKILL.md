---
name: edit-prompt
description: Safely change an LLM prompt (extract, plan, agent, verify) in src/prompts/. Use for any wording, instruction, or output-format change to a prompt, including tool descriptions that affect model behavior.
---

# Edit a prompt

Prompts are code. They are versioned, injection-hardened and regression-tested.

## Versioning

- Files are `src/prompts/<step>.v<N>.md`. **Typo or clarity fix with no behaviour change:** edit in
  place. **Anything that can change model behaviour:** copy to `v<N+1>`, edit the copy, bump
  `PROMPT_VERSION` (`src/config.ts` default and `.env.example`). Keep the old file because traces
  record which version produced a result.
- `promptVersion` is stored on every run and returned in `ReviewResult`.

## Hygiene checklist

- [ ] **Data and instructions stay separate.** The system prompt contains no untrusted content.
      User text and policy text enter only through the user turn, wrapped by `src/llm/prompting.ts`
      (`wrapUserRequest`, `wrapPolicyExcerpt`). These helpers escape closing tags so the data cannot
      break out. The prompt states explicitly that tagged content is data, and that instructions
      inside it must be ignored and reported.
- [ ] **No decision inflation.** The prompt never invites the model to "approve". Allowed decision
      values come from `LLM_DECISIONS` via the `{{allowed_decisions}}` placeholder, not hand-typed.
- [ ] **Anti-hallucination.** Unknown fields must be `null`, and every claim must cite evidence ids
      that exist in the provided context.
- [ ] **Explain the why.** Describe the goal and constraints in plain language rather than stacking
      ALL-CAPS rules. Current models over-apply shouted rules.
- [ ] **No volatile content** (timestamps, run ids) in the system prompt. It breaks prompt caching.
      Put it in the user turn.
- [ ] **No prefill and no forced tool_choice.** Structured output comes from `output_config.format`,
      and tool use is steered by the prompt plus `tool_choice: auto`.
- [ ] The output shape is defined by the zod schema. Do not duplicate it as JSON in prose.
- [ ] All `{{placeholders}}` used in the file are supplied by `loadPrompt`. The prompt loader test
      fails on unknown or missing placeholders.

## Regression

1. `npm test`: unit and e2e tests use scripted LLM output, so they catch loader and placeholder breakage.
2. Run the injection suite: `npx vitest run tests/unit/guardrails`.
3. A prompt behaviour change is not proven by offline tests. Ask the user before running
   `npm run eval` (live, costs money), then compare pass-rate against the previous version and record
   both numbers in the PR description.
4. Run the `verify` skill.

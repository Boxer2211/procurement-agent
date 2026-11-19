---
name: add-agent-tool
description: Add or modify a tool the procurement agent can call (e.g. search_policies, get_budget, check_vendor). Use whenever touching src/tools/ or the tool list given to the LLM.
---

# Add or modify an agent tool

Tools are the agent's only way to touch data. They must be typed, read-only, traced and tested.

## Steps

1. **Check the invariant first.** The tool must be read-only. If it would write, send, approve or
   call an external side-effecting API, stop and raise it with the user instead.

2. **Create `src/tools/<camelName>.ts`** following this shape:

   ```ts
   const input = z.object({
     department: z.string().min(1).max(64).describe("Department slug, e.g. 'engineering'"),
     category: CategorySchema,
   }).strict();

   const output = z.object({ remaining: z.number(), currency: z.string() });

   export const getBudgetTool = defineTool({
     name: "get_budget",
     description:
       "Return allocated/spent/committed/remaining budget for a department and category in the " +
       "current budget period. Use before judging whether a purchase fits the budget.",
     input,
     output,
     timeoutMs: 5_000,
     async run(args, ctx) { ... },   // args is z.infer<typeof input>
   });
   ```

   - The description says **what it returns and when to use it**. The model picks tools by this text.
   - Bound every input: lengths, `topK <= 8`, positive amounts, enums for categories. zod enforces
     these locally. The JSON schema sent to the API has numeric and length constraints stripped by
     `toStrictJsonSchema`, because strict tools do not support them.
   - Return compact outputs. Never return whole documents or rows the model does not need.
   - Throw `ToolError(userSafeMessage)` for expected failures (not found, bad args). The registry
     turns it into `tool_result` with `is_error: true`. Any other exception becomes a generic error,
     and its details only go to the trace.

3. **Register it** in `src/tools/registry.ts` (`defaultTools`). The registry emits the Anthropic tool
   definition with `strict: true` and `additionalProperties: false`.

4. **Evidence.** The registry records each call as `tool:<name>#<n>`. If the tool returns policy text
   or rule ids, include `chunkId` / `ruleId` so the citation checker can validate references.

5. **Hard rules.** If the tool output should *force* a decision (e.g. blacklisted vendor), add the
   rule in `src/rules/engine.ts` too, and add the fact in `src/graph/nodes/facts.ts`. Never rely on
   the LLM to act on it.

6. **Tests** in `tests/unit/tools/<camelName>.test.ts`:
   - happy path
   - invalid input is rejected (`registry.execute` returns `isError: true`)
   - not found / empty result
   - backing store error becomes an error result, not a crash
   - the registry snapshot test includes the tool with `strict: true` and `additionalProperties: false`

   If the tool hits Postgres, add an integration test under `tests/integration/`.

7. **Prompt.** If the agent prompt lists tools or their usage order, update it via the `edit-prompt` skill.

8. Run the `verify` skill.

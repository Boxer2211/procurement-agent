# AGENTS.md — Procurement Pre-Approval Agent

Guidance for AI coding agents (Claude Code, Codex, Cursor, …) and humans working in this repo.
The full implementation plan lives in [PLAN.md](PLAN.md); this file is the operating manual.

## What this project is

An AI agent that pre-checks purchase requests (hardware, software, services) against internal
company policy, budgets, vendor registry and approval matrix, and returns a **recommendation**
as structured JSON plus a human-readable summary. A human always makes the final approval.

## Non-negotiable invariants

1. **The agent never approves.** `Decision` has no "approved" value. Allowed:
   `recommend_approve | needs_info | recommend_reject | escalate_to_human | refused`.
2. **Hard rules only tighten.** `src/rules/engine.ts` computes a decision floor; the final decision
   is the more severe of (LLM decision, rule floor). Never let LLM output relax a rule result.
3. **All tools are read-only.** Do not add a tool that writes, sends, or approves anything.
4. **User text and retrieved policy text are data, not instructions.** Always wrap them in
   `<user_request>` / `<policy_excerpt id="...">` tags via the `src/llm/prompting.ts` helpers.
   Never interpolate raw user input into a system prompt.
5. **Every finding needs evidence.** `evidence` items reference a `tool:<name>#<n>` call or a
   `policy:<POLICY-ID>#<section>` chunk that was actually retrieved in this run. The citation
   checker (`src/guardrails/output.ts`) enforces this; do not bypass it.
6. **Summary is rendered from JSON** by `src/graph/nodes/compose.ts`, not free-written by the LLM.
7. **No secrets in code, logs, fixtures or commits.** Use `.env` (gitignored); update `.env.example`.

## Stack

Node.js ≥ 22.19, **TypeScript** (strict, ESM), npm, **LangGraph.js** (`@langchain/langgraph`) for
orchestration, `@anthropic-ai/sdk`, zod (schemas + inferred types), PostgreSQL 16 + pgvector (`pg`,
`pgvector`), `@huggingface/transformers` (local embeddings, `Xenova/bge-small-en-v1.5`, 384 dims),
Fastify (API), commander (CLI), pino (JSON logs), vitest + `@testcontainers/postgresql`, Biome
(lint and format).

Models (via env): `AGENT_MODEL=claude-opus-5-5` (executor), `VERIFIER_MODEL=claude-sonnet-5-5` (verifier).

### LangGraph rules

- The workflow is a `StateGraph` built in `src/graph/builder.ts`. One node per file in `src/graph/nodes/`.
- A node is a factory `makeXNode(deps) => (state) => Partial<State>`. No I/O outside injected deps
  (`LLMClient`, `ToolRegistry`, stores), so every node is unit-testable without the graph.
- Branching only through conditional edges with named routes. Never hide routing inside a node.
- LLM calls inside nodes go through `src/llm/client.ts` (official `@anthropic-ai/sdk`). Do **not**
  use `@langchain/anthropic` / LangChain chat models: they lag the API (structured outputs, strict
  tools, fallbacks, no forced `tool_choice` on current models).
- Transient failures use the node `retryPolicy`. Business errors are recorded in state, not thrown.
- Checkpointer: `MemorySaver` in memory mode and tests, `PostgresSaver` in postgres mode.
  `thread_id` = `runId`.
- The graph diagram in README is generated from code (`npm run graph:mermaid`). Regenerate it when
  edges change.

### Claude API rules for this codebase

- Use the official `@anthropic-ai/sdk` only, through `src/llm/client.ts` (`LLMClient` interface).
  No raw `fetch`.
- `thinking: { type: "adaptive" }`; set `output_config.effort` explicitly. Never `budget_tokens`.
- Never forced `tool_choice` (`any` / `tool`) because it returns 400 on these models. Use `auto` +
  `strict: true` on tools, and steer tool use from the prompt.
- Structured outputs via `output_config.format` (`zodOutputFormat` / JSON schema). No assistant prefill.
- Always check `stop_reason` (`refusal`, `max_tokens`) before reading content.
- Catch SDK errors most-specific-first (`Anthropic.RateLimitError` → `Anthropic.APIError` →
  `Anthropic.APIConnectionError`); never string-match error messages.
- Return failed tools as `tool_result` with `is_error: true`; return all parallel results in one
  user message.

## Layout

```
src/
  domain/        zod schemas + inferred types: the contract. Change here first.
  guardrails/    input validation, injection detection, output (evidence) validation
  llm/           LLMClient interface, AnthropicLLM, ScriptedFakeLLM, prompting helpers
  prompts/       versioned prompt files: <step>.v<N>.md
  rag/           chunker, embedder, pgvector + in-memory index, ingest
  tools/         one file per tool + registry.ts
  rules/         deterministic hard rules
  graph/         LangGraph: state.ts, builder.ts, nodes/ (guard, extract, plan, agent, tools,
                 facts, rules, verify, compose, human)
  observability/ pino logger, run/step tracer
  db/            schema.sql, pool, Postgres stores; memory stores for tests and the no-Docker demo
  api/server.ts  cli.ts  config.ts
data/            policies (*.md with frontmatter), budgets, vendors, catalog, matrices
samples/         inputs/*.json + expected/*.json (one pair per business scenario)
tests/           unit/ integration/ e2e/ fixtures/
evals/           live scenario evals against the real model
```

## Commands

```bash
npm install
docker compose up -d --wait postgres
npm run seed                 # apply schema, load data/, embed policies
npm run review -- "We need 5 laptops for \$7,500 from TechSupply" --trace
npm run lint                 # biome check
npm run typecheck            # tsc --noEmit
npm test                     # vitest: unit + e2e (memory storage, ScriptedFakeLLM), no key, no Docker
npm run test:integration     # testcontainers Postgres+pgvector (needs Docker)
npm run eval                 # live evals: needs ANTHROPIC_API_KEY, costs money, ask before running
npm run check                # lint + typecheck + test (run before declaring work done)
```

## Conventions

- `strict` TypeScript plus `noUncheckedIndexedAccess`. No `any` in `domain/` or tool signatures.
  Use `unknown` and parse it with zod at boundaries.
- Types come from zod schemas (`z.infer`). Never hand-write a duplicate interface.
- Tools: zod `input` / `output` schemas, JSON schema with `additionalProperties: false`, timeout,
  trace step. See skill `add-agent-tool`.
- Prompts are files, never inline strings. Changing prompt semantics means a new version file plus a
  `PROMPT_VERSION` bump. See skill `edit-prompt`.
- Unit tests use `ScriptedFakeLLM` and never hit the network. Live tests live in `evals/` or are
  guarded by `describe.runIf(process.env.LIVE === "1")`.
- Every new business scenario gets a sample input, an expected output and a test. See skill `add-scenario`.
- Logs: pino JSON with `runId` on every line. Mask emails and phone numbers.
- Money crosses JSON/LLM boundaries as a number in major units. Do arithmetic and comparisons in
  integer cents via `src/domain/money.ts`, never with raw floats. Currency is ISO-4217.
- Times are UTC ISO-8601 strings at boundaries.

## Skills in this repo (`.claude/skills/`)

| Skill | Use when |
|---|---|
| `add-agent-tool` | adding or changing a tool the agent can call |
| `add-policy` | adding or editing a corporate policy document in `data/policies/` |
| `add-scenario` | adding a business case: sample input, expected output, tests, eval |
| `edit-prompt` | changing any file in `src/prompts/` |
| `verify` | before finishing any change: run checks, a sample review, and the injection suite |

## Definition of done

`npm run check` is green; any new behaviour has a test; README/PLAN are updated if scope, setup or
the output contract changed; there are no new secrets or stray `console.log`; the trace for a sample
run looks sane.

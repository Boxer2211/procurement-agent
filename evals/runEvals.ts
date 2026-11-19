/**
 * Live evals: run every scenario in evals/scenarios.yaml against the real model and compare
 * semantically with samples/expected/<slug>.json. Costs money: needs ANTHROPIC_API_KEY.
 *
 *   npm run eval                      # all scenarios, memory storage
 *   npm run eval -- laptops_needs_info
 *   STORAGE=postgres npm run eval     # against the seeded database
 */

import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { bootstrap } from "../src/bootstrap.js";
import { loadSettings } from "../src/config.js";
import { RequestContextSchema } from "../src/domain/schemas.js";
import { ExpectedSchema, matchExpected } from "../src/evaluation/matchExpected.js";

const ROOT = resolve(import.meta.dirname, "..");
const ScenarioListSchema = z.array(z.object({ slug: z.string().regex(/^[a-z0-9_]+$/) }));
const InputSchema = z.object({ request: z.string(), context: RequestContextSchema.optional() });

async function main(): Promise<void> {
  const settings = loadSettings({ STORAGE: "memory", ...process.env });
  if (!settings.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required for live evals.");
  const only = new Set(process.argv.slice(2));
  const scenarios = ScenarioListSchema.parse(
    parseYaml(readFileSync(resolve(ROOT, "evals/scenarios.yaml"), "utf8")),
  ).filter((s) => only.size === 0 || only.has(s.slug));

  const app = await bootstrap(settings);
  const report: {
    slug: string;
    passed: boolean;
    decision: string;
    problems: string[];
    durationMs: number;
  }[] = [];
  try {
    for (const { slug } of scenarios) {
      const input = InputSchema.parse(
        JSON.parse(readFileSync(resolve(ROOT, `samples/inputs/${slug}.json`), "utf8")),
      );
      const expected = ExpectedSchema.parse(
        JSON.parse(readFileSync(resolve(ROOT, `samples/expected/${slug}.json`), "utf8")),
      );
      const started = performance.now();
      const { result } = await app.service.review(input.request, input.context ?? null);
      const problems = matchExpected(result, expected);
      const durationMs = Math.round(performance.now() - started);
      report.push({
        slug,
        passed: problems.length === 0,
        decision: result.decision,
        problems,
        durationMs,
      });
      console.log(
        `${problems.length === 0 ? "PASS" : "FAIL"}  ${slug.padEnd(30)} ${result.decision.padEnd(18)} ${durationMs}ms`,
      );
      for (const p of problems) console.log(`      - ${p}`);
    }
  } finally {
    await app.close();
  }

  const passed = report.filter((r) => r.passed).length;
  console.log(
    `\n${passed}/${report.length} scenarios passed (model ${settings.AGENT_MODEL}, verifier ${settings.VERIFIER_MODEL}, prompts ${settings.PROMPT_VERSION})`,
  );
  mkdirSync(resolve(ROOT, "evals/reports"), { recursive: true });
  const file = resolve(
    ROOT,
    `evals/reports/${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(
    file,
    JSON.stringify(
      {
        settings: {
          model: settings.AGENT_MODEL,
          verifier: settings.VERIFIER_MODEL,
          prompts: settings.PROMPT_VERSION,
        },
        report,
      },
      null,
      2,
    ),
  );
  console.log(`Report: ${file}`);
  if (passed < report.length) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

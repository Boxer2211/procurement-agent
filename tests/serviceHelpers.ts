import { type AppContext, bootstrap } from "../src/bootstrap.js";
import { loadSettings, type Settings } from "../src/config.js";
import { type LLMScript, ScriptedFakeLLM } from "../src/llm/fake.js";
import type { LLMClient } from "../src/llm/types.js";
import { DATA_DIR } from "./helpers.js";

export async function createTestApp(
  llm: LLMClient | LLMScript,
  env: Record<string, string> = {},
): Promise<AppContext & { llm: LLMClient }> {
  const client = "complete" in llm ? (llm as LLMClient) : new ScriptedFakeLLM(llm as LLMScript);
  const settings: Settings = loadSettings({
    STORAGE: "memory",
    DATA_DIR,
    BUDGET_PERIOD: "2026-Q4",
    LLM_FALLBACKS: "false",
    ...env,
  });
  const ctx = await bootstrap(settings, {
    llm: client,
    now: new Date("2026-11-19T12:00:00Z"),
    retryInitialIntervalMs: 1,
  });
  return { ...ctx, llm: client };
}

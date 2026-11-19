/** Application settings, validated from environment / .env. */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase()),
  );

const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);

export const SettingsSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  AGENT_MODEL: z.string().default("claude-opus-5-5"),
  VERIFIER_MODEL: z.string().default("claude-sonnet-5-5"),
  AGENT_EFFORT: effort.default("medium"),
  VERIFIER_EFFORT: effort.default("low"),
  LLM_FALLBACKS: bool.default(true),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),

  STORAGE: z.enum(["postgres", "memory"]).default("postgres"),
  DATABASE_URL: z
    .string()
    .default("postgresql://procurement:procurement@localhost:5433/procurement"),
  EMBEDDING_MODEL: z.string().default("Xenova/bge-small-en-v1.5"),
  DATA_DIR: z.string().default(resolve(PROJECT_ROOT, "data")),

  MAX_ITERATIONS: z.coerce.number().int().min(1).max(20).default(8),
  MAX_INPUT_CHARS: z.coerce.number().int().min(100).default(4000),
  MAX_REVISIONS: z.coerce.number().int().min(0).max(3).default(1),
  RUN_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  PROMPT_VERSION: z.string().default("v1"),
  BUDGET_PERIOD: z
    .string()
    .regex(/^\d{4}-Q[1-4]$/)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  HUMAN_REVIEW: bool.default(false),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  LOG_FORMAT: z.enum(["pretty", "json"]).default("json"),
});

export type Settings = z.infer<typeof SettingsSchema>;

export function loadSettings(env: Record<string, string | undefined> = process.env): Settings {
  return SettingsSchema.parse(env);
}

/** Calendar quarter label for a date, e.g. "2026-Q4". */
export function quarterOf(date: Date): string {
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

export function budgetPeriod(settings: Pick<Settings, "BUDGET_PERIOD">, now = new Date()): string {
  return settings.BUDGET_PERIOD ?? quarterOf(now);
}

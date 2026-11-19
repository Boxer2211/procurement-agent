/** Structured JSON logging (pino). Every run-scoped line carries `runId`. */

import { pino } from "pino";

const level = process.env.LOG_LEVEL ?? (process.env.VITEST ? "silent" : "info");
const pretty = process.env.LOG_FORMAT === "pretty";

export const logger = pino({
  level,
  base: { service: "procurement-agent" },
  redact: { paths: ["*.apiKey", "*.ANTHROPIC_API_KEY", "*.authorization"], censor: "[redacted]" },
  ...(pretty
    ? { transport: { target: "pino-pretty", options: { colorize: true, destination: 2 } } }
    : {}),
});

export type Logger = typeof logger;

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_CANDIDATE = /\+?\d[\d\s().-]{8,}\d/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Mask emails and phone numbers (10+ digits, not dates) before text goes to logs or traces. */
export function maskPii(text: string): string {
  return text
    .replace(EMAIL, "[email]")
    .replace(PHONE_CANDIDATE, (m) =>
      m.replace(/\D/g, "").length >= 10 && !ISO_DATE.test(m) ? "[phone]" : m,
    );
}

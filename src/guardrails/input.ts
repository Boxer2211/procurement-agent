/** Deterministic input validation, run before any LLM call. */

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁠-⁤]/g;
const WORD = /\p{L}{2,}/gu;
const MIN_WORDS = 3;

export type InputRejectReason = "empty_request" | "request_too_long" | "request_not_understandable";

export type InputCheckResult =
  | { ok: true; text: string }
  | { ok: false; text: string; reason: InputRejectReason };

/** NFKC-normalise, drop control / zero-width / bidi characters, collapse whitespace. */
export function normalizeInput(text: string): string {
  return text
    .normalize("NFKC")
    .replace(CONTROL_CHARS, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function validateInput(text: unknown, maxChars: number): InputCheckResult {
  if (typeof text !== "string") return { ok: false, text: "", reason: "empty_request" };
  const cleaned = normalizeInput(text);
  if (!cleaned) return { ok: false, text: "", reason: "empty_request" };
  if (cleaned.length > maxChars) {
    return { ok: false, text: cleaned.slice(0, maxChars), reason: "request_too_long" };
  }
  if ((cleaned.match(WORD) ?? []).length < MIN_WORDS) {
    return { ok: false, text: cleaned, reason: "request_not_understandable" };
  }
  return { ok: true, text: cleaned };
}

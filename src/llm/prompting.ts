/**
 * Prompt hygiene helpers. Untrusted text (user requests, policy excerpts, tool output)
 * only enters the user turn, wrapped in tags, with angle brackets escaped so it cannot
 * close the tag or fake new markup.
 */

import { readFileSync } from "node:fs";

export function escapeTags(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function attr(value: string): string {
  return value.replace(/[^A-Za-z0-9#._:-]/g, "");
}

export function wrapData(tag: string, text: string, attrs: Record<string, string> = {}): string {
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${attr(v)}"`)
    .join("");
  return `<${tag}${attrStr}>\n${escapeTags(text)}\n</${tag}>`;
}

export const wrapUserRequest = (text: string): string => wrapData("user_request", text);

export const wrapPolicyExcerpt = (evidenceId: string, text: string): string =>
  wrapData("policy_excerpt", text, { id: evidenceId });

export const wrapJson = (tag: string, value: unknown): string =>
  wrapData(tag, JSON.stringify(value, null, 2));

// --------------------------------------------------------------------------- prompt files

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;
const PROMPTS_DIR = new URL("../prompts/", import.meta.url);

export class PromptError extends Error {
  override name = "PromptError";
}

/**
 * Load `src/prompts/<step>.<version>.md` and substitute `{{placeholders}}`.
 * Fails loudly on missing or unused variables so prompt/code drift is caught by tests.
 */
export function renderPrompt(
  template: string,
  vars: Record<string, string>,
  name = "prompt",
): string {
  const used = new Set<string>();
  const out = template.replace(PLACEHOLDER, (_, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new PromptError(`${name}: missing variable {{${key}}}`);
    used.add(key);
    return value;
  });
  const unused = Object.keys(vars).filter((k) => !used.has(k));
  if (unused.length > 0) throw new PromptError(`${name}: unused variables ${unused.join(", ")}`);
  return out.trim();
}

const cache = new Map<string, string>();

export function loadPrompt(
  step: string,
  version: string,
  vars: Record<string, string> = {},
): string {
  if (!/^[a-z]+$/.test(step) || !/^v\d+$/.test(version)) {
    throw new PromptError(`invalid prompt id ${step}.${version}`);
  }
  const file = `${step}.${version}.md`;
  let template = cache.get(file);
  if (template === undefined) {
    try {
      template = readFileSync(new URL(file, PROMPTS_DIR), "utf8");
    } catch {
      throw new PromptError(`prompt file not found: ${file}`);
    }
    cache.set(file, template);
  }
  return renderPrompt(template, vars, file);
}

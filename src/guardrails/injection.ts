/**
 * Heuristic detectors for prompt injection and procurement abuse patterns.
 *
 * Deliberately simple, transparent regexes. They do not *block* a request: they raise
 * flags that cap the decision (see rules/engine.ts). Prompts are hardened independently,
 * so the detectors are one layer of defence in depth, not the only one.
 */

import type { Flag } from "../domain/schemas.js";

export interface Pattern {
  name: string;
  regex: RegExp;
}

export const INJECTION_PATTERNS: readonly Pattern[] = [
  {
    name: "ignore_instructions",
    regex:
      /\b(ignore|disregard|forget|override)\b.{0,40}?\b(previous|prior|above|all|earlier|system|your)\b.{0,30}?\b(instructions?|rules?|prompts?|polic(?:y|ies)|guidelines?)\b/is,
  },
  {
    name: "role_override",
    regex:
      /\byou are now\b|\bpretend (?:to be|you are)\b|\bact as (?:an? |the )?(?:admin|administrator|approver|cfo|ceo|system|developer)\b/i,
  },
  {
    name: "fake_markup",
    regex:
      /<\/?\s*(?:system|assistant|user_request|policy_excerpt|instructions?|tool_result)\s*>|\[\s*\/?\s*(?:system|inst)\s*\]|<<\s*sys\s*>>|^\s*(?:system|assistant)\s*:/im,
  },
  {
    name: "forced_decision",
    regex:
      /\b(?:output|respond|return|set|mark|classify)\b.{0,30}?\b(?:decision|verdict|status|result)\b.{0,25}?\b(?:approved?|recommend_approve)\b/is,
  },
  {
    name: "approve_command",
    regex:
      /\b(?:you must|you should|you will|always|just)\s+(?:auto-?)?approve\b|\bapprove (?:all|every|any|everything)\b/i,
  },
  {
    name: "meta_prompt",
    regex:
      /\b(?:new instructions?|system prompt|developer mode|jailbreak|reveal (?:your|the) (?:prompt|instructions))\b/i,
  },
  { name: "encoded_blob", regex: /[A-Za-z0-9+/]{120,}={0,2}/ },
];

export const SPLIT_PATTERNS: readonly Pattern[] = [
  {
    name: "split_verb",
    regex:
      /\b(?:split|divide|break)\b.{0,40}?\b(?:into|across|in)\b.{0,30}?\b(?:orders?|requests?|purchases?|invoices?|pos|parts|batches)\b/is,
  },
  {
    name: "stay_under_threshold",
    regex:
      /\b(?:stay|keep|remain|be)\b.{0,25}?\b(?:under|below|beneath)\b.{0,40}?(?:\bthreshold\b|\blimit\b|\bapproval\b|\$?\s?5,?000|\bquotes?\b)/is,
  },
  {
    name: "multiple_orders_to_avoid",
    regex:
      /\b(?:two|three|four|several|multiple|separate|2|3|4)\b.{0,25}?\b(?:orders|requests|purchases|invoices|pos)\b.{0,60}?\b(?:avoid|so that|so we don'?t|to not|under|below)\b/is,
  },
];

export const BYPASS_PATTERNS: readonly Pattern[] = [
  {
    name: "skip_approval",
    regex:
      /\b(?:without|skip|skipping|bypass|bypassing|avoid|circumvent|no need for)\b.{0,30}?\b(?:approvals?|finance|cfo|sign-?off|review|procurement|quotes?|it approval)\b/is,
  },
  {
    name: "retroactive",
    regex:
      /\bretroactive(?:ly)?\b|\b(?:already|just)\s+(?:ordered|paid|bought|purchased|signed)\b/i,
  },
];

function matches(text: string, patterns: readonly Pattern[]): string[] {
  return patterns.filter((p) => p.regex.test(text)).map((p) => p.name);
}

export const detectInjection = (text: string): string[] => matches(text, INJECTION_PATTERNS);
export const detectSplitPurchase = (text: string): string[] => matches(text, SPLIT_PATTERNS);
export const detectBypass = (text: string): string[] => matches(text, BYPASS_PATTERNS);

export interface ScanResult {
  flags: Flag[];
  signals: Partial<Record<Flag, string[]>>;
}

/** Run all detectors on a user request. */
export function scanRequest(text: string): ScanResult {
  const detectors: [Flag, string[]][] = [
    ["prompt_injection_suspected", detectInjection(text)],
    ["split_purchase_suspected", detectSplitPurchase(text)],
    ["approval_bypass_attempt", detectBypass(text)],
  ];
  const signals: Partial<Record<Flag, string[]>> = {};
  const flags: Flag[] = [];
  for (const [flag, hits] of detectors) {
    if (hits.length > 0) {
      flags.push(flag);
      signals[flag] = hits;
    }
  }
  return { flags, signals };
}

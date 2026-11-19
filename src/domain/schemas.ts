/**
 * Domain contract: everything the agent reads, produces and returns.
 *
 * These zod schemas are the single source of truth for the JSON output, for the
 * JSON schemas sent to the LLM (structured outputs / strict tools) and for TS types.
 * LLM-facing schemas use `.nullable()` instead of optional fields: strict structured
 * outputs require every property to be present.
 */

import { z } from "zod";

// --------------------------------------------------------------------------- enums

export const CategorySchema = z.enum(["hardware", "software", "services", "other"]);
export type Category = z.infer<typeof CategorySchema>;

/** Agent recommendation. There is deliberately no "approved" value. */
export const DecisionSchema = z.enum([
  "recommend_approve",
  "needs_info",
  "escalate_to_human",
  "recommend_reject",
  "refused",
]);
export type Decision = z.infer<typeof DecisionSchema>;

const DECISION_SEVERITY: Record<Decision, number> = {
  recommend_approve: 0,
  needs_info: 1,
  escalate_to_human: 2,
  recommend_reject: 3,
  refused: 4,
};

export function decisionSeverity(d: Decision): number {
  return DECISION_SEVERITY[d];
}

/** The more severe of the given decisions (rules can only tighten, never relax). */
export function mostSevere(first: Decision, ...rest: Decision[]): Decision {
  return rest.reduce((acc, d) => (DECISION_SEVERITY[d] > DECISION_SEVERITY[acc] ? d : acc), first);
}

/** Decisions the LLM may output; `refused` is decided by the graph, not the model. */
export const LLM_DECISIONS = [
  "recommend_approve",
  "needs_info",
  "escalate_to_human",
  "recommend_reject",
] as const satisfies readonly Decision[];
export const LlmDecisionSchema = z.enum(LLM_DECISIONS);

export const CheckIdSchema = z.enum([
  "completeness",
  "budget",
  "vendor",
  "approval_route",
  "quotes",
  "documents",
  "justification",
  "price",
  "policy_compliance",
]);
export type CheckId = z.infer<typeof CheckIdSchema>;

export const CheckStatusSchema = z.enum(["pass", "warn", "fail", "unknown"]);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

const CHECK_SEVERITY: Record<CheckStatus, number> = { pass: 0, unknown: 1, warn: 2, fail: 3 };
export function checkSeverity(s: CheckStatus): number {
  return CHECK_SEVERITY[s];
}

export const SeveritySchema = z.enum(["low", "medium", "high"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const FlagSchema = z.enum([
  "prompt_injection_suspected",
  "split_purchase_suspected",
  "approval_bypass_attempt",
  "off_topic",
  "amount_mismatch",
  "tool_failure",
  "iteration_limit",
  "verification_failed",
  "llm_error",
]);
export type Flag = z.infer<typeof FlagSchema>;

export const RunStatusSchema = z.enum(["completed", "refused", "invalid_input", "error"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const VerifierVerdictSchema = z.enum(["ok", "revise", "unsupported", "skipped"]);
export type VerifierVerdict = z.infer<typeof VerifierVerdictSchema>;

export const VendorStatusSchema = z.enum([
  "approved",
  "pending",
  "blacklisted",
  "expired",
  "unknown",
]);
export type VendorStatus = z.infer<typeof VendorStatusSchema>;

export const DOCUMENT_IDS = [
  "business_justification",
  "cost_center",
  "vendor_quotes",
  "hardware_specification",
  "security_assessment",
  "license_user_list",
  "statement_of_work",
  "nda",
  "master_services_agreement",
  "vendor_onboarding_form",
] as const;
export const DocumentIdSchema = z.enum(DOCUMENT_IDS);
export type DocumentId = z.infer<typeof DocumentIdSchema>;

// --------------------------------------------------------------------------- request

export const LineItemSchema = z
  .object({
    name: z.string().describe("Item or service name as stated by the requester"),
    quantity: z.number().int().nullable().describe("Number of units; null if not stated"),
    unit_price: z.number().nullable().describe("Price per unit in major units; null if not stated"),
  })
  .strict();
export type LineItem = z.infer<typeof LineItemSchema>;

/** Structured view of a free-text purchase request (output of the extract node). */
export const PurchaseRequestSchema = z
  .object({
    is_procurement_request: z
      .boolean()
      .describe("False if the text is not a request to buy goods or services for the company"),
    off_topic_reason: z
      .string()
      .nullable()
      .describe("Short reason when is_procurement_request is false, else null"),
    summary: z.string().describe("One-sentence neutral summary of what is requested"),
    category: CategorySchema,
    items: z.array(LineItemSchema),
    total_amount: z.number().nullable().describe("Total amount in major units; null if not stated"),
    currency: z.string().describe("ISO-4217 code; USD if a $ sign is used"),
    vendor: z.string().nullable().describe("Proposed vendor name; null if not stated"),
    department: z
      .string()
      .nullable()
      .describe("Requesting department as a lowercase slug (engineering, marketing, ...)"),
    cost_center: z.string().nullable(),
    justification: z
      .string()
      .nullable()
      .describe("Business justification as stated by the requester; null if absent"),
    provided_documents: z
      .array(DocumentIdSchema)
      .describe("Documents the requester says are attached or available"),
    quotes_count: z
      .number()
      .int()
      .nullable()
      .describe("Number of vendor quotes provided; null if not mentioned"),
  })
  .strict();
export type PurchaseRequest = z.infer<typeof PurchaseRequestSchema>;

/** Optional structured metadata from the calling system (semi-trusted). */
export const RequestContextSchema = z
  .object({
    department: z.string().max(64).optional(),
    costCenter: z.string().max(64).optional(),
    providedDocuments: z.array(DocumentIdSchema).max(20).optional(),
    requester: z.string().max(128).optional(),
  })
  .strict();
export type RequestContext = z.infer<typeof RequestContextSchema>;

// --------------------------------------------------------------------------- plan

export const PlanOutputSchema = z
  .object({
    checks: z.array(CheckIdSchema).describe("Additional checks needed for this request"),
    search_queries: z
      .array(z.string())
      .describe("2-5 short queries to find relevant policy sections"),
    rationale: z.string().describe("One or two sentences on why these checks"),
  })
  .strict();
export type PlanOutput = z.infer<typeof PlanOutputSchema>;

export interface ReviewPlan {
  checks: CheckId[];
  searchQueries: string[];
  rationale: string;
  source: "llm" | "baseline";
}

// --------------------------------------------------------------------------- findings

export const CheckSchema = z
  .object({
    check_id: CheckIdSchema,
    status: CheckStatusSchema,
    detail: z.string(),
    evidence: z
      .array(z.string())
      .describe("Evidence ids: 'tool:<name>#<n>' or 'policy:<POLICY-ID>#<section>'"),
  })
  .strict();
export type Check = z.infer<typeof CheckSchema>;

export const ViolationSchema = z
  .object({
    rule_id: z.string().describe("Policy reference, e.g. PROC-001#5.1"),
    severity: SeveritySchema,
    detail: z.string(),
    evidence: z.array(z.string()),
  })
  .strict();
export type Violation = z.infer<typeof ViolationSchema>;

/** Final structured answer of the tool-using agent node. */
export const AgentDraftSchema = z
  .object({
    decision: LlmDecisionSchema,
    confidence: z.number().describe("0.0-1.0 confidence in the decision"),
    checks: z.array(CheckSchema),
    violations: z.array(ViolationSchema),
    missing_information: z.array(z.string()),
    recommendations: z.array(z.string()),
  })
  .strict();
export type AgentDraft = z.infer<typeof AgentDraftSchema>;

export const UnsupportedClaimSchema = z.object({ claim: z.string(), reason: z.string() }).strict();
export type UnsupportedClaim = z.infer<typeof UnsupportedClaimSchema>;

export const VerifierOutputSchema = z
  .object({
    verdict: z.enum(["ok", "revise", "unsupported"]),
    unsupported_claims: z.array(UnsupportedClaimSchema),
    notes: z.string(),
  })
  .strict();
export type VerifierOutput = z.infer<typeof VerifierOutputSchema>;

export const VerificationSchema = z
  .object({
    verifier_model: z.string().nullable(),
    verdict: VerifierVerdictSchema,
    unsupported_claims: z.array(UnsupportedClaimSchema),
    invalid_evidence: z.array(z.string()),
    notes: z.string(),
    revisions: z.number().int(),
  })
  .strict();
export type Verification = z.infer<typeof VerificationSchema>;

// --------------------------------------------------------------------------- result

export const ReviewResultSchema = z
  .object({
    run_id: z.string(),
    status: RunStatusSchema,
    decision: DecisionSchema,
    confidence: z.number().min(0).max(1),
    request: PurchaseRequestSchema.nullable(),
    checks: z.array(CheckSchema),
    violations: z.array(ViolationSchema),
    missing_information: z.array(z.string()),
    approval_route: z.array(z.string()),
    recommendations: z.array(z.string()),
    flags: z.array(FlagSchema),
    verification: VerificationSchema,
    prompt_version: z.string(),
    summary: z.string(),
    error: z.string().nullable(),
  })
  .strict();
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

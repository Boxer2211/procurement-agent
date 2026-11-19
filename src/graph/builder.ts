/** The review workflow as a LangGraph StateGraph. */

import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { END, START, StateGraph } from "@langchain/langgraph";
import type { ReferenceData } from "../db/referenceData.js";
import type { GraphDeps } from "./deps.js";
import { makeAgentNode, routeAfterAgent } from "./nodes/agent.js";
import { makeComposeNode, routeAfterCompose } from "./nodes/compose.js";
import { makeExtractNode, routeAfterExtract } from "./nodes/extract.js";
import { makeFactsNode } from "./nodes/facts.js";
import { makeGuardNode, routeAfterGuard } from "./nodes/guard.js";
import { humanNode } from "./nodes/human.js";
import { makePlanNode } from "./nodes/plan.js";
import { rulesNode } from "./nodes/rules.js";
import { makeToolsNode } from "./nodes/tools.js";
import { makeVerifyNode, routeAfterVerify } from "./nodes/verify.js";
import { ReviewState } from "./state.js";

export function buildGraph(
  deps: GraphDeps,
  ref: ReferenceData,
  checkpointer?: BaseCheckpointSaver,
) {
  // LLM nodes rethrow retryable errors (rate limit / overload that survived SDK retries).
  const llmRetry = {
    maxAttempts: 3,
    initialInterval: deps.retryInitialIntervalMs ?? 2_000,
    backoffFactor: 2,
  };

  return new StateGraph(ReviewState)
    .addNode("guard", makeGuardNode(deps))
    .addNode("extract", makeExtractNode(deps), { retryPolicy: llmRetry })
    .addNode("plan", makePlanNode(deps), { retryPolicy: llmRetry })
    .addNode("agent", makeAgentNode(deps), { retryPolicy: llmRetry })
    .addNode("tools", makeToolsNode(deps))
    .addNode("facts", makeFactsNode(deps, ref))
    .addNode("rules", rulesNode)
    .addNode("verify", makeVerifyNode(deps), { retryPolicy: llmRetry })
    .addNode("compose", makeComposeNode(deps))
    .addNode("human", humanNode)
    .addEdge(START, "guard")
    .addConditionalEdges("guard", routeAfterGuard, ["extract", "compose"])
    .addConditionalEdges("extract", routeAfterExtract, ["plan", "compose"])
    .addEdge("plan", "agent")
    .addConditionalEdges("agent", routeAfterAgent, ["tools", "agent", "facts"])
    .addEdge("tools", "agent")
    .addEdge("facts", "rules")
    .addEdge("rules", "verify")
    .addConditionalEdges("verify", routeAfterVerify, ["agent", "compose"])
    .addConditionalEdges("compose", routeAfterCompose(deps), ["human", END])
    .addEdge("human", END)
    .compile({ checkpointer });
}

export type ReviewGraph = ReturnType<typeof buildGraph>;

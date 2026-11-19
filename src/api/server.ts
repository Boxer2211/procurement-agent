/** HTTP API (Fastify). Thin layer: validation + mapping to ReviewService. */

import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { RequestContextSchema } from "../domain/schemas.js";
import { HumanDecisionInputSchema } from "../graph/nodes/human.js";
import {
  NotAwaitingDecisionError,
  type ReviewService,
  RunNotFoundError,
} from "../graph/service.js";

export const ReviewBodySchema = z
  .object({
    request: z.string().max(20_000), // the guard node enforces the real (configurable) limit
    context: RequestContextSchema.optional(),
  })
  .strict();

const RunParamsSchema = z.object({ runId: z.uuid() });

function badRequest(error: z.ZodError) {
  return {
    error: "invalid_request",
    issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  };
}

export function buildServer(service: ReviewService): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.post("/v1/reviews", async (req, reply) => {
    const body = ReviewBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send(badRequest(body.error));
    const { result, awaitingHumanDecision } = await service.review(
      body.data.request,
      body.data.context ?? null,
    );
    reply.header("x-run-id", result.run_id);
    reply.header("x-awaiting-human-decision", String(awaitingHumanDecision));
    return reply.code(200).send(result);
  });

  app.get("/v1/runs/:runId", async (req, reply) => {
    const params = RunParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send(badRequest(params.error));
    const run = await service.getRun(params.data.runId);
    if (!run) return reply.code(404).send({ error: "run_not_found" });
    return run;
  });

  app.get("/v1/runs/:runId/trace", async (req, reply) => {
    const params = RunParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send(badRequest(params.error));
    const run = await service.getRun(params.data.runId);
    if (!run) return reply.code(404).send({ error: "run_not_found" });
    return { run_id: run.runId, steps: await service.getTrace(run.runId) };
  });

  app.post("/v1/runs/:runId/decision", async (req, reply) => {
    const params = RunParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send(badRequest(params.error));
    const body = HumanDecisionInputSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send(badRequest(body.error));
    try {
      return await service.submitDecision(params.data.runId, body.data);
    } catch (err) {
      if (err instanceof RunNotFoundError) return reply.code(404).send({ error: "run_not_found" });
      if (err instanceof NotAwaitingDecisionError) {
        return reply.code(409).send({ error: "run_not_awaiting_decision" });
      }
      throw err;
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status < 500) return reply.code(status).send({ error: (err as Error).message });
    return reply.code(500).send({ error: "internal_error" });
  });

  return app;
}

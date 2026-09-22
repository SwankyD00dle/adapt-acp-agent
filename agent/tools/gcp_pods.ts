import type { AgentProjectContext, ToolContext } from "@adaptcom/core";
import { type ToolExecutionOptions, tool } from "ai";
import { z } from "zod";
import type { GoogleCloudAccess } from "../connections/google-cloud.ts";

const inputSchema = z.strictObject({
  labelSelector: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export default function gcpPods({ connections }: AgentProjectContext) {
  const connection = connections.get<GoogleCloudAccess>("googleCloud");
  return tool({
    description:
      "List read-only pod summaries from the configured GCP staging Kubernetes namespace. Use labelSelector app=platinumd or app=orc-sched to narrow the result.",
    inputSchema,
    async execute(input, { context }: ToolExecutionOptions<ToolContext>) {
      const access = await connection.connect({ signal: context.signal });
      return access.listPods({
        ...(input.labelSelector ? { labelSelector: input.labelSelector } : {}),
        limit: input.limit,
      });
    },
  });
}

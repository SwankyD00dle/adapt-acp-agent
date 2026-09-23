import type { AgentProjectContext, ToolContext } from "@adaptcom/core";
import { type ToolExecutionOptions, tool } from "ai";
import { z } from "zod";
import type { GoogleCloudAccess } from "../connections/google-cloud.ts";

const inputSchema = z.strictObject({
  pod: z.string().min(1).max(253),
  container: z.string().min(1).max(253).optional(),
  tailLines: z.number().int().min(1).max(2_000).default(200),
  previous: z.boolean().default(false),
});

export default function gcpPodLogs({ connections }: AgentProjectContext) {
  const connection = connections.get<GoogleCloudAccess>("googleCloud");
  return tool({
    description:
      "Read the recent logs of a configured GCP staging Kubernetes pod. This is read-only and timestamps are included.",
    inputSchema,
    async execute(input, { context }: ToolExecutionOptions<ToolContext>) {
      const access = await connection.connect({ signal: context.signal });
      const logs = await access.podLogs({
        pod: input.pod,
        ...(input.container ? { container: input.container } : {}),
        tailLines: input.tailLines,
        previous: input.previous,
      });
      return {
        pod: input.pod,
        logs: logs.slice(0, 128_000),
        truncated: logs.length > 128_000,
      };
    },
  });
}

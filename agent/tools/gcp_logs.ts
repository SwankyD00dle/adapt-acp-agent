import type { AgentProjectContext, ToolContext } from "@adaptcom/core";
import { type ToolExecutionOptions, tool } from "ai";
import { z } from "zod";
import type { GoogleCloudAccess } from "../connections/google-cloud.ts";

const inputSchema = z.strictObject({
  filter: z.string().trim().min(1).max(4_000),
  limit: z.number().int().min(1).max(100).default(50),
});

export default function gcpLogs({ connections }: AgentProjectContext) {
  const connection = connections.get<GoogleCloudAccess>("googleCloud");
  return tool({
    description:
      "Query read-only Google Cloud Logging entries in the configured staging project. Use Logging filter syntax and keep the result limit small.",
    inputSchema,
    async execute(input, { context }: ToolExecutionOptions<ToolContext>) {
      const access = await connection.connect({ signal: context.signal });
      return access.listLogs(input);
    },
  });
}

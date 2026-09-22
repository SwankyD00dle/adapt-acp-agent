import type { AgentProjectContext, ToolContext } from "@adaptcom/core";
import { type ToolExecutionOptions, tool } from "ai";
import { z } from "zod";
import type { PlatinumAccess } from "../connections/platinum.ts";

const inputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .refine((value) => !value.startsWith("/"), "Use a path relative to /v1.")
    .refine((value) => !value.includes(".."), "Parent paths are not allowed."),
});

export default function platinumGet({ connections }: AgentProjectContext) {
  const connection = connections.get<PlatinumAccess>("platinum");
  return tool({
    description:
      "Read a resource from the Platinum staging API with GET. The path is relative to /v1, such as sandboxes/{id}, execs/{id}, or ingresses/{id}.",
    inputSchema,
    async execute({ path }, { context }: ToolExecutionOptions<ToolContext>) {
      const access = await connection.connect({ signal: context.signal });
      const response = await access.request(path, { method: "GET" });
      const body = await response.text();
      return {
        status: response.status,
        ok: response.ok,
        body: body.slice(0, 128_000),
        truncated: body.length > 128_000,
      };
    },
  });
}

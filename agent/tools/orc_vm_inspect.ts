import type { AgentProjectContext, ToolContext } from "@adaptcom/core";
import { type ToolExecutionOptions, tool } from "ai";
import { z } from "zod";
import type { PlatinumAccess } from "../connections/platinum.ts";

const inputSchema = z.strictObject({
  sandboxId: z.string().regex(/^sbx_[a-zA-Z0-9]+$/),
  operation: z.enum([
    "processes",
    "listeners",
    "system",
    "mounts",
    "agent_health",
  ]),
  port: z.number().int().min(1).max(65_535).default(3_000),
});

const commands = {
  processes: "ps -eo pid,ppid,pgid,stat,comm",
  listeners: "ss -lntp 2>/dev/null || cat /proc/net/tcp",
  system: "date -u; uptime",
  mounts: "findmnt -n -o TARGET,FSTYPE",
} as const;

export default function orcVmInspect({ connections }: AgentProjectContext) {
  const connection = connections.get<PlatinumAccess>("platinum");
  return tool({
    description:
      "Run one fixed read-only diagnostic inside an Orc VM through the Platinum staging API. This cannot run arbitrary commands or mutate the VM.",
    inputSchema,
    async execute(
      { sandboxId, operation, port },
      { context }: ToolExecutionOptions<ToolContext>,
    ) {
      const command =
        operation === "agent_health"
          ? `curl --max-time 3 -s -o /dev/null -w 'HTTP %{http_code}\\n' http://127.0.0.1:${port}/`
          : commands[operation];
      const access = await connection.connect({ signal: context.signal });
      const response = await access.request(
        `sandboxes/${encodeURIComponent(sandboxId)}/exec`,
        {
          method: "POST",
          body: JSON.stringify({
            cmd: command,
            detach: false,
            timeout: 10_000,
          }),
        },
      );
      const body = await response.text();
      return {
        sandboxId,
        operation,
        status: response.status,
        ok: response.ok,
        body: body.slice(0, 128_000),
        truncated: body.length > 128_000,
      };
    },
  });
}

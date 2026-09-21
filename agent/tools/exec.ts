import type { AgentProjectContext, ToolContext } from "@adaptcom/core";
import { type ToolExecutionOptions, tool } from "ai";
import { z } from "zod";
import {
  execResultSchema,
  maxFileBytes,
  maxOutputCharacters,
} from "../../protocol.ts";
import type { AcpAccess } from "../types.ts";

export default function exec({ connections }: AgentProjectContext) {
  const connection = connections.get<AcpAccess>("acp");
  return tool({
    description:
      "Run a shell command in the working directory. Files persist between calls; shell variables and cwd do not. Output is bounded and indicates truncation.",
    inputSchema: z.object({
      command: z.string().trim().min(1),
      stdin: z
        .string()
        .refine(
          (value) => Buffer.byteLength(value) <= maxFileBytes,
          `Contents must fit within ${maxFileBytes} bytes.`,
        )
        .optional(),
      timeoutMs: z.number().int().min(1).max(60_000).default(30_000),
    }),
    async execute(input, { context }: ToolExecutionOptions<ToolContext>) {
      if (input.stdin)
        throw new Error(
          "IDE terminal stdin is not supported; use a command instead.",
        );
      const access = await connection.connect({ signal: context.signal });
      const result = execResultSchema.parse(
        await access.call(
          context.session.address.conversationId,
          context.callId,
          { kind: "exec", command: input.command, timeoutMs: input.timeoutMs },
        ),
      );
      return {
        ...result,
        stdout: result.stdout.slice(0, maxOutputCharacters),
        stderr: result.stderr.slice(0, maxOutputCharacters),
        truncated:
          result.truncated ||
          result.stdout.length > maxOutputCharacters ||
          result.stderr.length > maxOutputCharacters,
      };
    },
  });
}

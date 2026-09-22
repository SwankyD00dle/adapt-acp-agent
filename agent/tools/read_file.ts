import type { AgentProjectContext, ToolContext } from "@adaptcom/core";
import { type ToolExecutionOptions, tool } from "ai";
import { z } from "zod";
import { readInputSchema, maxFileBytes } from "../../protocol.ts";
import type { AcpAccess } from "../types.ts";

export default function readFile({ connections }: AgentProjectContext) {
  const connection = connections.get<AcpAccess>("acp");
  return tool({
    description: `Read a UTF-8 file. Relative paths start in the working directory. Files larger than ${maxFileBytes} bytes require reading portions with exec.`,
    inputSchema: readInputSchema,
    async execute({ path }, { context }: ToolExecutionOptions<ToolContext>) {
      const access = await connection.connect({ signal: context.signal });
      const contents = z
        .string()
        .parse(
          await access.call(
            context.session.address.conversationId,
            context.callId,
            { kind: "read", path },
          ),
        );
      if (Buffer.byteLength(contents) > maxFileBytes)
        throw new Error(
          "File is too large. Use exec to read a smaller portion.",
        );
      return { path, contents };
    },
  });
}

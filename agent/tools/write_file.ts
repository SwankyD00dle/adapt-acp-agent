import type { AgentProjectContext, ToolContext } from "@adaptcom/core";
import { type ToolExecutionOptions, tool } from "ai";
import { writeInputSchema } from "../../protocol.ts";
import type { AcpAccess } from "../types.ts";

export default function writeFile({ connections }: AgentProjectContext) {
  const connection = connections.get<AcpAccess>("acp");
  return tool({
    description:
      "Write a UTF-8 file, replacing its contents and creating parent directories. Relative paths start in the working directory.",
    inputSchema: writeInputSchema,
    async execute(
      { path, contents },
      { context }: ToolExecutionOptions<ToolContext>,
    ) {
      const access = await connection.connect({ signal: context.signal });
      await access.call(
        context.session.address.conversationId,
        context.callId,
        {
          kind: "write",
          path,
          contents,
        },
      );
      return { path, bytesWritten: Buffer.byteLength(contents) };
    },
  });
}

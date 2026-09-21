import type {
  AgentConnection,
  AgentHarness,
  AgentTools,
  HarnessContext,
} from "@adaptcom/core";
import type { AcpAccess } from "./types.ts";

/** Stream committed messages and bind execution to the current editor turn. */
export function createAcpHarness(
  connection: AgentConnection<AcpAccess>,
  harness: AgentHarness,
): AgentHarness {
  const withTools = harness.withTools?.bind(harness);
  return {
    ...(withTools
      ? {
          withTools: (tools: AgentTools) =>
            createAcpHarness(connection, withTools(tools)),
        }
      : {}),
    describe: () => harness.describe(),
    async run(context) {
      const access = await connection.connect({ signal: context.signal });
      const turn = access.turn(
        context.session.address.conversationId,
        context.trigger.externalId,
      );
      const wrapped: HarnessContext = {
        ...context,
        get session() {
          return context.session;
        },
        signal: turn.signal,
        checkpoint: async (events) => {
          turn.signal.throwIfAborted();
          await context.checkpoint(events);
          turn.signal.throwIfAborted();
          for (const event of events)
            if (event.type === "assistant.message") turn.message(event.text);
        },
      };
      try {
        turn.signal.throwIfAborted();
        const result = await harness.run(wrapped);
        turn.signal.throwIfAborted();
        return result;
      } catch (error) {
        turn.fail();
        throw error;
      }
    },
  };
}

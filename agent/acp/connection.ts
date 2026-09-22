import type { AgentConnection } from "@adaptcom/core";
import type { AcpAccess } from "../types.ts";
import type { DiagnosticLogger } from "../../diagnostics.ts";
import { BridgeStateError } from "./errors.ts";
import { IdeBroker } from "./broker.ts";

interface AcpConnectionOptions {
  leaseMs?: number;
  turnMs?: number;
  log?: DiagnosticLogger;
}

/** Installation-scoped live editor access; no credentials or saved history. */
export function createAcpConnection(
  options: AcpConnectionOptions = {},
): AgentConnection<AcpAccess> {
  const attachments = new Map<string, IdeBroker>();
  const prune = () => {
    for (const [id, broker] of attachments)
      if (!broker.hasAttachment(id)) attachments.delete(id);
  };
  const attached = (id: string) => {
    prune();
    const broker = attachments.get(id);
    if (!broker)
      throw new BridgeStateError(
        "ATTACHMENT_EXPIRED",
        "Editor attachment expired. Reconnect after inspecting the workspace.",
      );
    return broker;
  };
  return {
    describe: () => ({ name: "acp", config: { connectionId: "ide" } }),
    async connect({ signal }) {
      signal.throwIfAborted();
      const check = () => signal.throwIfAborted();
      return {
        open(cwd) {
          check();
          prune();
          if (attachments.size >= 8)
            throw new Error("Eight workspaces are already attached.");
          const broker = new IdeBroker(
            options.leaseMs,
            options.turnMs,
            options.log,
          );
          const { attachmentId } = broker.attach(cwd, signal);
          attachments.set(attachmentId, broker);
          return { attachmentId };
        },
        poll(id, after) {
          check();
          return attached(id).poll(id, after);
        },
        prompt(id, promptId, text) {
          check();
          const accepted = attached(id).prompt(id, promptId, text);
          // Each live attachment starts a fresh runtime conversation.
          return accepted ? { ...accepted, conversationId: id } : undefined;
        },
        result(id, callId, result) {
          check();
          attached(id).result(id, callId, result);
        },
        cancel(id, promptId) {
          check();
          prune();
          // Cancellation after close/lease expiry is already satisfied.
          attachments.get(id)?.cancel(id, promptId);
        },
        close(id) {
          check();
          attachments.get(id)?.detach(id);
          attachments.delete(id);
        },
        finish(id, promptId, text) {
          check();
          prune();
          attachments.get(id)?.finish(id, promptId, text);
        },
        turn(id, promptId) {
          check();
          return attached(id).turn(id, promptId, signal);
        },
        async call(id, callId, operation) {
          check();
          return attached(id).call(id, callId, operation, signal);
        },
      };
    },
  };
}

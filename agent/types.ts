import type { BridgeEvent, ClientResult, Operation } from "../protocol.ts";

/** Shared live editor contract for the agent's channel, harness, and tools. */
export interface AcpAccess {
  /** The connect signal used to open an attachment must cover its host lifetime. */
  open(cwd: string): { attachmentId: string };
  poll(
    id: string,
    after: number,
  ): {
    events: { sequence: number; event: BridgeEvent }[];
    cursor: number;
  };
  prompt(
    id: string,
    promptId: string,
    text: string,
  ): { cwd: string; conversationId: string } | undefined;
  result(id: string, callId: string, result: ClientResult): void;
  cancel(id: string, promptId: string): void;
  close(id: string): void;
  finish(conversationId: string, promptId: string, text: string): void;
  turn(
    conversationId: string,
    promptId: string,
  ): {
    signal: AbortSignal;
    message(text: string): void;
    fail(): void;
  };
  call(
    conversationId: string,
    callId: string,
    operation: Operation,
  ): Promise<unknown>;
}

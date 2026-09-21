import { createHash, randomUUID } from "node:crypto";
import type { BridgeEvent, ClientResult, Operation } from "../../protocol.ts";

type Turn = {
  id: string;
  controller: AbortController;
  deadline: NodeJS.Timeout;
};
type Attachment = {
  id: string;
  cwd: string;
  sequence: number;
  events: { sequence: number; event: BridgeEvent }[];
  seen: Map<string, string>;
  cancelled: Set<string>;
  turn: Turn | undefined;
  pending: Map<string, (result: ClientResult) => void>;
  completedCalls: Set<string>;
  lease: NodeJS.Timeout;
  unlisten(): void;
};

/** Internal reverse-RPC state for one live editor. No saved sessions or history. */
export class IdeBroker {
  private attachment: Attachment | undefined;
  private readonly leaseMs: number;
  private readonly turnMs: number;
  constructor(leaseMs = 45_000, turnMs = 15 * 60_000) {
    this.leaseMs = leaseMs;
    this.turnMs = turnMs;
  }

  attach(cwd: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.attachment)
      throw new Error(
        "An editor is already attached. Close it or wait for its lease to expire.",
      );
    const attachmentId = randomUUID();
    const aborted = () => this.detach(attachmentId);
    signal.addEventListener("abort", aborted, { once: true });
    this.attachment = {
      id: attachmentId,
      cwd,
      sequence: 0,
      events: [],
      seen: new Map(),
      cancelled: new Set(),
      turn: undefined,
      pending: new Map(),
      completedCalls: new Set(),
      lease: setTimeout(aborted, this.leaseMs).unref(),
      unlisten: () => signal.removeEventListener("abort", aborted),
    };
    return { attachmentId };
  }

  hasAttachment(id: string) {
    return this.attachment?.id === id;
  }

  private attached(id: string) {
    const attachment = this.attachment;
    if (!attachment || attachment.id !== id)
      throw new Error(
        "Editor attachment expired. Reconnect after inspecting the workspace.",
      );
    return attachment;
  }

  private publish(attachment: Attachment, event: BridgeEvent) {
    attachment.events.push({ sequence: ++attachment.sequence, event });
    if (attachment.events.length > 256) attachment.events.shift();
  }

  poll(id: string, after: number) {
    const attachment = this.attached(id);
    if (
      after > attachment.sequence ||
      after < (attachment.events[0]?.sequence ?? 1) - 1
    )
      throw new Error(
        "Event cursor expired. Reconnect; operations will not be replayed.",
      );
    attachment.lease.refresh();
    const events = attachment.events
      .filter((event) => event.sequence > after)
      .slice(0, 32);
    return { events, cursor: events.at(-1)?.sequence ?? after };
  }

  prompt(id: string, promptId: string, text: string) {
    const attachment = this.attached(id);
    const digest = createHash("sha256").update(text).digest("hex");
    const previous = attachment.seen.get(promptId);
    if (previous) {
      if (previous !== digest)
        throw new Error("Message ID already used with different text.");
      return undefined;
    }
    if (attachment.turn)
      throw new Error("This workspace already has a queued or running turn.");
    if (attachment.seen.size >= 128)
      throw new Error("Reconnect after 128 turns.");
    attachment.seen.set(promptId, digest);
    if (attachment.cancelled.delete(promptId)) {
      this.publish(attachment, { type: "done", promptId, status: "cancelled" });
      return undefined;
    }
    const turn: Turn = {
      id: promptId,
      controller: new AbortController(),
      deadline: setTimeout(() => {
        this.end(
          attachment,
          turn,
          "failed",
          "Turn deadline exceeded. Inspect the workspace and deployment logs before retrying.",
        );
      }, this.turnMs).unref(),
    };
    attachment.turn = turn;
    return { cwd: attachment.cwd };
  }

  result(id: string, callId: string, result: ClientResult) {
    const attachment = this.attached(id);
    if (attachment.completedCalls.has(callId)) return;
    const pending = attachment.pending.get(callId);
    if (!pending) throw new Error("Tool request is no longer pending.");
    attachment.completedCalls.add(callId);
    pending(result);
  }

  private end(
    attachment: Attachment,
    turn: Turn,
    status: "completed" | "cancelled" | "failed",
    text: string,
  ) {
    if (attachment.turn !== turn) return;
    clearTimeout(turn.deadline);
    this.publish(attachment, { type: "message", text });
    this.publish(attachment, { type: "done", promptId: turn.id, status });
    attachment.turn = undefined;
    attachment.completedCalls.clear();
    turn.controller.abort(new Error("Editor turn ended."));
  }

  cancel(id: string, promptId: string) {
    const attachment = this.attached(id);
    if (attachment.turn?.id === promptId)
      this.end(attachment, attachment.turn, "cancelled", "Stopped.");
    else if (!attachment.seen.has(promptId)) {
      if (attachment.cancelled.size >= 128)
        throw new Error("Too many cancellation requests.");
      attachment.cancelled.add(promptId);
    }
  }

  detach(id: string) {
    const attachment = this.attachment;
    if (!attachment || attachment.id !== id) return;
    clearTimeout(attachment.lease);
    attachment.unlisten();
    if (attachment.turn) clearTimeout(attachment.turn.deadline);
    attachment.turn?.controller.abort(
      new Error("Editor disconnected or its lease expired."),
    );
    this.attachment = undefined;
  }

  finish(id: string, promptId: string, text: string) {
    const attachment = this.attachment;
    if (!attachment || attachment.id !== id || attachment.turn?.id !== promptId)
      return;
    this.end(attachment, attachment.turn, "completed", text);
  }

  turn(id: string, promptId: string, operationSignal: AbortSignal) {
    const attachment = this.attached(id);
    const turn = attachment.turn;
    if (!turn || turn.id !== promptId)
      throw new Error("Turn is no longer attached to an editor.");
    const signal = AbortSignal.any([operationSignal, turn.controller.signal]);
    return {
      signal,
      message: (text: string) => {
        signal.throwIfAborted();
        this.publish(attachment, { type: "message", text });
      },
      fail: () =>
        this.end(
          attachment,
          turn,
          signal.aborted ? "cancelled" : "failed",
          signal.aborted
            ? "Stopped."
            : "The remote turn failed. Check the deployment logs.",
        ),
    };
  }

  async call(
    id: string,
    callId: string,
    operation: Operation,
    operationSignal: AbortSignal,
  ) {
    operationSignal.throwIfAborted();
    const attachment = this.attached(id);
    const turn = attachment.turn;
    if (!turn) throw new Error("No active editor turn.");
    const signal = AbortSignal.any([operationSignal, turn.controller.signal]);
    signal.throwIfAborted();
    let aborted = () => {};
    const result = await new Promise<ClientResult>((resolve, reject) => {
      aborted = () => reject(signal.reason);
      attachment.pending.set(callId, resolve);
      signal.addEventListener("abort", aborted, { once: true });
      this.publish(attachment, {
        type: "call",
        promptId: turn.id,
        callId,
        operation,
      });
    }).finally(() => {
      attachment.pending.delete(callId);
      signal.removeEventListener("abort", aborted);
    });
    signal.throwIfAborted();
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }
}

import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import {
  type BridgeRequest,
  type ClientResult,
  openedSchema,
  pollSchema,
} from "../protocol.ts";
import { formatOperationError } from "./errors.mts";
import type { ApprovalMode } from "./types.ts";
import { Workspace } from "./workspace.mts";

type Turn = {
  id: string;
  controller: AbortController;
  submitted: boolean;
  remoteDone: boolean;
  complete: (response: acp.PromptResponse) => void;
  fail: (error: unknown) => void;
};
const bridgeError = (message: string) => new acp.RequestError(-32001, message);

type Attachment = {
  attachmentId: string;
  workspace: Workspace;
  cursor: number;
  controller: AbortController;
  turn: Turn | undefined;
  closing?: Promise<void>;
};

export function createBridge(
  endpoint: string,
  token: string,
  approvalMode: ApprovalMode = "ask",
) {
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash)
    throw bridgeError(
      "Endpoint must not include credentials, a query, or a fragment.",
    );
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw bridgeError("Use HTTPS, or HTTP on loopback for local testing.");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/acp`;
  if (token.length < 32)
    throw bridgeError("The token file must contain at least 32 characters.");
  const attachments = new Map<string, Attachment>();
  const lifetime = new AbortController();
  let capabilities: acp.ClientCapabilities = {};
  let busy = false;
  let quarantined = false;
  const ready = () => {
    lifetime.signal.throwIfAborted();
    if (quarantined)
      throw bridgeError(
        "Local operation outcome unknown. Inspect the workspace and running commands before restarting this bridge.",
      );
  };
  const request = async (body: BridgeRequest, signal?: AbortSignal) => {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: {
        "x-acp-token": token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([
        AbortSignal.timeout(10_000),
        ...(signal ? [signal] : []),
      ]),
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      const message = `Remote bridge HTTP ${response.status}: ${typeof result === "object" && result !== null && "error" in result ? String(result.error) : "request failed"}`;
      throw response.status === 401
        ? acp.RequestError.authRequired(undefined, message)
        : bridgeError(message);
    }
    return result;
  };
  const settle = async (attachment: Attachment) => {
    try {
      await attachment.workspace.settle();
    } catch {
      quarantined = true;
      ready();
    }
  };
  const closeAttachment = (id: string): Promise<void> => {
    const attachment = attachments.get(id);
    if (!attachment) return Promise.resolve();
    attachment.closing ??= (async () => {
      attachment.controller.abort(new Error("Attachment disconnected."));
      attachment.turn?.controller.abort(new Error("Attachment disconnected."));
      attachment.turn?.fail(
        new Error(
          "Editor disconnected; inspect the workspace before creating a new session.",
        ),
      );
      await settle(attachment).catch(() => {});
      await request({
        action: "close",
        sessionId: attachment.attachmentId,
      }).catch(() => {});
      attachments.delete(id);
    })();
    return attachment.closing;
  };
  const cancel = async (attachment: Attachment, turn: Turn) => {
    turn.controller.abort(new Error("Cancelled by the editor."));
    if (turn.submitted && !turn.remoteDone)
      await request({
        action: "cancel",
        sessionId: attachment.attachmentId,
        promptId: turn.id,
      }).catch(turn.fail);
  };
  const poll = async (id: string, attachment: Attachment) => {
    try {
      while (!attachment.controller.signal.aborted) {
        const page = pollSchema.parse(
          await request(
            {
              action: "poll",
              sessionId: attachment.attachmentId,
              after: attachment.cursor,
            },
            attachment.controller.signal,
          ),
        );
        for (const { sequence, event } of page.events) {
          attachment.cursor = sequence;
          if (event.type === "message")
            await attachment.workspace.update({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `${event.text}\n\n` },
            });
          else if (event.type === "done") {
            const turn = attachment.turn;
            if (!turn || event.promptId !== turn.id) continue;
            turn.remoteDone = true;
            if (event.status === "failed")
              turn.fail(
                new Error("Remote turn failed; inspect deployment logs."),
              );
            else
              turn.complete({
                stopReason:
                  event.status === "cancelled" ? "cancelled" : "end_turn",
              });
          } else {
            const turn = attachment.turn;
            if (
              !turn ||
              turn.id !== event.promptId ||
              turn.controller.signal.aborted
            )
              continue;
            void attachment.workspace
              .execute(event.callId, event.operation, turn.controller.signal)
              .then<ClientResult, ClientResult>(
                (value) => ({ ok: true, value }),
                (error: unknown) => ({
                  ok: false,
                  error: formatOperationError(error),
                }),
              )
              .then((result) => {
                if (attachment.turn === turn && !turn.controller.signal.aborted)
                  return request(
                    {
                      action: "result",
                      sessionId: attachment.attachmentId,
                      callId: event.callId,
                      result,
                    },
                    turn.controller.signal,
                  );
              })
              .catch((error: unknown) => {
                if (attachment.turn !== turn || turn.controller.signal.aborted)
                  return;
                turn.fail(error);
                void closeAttachment(id);
              });
          }
        }
        await delay(attachment.turn ? 250 : 1000, undefined, {
          signal: attachment.controller.signal,
        });
      }
    } catch (error) {
      if (!attachment.controller.signal.aborted) {
        attachment.turn?.fail(error);
        await attachment.workspace
          .update({
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "Connection lost. Attachment closed; inspect any in-flight command before retrying.\n",
            },
          })
          .catch(() => {});
        await closeAttachment(id);
      }
    }
  };
  const app = acp
    .agent({ name: "acp-code" })
    .onRequest("initialize", ({ params }) => {
      capabilities = params.clientCapabilities ?? {};
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: {
          name: "acp-code",
          title: "Adapt ACP Code",
          version: "0.1.0",
        },
        agentCapabilities: {
          sessionCapabilities: { close: {} },
        },
      };
    })
    .onRequest("session/new", async ({ params, client, signal }) => {
      ready();
      if (!isAbsolute(params.cwd))
        throw bridgeError("Open an absolute workspace directory in Patchbay.");
      const combined = AbortSignal.any([signal, lifetime.signal]);
      const cwd = await realpath(params.cwd);
      const { sessionId: attachmentId } = openedSchema.parse(
        await request({ action: "open", cwd }, combined),
      );
      if (combined.aborted || quarantined) {
        await request({ action: "close", sessionId: attachmentId }).catch(
          () => {},
        );
        combined.throwIfAborted();
        ready();
      }
      const attachment: Attachment = {
        attachmentId,
        workspace: new Workspace(
          cwd,
          client,
          attachmentId,
          capabilities,
          approvalMode,
        ),
        cursor: 0,
        controller: new AbortController(),
        turn: undefined,
      };
      attachments.set(attachmentId, attachment);
      void poll(attachmentId, attachment);
      if (params.mcpServers.length)
        console.error(
          "acp-code: MCP servers are not attached; use text/file context.",
        );
      return { sessionId: attachmentId };
    })
    .onRequest("session/close", async ({ params }) => {
      await closeAttachment(params.sessionId);
      return {};
    })
    .onRequest("session/prompt", async ({ params, signal }) => {
      ready();
      const attachment = attachments.get(params.sessionId);
      if (!attachment || attachment.closing)
        throw bridgeError("Create a new session to attach the editor.");
      if (busy)
        throw bridgeError(
          "Wait for the current prompt and local operations to finish.",
        );
      busy = true;
      const controller = new AbortController();
      const combined = AbortSignal.any([
        signal,
        controller.signal,
        attachment.controller.signal,
        lifetime.signal,
      ]);
      const completion = Promise.withResolvers<acp.PromptResponse>();
      void completion.promise.catch(() => {});
      const turn: Turn = {
        id: randomUUID(),
        controller,
        submitted: false,
        remoteDone: false,
        complete: completion.resolve,
        fail: completion.reject,
      };
      attachment.turn = turn;
      const cancelled = () => {
        void cancel(attachment, turn);
      };
      signal.addEventListener("abort", cancelled, { once: true });
      try {
        const chunks: string[] = [];
        for (const part of params.prompt) {
          combined.throwIfAborted();
          if (part.type === "text") chunks.push(part.text);
          else if (
            part.type === "resource_link" &&
            part.uri.startsWith("file:")
          ) {
            const path = fileURLToPath(part.uri);
            chunks.push(
              `[Attached path: ${part.uri}]\n${await attachment.workspace.execute(randomUUID(), { kind: "read", path }, combined)}`,
            );
          } else
            throw bridgeError(
              "Only text and text/file context are supported. Remove images or unsupported attachments.",
            );
        }
        const text = chunks.join("\n\n");
        if (!text.trim() || text.length > 32_000)
          throw bridgeError(
            "Prompt plus context must contain 1–32,000 characters.",
          );
        combined.throwIfAborted();
        turn.submitted = true;
        await request(
          {
            action: "prompt",
            sessionId: attachment.attachmentId,
            promptId: turn.id,
            text,
          },
          combined,
        );
        return await completion.promise;
      } catch (error) {
        if (controller.signal.aborted && !attachment.controller.signal.aborted)
          return { stopReason: "cancelled" };
        throw error;
      } finally {
        signal.removeEventListener("abort", cancelled);
        controller.abort(new Error("Turn finished."));
        if (turn.submitted && !turn.remoteDone) await cancel(attachment, turn);
        try {
          await settle(attachment);
        } finally {
          if (attachment.turn === turn) attachment.turn = undefined;
          busy = false;
        }
      }
    })
    .onNotification("session/cancel", async ({ params }) => {
      const attachment = attachments.get(params.sessionId);
      if (attachment?.turn) await cancel(attachment, attachment.turn);
    });
  return {
    app,
    close: async () => {
      lifetime.abort(new Error("Bridge closed."));
      await Promise.all([...attachments.keys()].map(closeAttachment));
    },
  };
}

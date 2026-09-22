import { createHash, timingSafeEqual } from "node:crypto";
import type {
  AgentChannel,
  AgentConnection,
  AgentIntegration,
  ConnectionContext,
} from "@adaptcom/core";
import {
  type DiagnosticLogger,
  errorMetadata,
  logDiagnostic,
} from "../../diagnostics.ts";
import { BridgeStateError } from "./errors.ts";
import { type BridgeRequest, requestSchema } from "../../protocol.ts";
import type { AcpAccess } from "../types.ts";

export const acpIntegration: AgentIntegration<{
  conversationId: string;
  promptId: string;
  text: string;
  cwd: string;
}> = {
  name: "acp",
  normalize(input) {
    return {
      address: {
        integration: "acp",
        connectionId: "ide",
        conversationId: input.conversationId,
      },
      trigger: {
        externalId: input.promptId,
        type: "message",
        actorId: "developer",
        text: input.text,
        data: { cwd: input.cwd },
      },
    };
  },
};

interface AcpChannelOptions {
  connection: AgentConnection<AcpAccess>;
  log?: DiagnosticLogger;
  token: (context: ConnectionContext) => Promise<string>;
}

export function createAcpChannel(options: AcpChannelOptions): AgentChannel {
  const json = (body: unknown, status = 200) => ({
    response: Response.json(body, {
      status,
      headers: { "cache-control": "no-store" },
    }),
  });
  return {
    name: "acp",
    path: "/acp",
    async receive(request) {
      const started = performance.now();
      let input: BridgeRequest | undefined;
      const reply = (body: unknown, status = 200, error?: unknown) => {
        (options.log ?? logDiagnostic)("acp.bridge.request", {
          action: input?.action,
          sessionId:
            input && "sessionId" in input ? input.sessionId : undefined,
          promptId: input && "promptId" in input ? input.promptId : undefined,
          callId: input && "callId" in input ? input.callId : undefined,
          status,
          durationMs: Math.round(performance.now() - started),
          ...(error === undefined ? {} : errorMetadata(error)),
        });
        return json(body, status);
      };
      request.signal.throwIfAborted();
      let token: string;
      try {
        token = await options.token({ signal: request.signal });
      } catch {
        request.signal.throwIfAborted();
        throw new Error("Cannot resolve ACP token. Check its secret binding.");
      }
      request.signal.throwIfAborted();
      if (typeof token !== "string" || token.trim().length < 32)
        throw new Error("ACP_TOKEN must contain at least 32 characters.");
      const expected = Buffer.from(token);
      const received = Buffer.from(request.headers.get("x-acp-token") ?? "");
      if (
        received.length !== expected.length ||
        !timingSafeEqual(received, expected)
      )
        return reply({ error: "Unauthorized." }, 401);
      if (request.method !== "POST") return reply({ error: "Use POST." }, 405);
      if (
        request.headers.get("content-type")?.split(";")[0] !==
        "application/json"
      )
        return reply({ error: "Use application/json." }, 400);
      const body = await request.text();
      try {
        input = requestSchema.parse(JSON.parse(body));
      } catch (error) {
        return reply(
          { error: "Invalid bridge request.", code: "INVALID_REQUEST" },
          400,
          error,
        );
      }
      try {
        const access = await options.connection.connect({
          signal: request.signal,
        });
        switch (input.action) {
          case "open":
            return reply({ sessionId: access.open(input.cwd).attachmentId });
          case "poll":
            return reply(access.poll(input.sessionId, input.after));
          case "prompt": {
            const accepted = access.prompt(
              input.sessionId,
              input.promptId,
              input.text,
            );
            const trigger = accepted
              ? await acpIntegration.normalize({
                  ...accepted,
                  promptId: input.promptId,
                  text: input.text,
                })
              : undefined;
            return {
              ...reply({ accepted: true }, 202),
              ...(trigger ? { trigger } : {}),
            };
          }
          case "result":
            access.result(input.sessionId, input.callId, input.result);
            break;
          case "cancel":
            access.cancel(input.sessionId, input.promptId);
            break;
          case "close":
            access.close(input.sessionId);
            break;
        }
        return reply({ ok: true });
      } catch (error) {
        return reply(
          {
            error:
              error instanceof Error ? error.message : "Bridge request failed.",
            ...(error instanceof BridgeStateError ? { code: error.code } : {}),
          },
          409,
          error,
        );
      }
    },
    async send(reply) {
      const access = await options.connection.connect({ signal: reply.signal });
      access.finish(
        reply.address.conversationId,
        reply.operationId,
        reply.text,
      );
    },
  };
}

/** Public, credential-free executable artifact, fixed for this service revision. */
export function createClientDownloadChannel(
  clientBundle: string,
): AgentChannel {
  if (!clientBundle.trim())
    throw new Error("Build the ACP client before deploying.");
  const headers = {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": String(Buffer.byteLength(clientBundle)),
    etag: `"${createHash("sha256").update(clientBundle).digest("hex")}"`,
  };
  return {
    name: "acp-client",
    path: "/acp/client.mjs",
    async receive(request) {
      if (request.method !== "GET" && request.method !== "HEAD")
        return {
          response: new Response("Use GET or HEAD.", {
            status: 405,
            headers: { allow: "GET, HEAD", "cache-control": "no-store" },
          }),
        };
      return {
        response: new Response(
          request.method === "HEAD" ? null : clientBundle,
          { headers },
        ),
      };
    },
  };
}

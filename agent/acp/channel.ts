import { createHash, timingSafeEqual } from "node:crypto";
import type {
  AgentChannel,
  AgentConnection,
  AgentIntegration,
  ConnectionContext,
} from "@adaptcom/core";
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
        return json({ error: "Unauthorized." }, 401);
      if (request.method !== "POST") return json({ error: "Use POST." }, 405);
      if (
        request.headers.get("content-type")?.split(";")[0] !==
        "application/json"
      )
        return json({ error: "Use application/json." }, 400);
      const body = await request.text();
      if (Buffer.byteLength(body) > 300_000)
        return json({ error: "Request too large." }, 413);
      let input: BridgeRequest;
      try {
        input = requestSchema.parse(JSON.parse(body));
      } catch {
        return json({ error: "Invalid bridge request." }, 400);
      }
      try {
        const access = await options.connection.connect({
          signal: request.signal,
        });
        switch (input.action) {
          case "open":
            return json({ sessionId: access.open(input.cwd).attachmentId });
          case "poll":
            return json(access.poll(input.sessionId, input.after));
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
              ...json({ accepted: true }, 202),
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
        return json({ ok: true });
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error ? error.message : "Bridge request failed.",
          },
          409,
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

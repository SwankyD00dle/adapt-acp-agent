import { setTimeout as delay } from "node:timers/promises";
import * as acp from "@agentclientprotocol/sdk";
import {
  type DiagnosticLogger,
  errorMetadata,
  logDiagnostic,
} from "../diagnostics.ts";
import { type BridgeRequest, editorLeaseMs, pollSchema } from "../protocol.ts";

type RequestOptions = { signal?: AbortSignal; timeoutMs?: number };
export type TransportOptions = {
  requestTimeoutMs?: number;
  pollRecoveryMs?: number;
  retryDelayMs?: number;
  log?: DiagnosticLogger;
};

class TransportError extends acp.RequestError {
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly remoteCode: string | undefined;
  constructor(
    message: string,
    retryable: boolean,
    status?: number,
    remoteCode?: string,
  ) {
    super(status === 401 ? -32000 : -32001, message);
    this.retryable = retryable;
    this.status = status;
    this.remoteCode = remoteCode;
  }
}

/** Only polling is retried. Prompts, commands, writes, and result uploads are never replayed. */
export function createTransport(
  url: URL,
  token: string,
  options: TransportOptions = {},
) {
  const log = options.log ?? logDiagnostic;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const recoveryMs = Math.min(
    options.pollRecoveryMs ?? 40_000,
    editorLeaseMs - 5_000,
  );
  const retryDelayMs = options.retryDelayMs ?? 250;
  const request = async (
    body: BridgeRequest,
    settings: RequestOptions = {},
  ) => {
    const started = performance.now();
    const signal = AbortSignal.any([
      AbortSignal.timeout(
        Math.max(1, Math.ceil(settings.timeoutMs ?? requestTimeoutMs)),
      ),
      ...(settings.signal ? [settings.signal] : []),
    ]);
    let status: number | undefined;
    let phase = "fetch";
    try {
      const response = await fetch(url, {
        method: "POST",
        redirect: "error",
        headers: { "x-acp-token": token, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      status = response.status;
      if (!response.ok) {
        // Status, not JSON decoding, decides whether an HTML proxy error is retryable.
        const retryable = [408, 429, 500, 502, 503, 504].includes(status);
        const body: unknown = await response.json().catch(() => undefined);
        const remoteCode =
          typeof body === "object" &&
          body !== null &&
          "code" in body &&
          typeof body.code === "string" &&
          /^[A-Z][A-Z_0-9]{0,63}$/.test(body.code)
            ? body.code
            : undefined;
        const message =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof body.error === "string"
            ? body.error
            : "request failed";
        throw new TransportError(
          `Remote bridge HTTP ${status}: ${message}`,
          retryable,
          status,
          remoteCode,
        );
      }
      phase = "response_body";
      return (await response.json()) as unknown;
    } catch (error) {
      settings.signal?.throwIfAborted();
      log("acp.client.request_failed", {
        action: body.action,
        sessionId: "sessionId" in body ? body.sessionId : undefined,
        callId: "callId" in body ? body.callId : undefined,
        promptId: "promptId" in body ? body.promptId : undefined,
        status,
        phase,
        remoteCode:
          error instanceof TransportError ? error.remoteCode : undefined,
        durationMs: Math.round(performance.now() - started),
        ...errorMetadata(error),
      });
      if (error instanceof TransportError) throw error;
      // A malformed successful response is a protocol failure, not an outage.
      const retryable =
        !(error instanceof SyntaxError) &&
        (error instanceof TypeError || signal.aborted);
      throw new TransportError(
        signal.aborted
          ? `Remote bridge request timed out (${body.action}).`
          : `Remote bridge request failed (${body.action}).`,
        retryable,
        status,
      );
    }
  };
  return {
    request(body: BridgeRequest, signal?: AbortSignal) {
      return request(body, signal ? { signal } : {});
    },
    async poll(
      body: Extract<BridgeRequest, { action: "poll" }>,
      signal: AbortSignal,
      lastPollAt: number,
    ) {
      const deadline = lastPollAt + recoveryMs;
      let attempt = 0;
      while (true) {
        signal.throwIfAborted();
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          log("acp.client.poll_exhausted", {
            sessionId: body.sessionId,
            attempt,
            lastPollAgeMs: Math.round(performance.now() - lastPollAt),
          });
          throw new acp.RequestError(
            -32001,
            "Polling recovery deadline exceeded; the editor lease cannot be trusted.",
          );
        }
        const sentAt = performance.now();
        try {
          const response = await request(body, {
            signal,
            timeoutMs: Math.min(requestTimeoutMs, remaining),
          });
          const page = pollSchema.parse(response);
          if (attempt)
            log("acp.client.poll_recovered", {
              sessionId: body.sessionId,
              attempt,
            });
          // Use send time, not receive time, as a conservative lease-renewal bound.
          return { page, sentAt };
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof TransportError) || !error.retryable)
            throw error;
          attempt++;
          const waitMs = Math.min(
            retryDelayMs * 2 ** Math.min(attempt - 1, 3),
            2_000,
            Math.max(0, deadline - performance.now()),
          );
          log("acp.client.poll_retry", {
            sessionId: body.sessionId,
            attempt,
            status: error.status,
            waitMs,
            lastPollAgeMs: Math.round(performance.now() - lastPollAt),
          });
          await delay(waitMs, undefined, { signal });
        }
      }
    },
  };
}

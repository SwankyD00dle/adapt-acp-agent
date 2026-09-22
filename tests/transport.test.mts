import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import test, { type TestContext } from "node:test";
import { createTransport } from "../client/transport.mts";
import type { DiagnosticLogger } from "../diagnostics.ts";

async function fixture(
  t: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  options: { requestTimeoutMs?: number; pollRecoveryMs?: number } = {},
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const entries: Record<string, unknown>[] = [];
  const log: DiagnosticLogger = (event, fields) => {
    entries.push({ event, ...fields });
  };
  const transport = createTransport(
    new URL(`http://127.0.0.1:${address.port}/acp`),
    "test",
    {
      requestTimeoutMs: 100,
      pollRecoveryMs: 1000,
      retryDelayMs: 5,
      ...options,
      log,
    },
  );
  const body = { action: "poll", sessionId: randomUUID(), after: 7 } as const;
  const poll = (
    signal = new AbortController().signal,
    lastPollAt = performance.now(),
  ) => transport.poll(body, signal, lastPollAt);
  return { transport, poll, entries };
}

for (const status of [408, 429, 500, 502, 503, 504]) {
  test(`a single HTTP ${status} retries the same poll cursor and recovers`, async (t) => {
    const bodies: string[] = [];
    const { poll, entries } = await fixture(t, (request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        bodies.push(body);
        if (bodies.length === 1)
          response.writeHead(status).end("<html>transient proxy error</html>");
        else response.end(JSON.stringify({ events: [], cursor: 7 }));
      });
    });
    assert.equal((await poll()).page.cursor, 7);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
    assert.ok(entries.some((entry) => entry.event === "acp.client.poll_retry"));
    assert.ok(
      entries.some((entry) => entry.event === "acp.client.poll_recovered"),
    );
  });
}

for (const status of [400, 401, 403, 409, 413]) {
  test(`HTTP ${status} fails immediately instead of retrying`, async (t) => {
    let count = 0;
    const { poll, entries } = await fixture(t, (_request, response) => {
      count++;
      response.writeHead(status).end(
        JSON.stringify({
          error: "private content",
          code: "ATTACHMENT_EXPIRED",
        }),
      );
    });
    await assert.rejects(poll(), new RegExp(`HTTP ${status}`));
    assert.equal(count, 1);
    assert.ok(!JSON.stringify(entries).includes("private content"));
    assert.equal(entries[0]?.remoteCode, "ATTACHMENT_EXPIRED");
  });
}

test("a socket reset or request timeout can recover without resubmitting a prompt", async (t) => {
  let count = 0;
  const { poll } = await fixture(
    t,
    (request, response) => {
      count++;
      if (count === 1) request.socket.destroy();
      else if (count === 2) {
        /* deliberately time out */
      } else response.end(JSON.stringify({ events: [], cursor: 7 }));
    },
    { requestTimeoutMs: 30 },
  );
  assert.equal((await poll()).page.cursor, 7);
  assert.equal(count, 3);
});

test("recovery budget includes time elapsed since the last successful poll", async (t) => {
  let count = 0;
  const { poll, entries } = await fixture(
    t,
    (_request, response) => {
      count++;
      response.writeHead(503).end();
    },
    { pollRecoveryMs: 100 },
  );
  const started = performance.now();
  await assert.rejects(poll(undefined, started - 80), /recovery deadline/);
  assert.ok(performance.now() - started < 250);
  assert.ok(count > 0);
  assert.ok(
    entries.some((entry) => entry.event === "acp.client.poll_exhausted"),
  );
});

test("editor cancellation interrupts retry backoff", async (t) => {
  const controller = new AbortController();
  const { poll } = await fixture(t, (_request, response) => {
    response.writeHead(503).end();
    setTimeout(() => controller.abort(new Error("Editor stopped")), 5);
  });
  await assert.rejects(poll(controller.signal), /Editor stopped|aborted/);
});

for (const responseBody of [
  "not json",
  JSON.stringify({
    events: [{ sequence: 8, event: { type: "unknown" } }],
    cursor: 8,
  }),
]) {
  test("invalid successful responses fail fast rather than retrying forever", async (t) => {
    let count = 0;
    const { poll } = await fixture(t, (_request, response) => {
      count++;
      response.end(responseBody);
    });
    await assert.rejects(poll());
    assert.equal(count, 1);
  });
}

test("non-poll requests are never automatically replayed", async (t) => {
  let count = 0;
  const { transport } = await fixture(t, (_request, response) => {
    count++;
    response.writeHead(503).end();
  });
  const sessionId = randomUUID();
  const bodies = [
    { action: "prompt", sessionId, promptId: randomUUID(), text: "test" },
    {
      action: "result",
      sessionId,
      callId: randomUUID(),
      result: { ok: true, value: null },
    },
  ] as const;
  for (const body of bodies)
    await assert.rejects(transport.request(body), /503/);
  assert.equal(count, 2);
});

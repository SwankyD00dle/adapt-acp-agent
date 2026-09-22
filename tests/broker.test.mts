import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { IdeBroker } from "../agent/acp/broker.ts";
import { createAcpChannel } from "../agent/acp/channel.ts";
import { createAcpConnection } from "../agent/acp/connection.ts";
import type { DiagnosticLogger } from "../diagnostics.ts";

function logs() {
  const entries: Record<string, unknown>[] = [];
  const log: DiagnosticLogger = (event, fields) => {
    entries.push({ event, ...fields });
  };
  return { entries, log };
}

for (const reason of [
  "client_close",
  "host_aborted",
  "lease_expired",
] as const) {
  test(`detach logs distinguish ${reason} and retain poll/turn metadata`, async () => {
    const { entries, log } = logs();
    const host = new AbortController();
    const broker = new IdeBroker(
      reason === "lease_expired" ? 30 : 1000,
      10_000,
      log,
    );
    const { attachmentId } = broker.attach("/workspace", host.signal);
    const promptId = randomUUID();
    broker.prompt(attachmentId, promptId, "private prompt");
    broker.poll(attachmentId, 0);
    const turn = broker.turn(attachmentId, promptId, host.signal);
    if (reason === "client_close") broker.detach(attachmentId);
    else if (reason === "host_aborted") host.abort();
    else await delay(80);
    assert.equal(turn.signal.aborted, true);
    assert.equal(broker.hasAttachment(attachmentId), false);
    const entry = entries.find(
      (entry) => entry.event === "acp.attachment.detached",
    );
    assert.equal(entry?.reason, reason);
    assert.equal(entry?.promptId, promptId);
    assert.equal(typeof entry?.lastPollAgeMs, "number");
    assert.equal(entry?.lastCursor, 0);
    assert.ok(!JSON.stringify(entries).includes("private prompt"));
  });
}

test("successful polling refreshes the lease", async () => {
  const broker = new IdeBroker(150, 1000, () => {});
  const host = new AbortController();
  const { attachmentId } = broker.attach("/workspace", host.signal);
  for (let i = 0; i < 4; i++) {
    await delay(50);
    broker.poll(attachmentId, 0);
  }
  assert.equal(broker.hasAttachment(attachmentId), true);
  host.abort();
});

test("invalid tool input is rejected before publishing and leaves the editor attached", async () => {
  const host = new AbortController();
  const broker = new IdeBroker(1000, 1000, () => {});
  const { attachmentId } = broker.attach("/workspace", host.signal);
  broker.prompt(attachmentId, randomUUID(), "test");
  await assert.rejects(
    broker.call(
      attachmentId,
      randomUUID(),
      { kind: "exec", command: "", timeoutMs: 100 },
      host.signal,
    ),
  );
  assert.deepEqual(broker.poll(attachmentId, 0).events, []);
  assert.equal(broker.hasAttachment(attachmentId), true);
  host.abort();
});

test("cancel and close are idempotent in either ordering, including missing sessions", async () => {
  const { entries, log } = logs();
  const host = new AbortController();
  const connection = createAcpConnection({ log });
  const token = "test-only-credential-not-a-real-secret";
  const channel = createAcpChannel({
    connection,
    token: async () => token,
    log,
  });
  const send = async (body: unknown) => {
    const result = await channel.receive(
      new Request("http://localhost/acp", {
        method: "POST",
        headers: { "x-acp-token": token, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: host.signal,
      }),
    );
    return result.response;
  };
  for (const order of [
    ["close", "cancel"],
    ["cancel", "close"],
  ]) {
    const open = await send({ action: "open", cwd: "/workspace" });
    const { sessionId } = await open.json();
    const promptId = randomUUID();
    assert.equal(
      (
        await send({
          action: "prompt",
          sessionId,
          promptId,
          text: "private prompt",
        })
      ).status,
      202,
    );
    for (const action of [...order, ...order]) {
      assert.equal(
        (
          await send(
            action === "close"
              ? { action, sessionId }
              : { action, sessionId, promptId },
          )
        ).status,
        200,
      );
    }
  }
  assert.equal(
    (
      await send({
        action: "cancel",
        sessionId: randomUUID(),
        promptId: randomUUID(),
      })
    ).status,
    200,
  );
  const expired = await send({
    action: "poll",
    sessionId: randomUUID(),
    after: 0,
  });
  assert.equal(expired.status, 409);
  assert.equal((await expired.json()).code, "ATTACHMENT_EXPIRED");
  const failure = entries.find(
    (entry) => entry.event === "acp.bridge.request" && entry.status === 409,
  );
  assert.equal(failure?.action, "poll");
  assert.equal(failure?.errorCode, "ATTACHMENT_EXPIRED");
  assert.ok(!JSON.stringify(entries).includes(token));
  assert.ok(!JSON.stringify(entries).includes("private prompt"));
  host.abort();
});

test("channel accepts large prompt strings without the old 300KB body cap", async () => {
  const connection = createAcpConnection({ log: () => {} });
  const host = new AbortController();
  const access = await connection.connect({ signal: host.signal });
  const { attachmentId } = access.open("/workspace");
  const token = "test-only-credential-not-a-real-secret";
  const channel = createAcpChannel({
    connection,
    token: async () => token,
    log: () => {},
  });
  const result = await channel.receive(
    new Request("http://localhost/acp", {
      method: "POST",
      headers: { "x-acp-token": token, "content-type": "application/json" },
      body: JSON.stringify({
        action: "prompt",
        sessionId: attachmentId,
        promptId: randomUUID(),
        text: "x".repeat(310_000),
      }),
      signal: host.signal,
    }),
  );
  assert.equal(result.response.status, 202);
  host.abort();
});

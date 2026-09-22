import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { createChannelServer } from "@adaptcom/core";
import { createAcpChannel } from "../agent/acp/channel.ts";
import { createAcpConnection } from "../agent/acp/connection.ts";
import type { AcpAccess } from "../agent/types.ts";
import { clientBundle } from "../client/generated/bundle.js";
import type { DiagnosticLogger } from "../diagnostics.ts";
import {
  type BridgeRequest,
  openedSchema,
  requestSchema,
} from "../protocol.ts";

type RpcFrame = {
  id?: number;
  method?: string;
  params?: { args?: string[] };
  result?: unknown;
  error?: { code: number; message: string };
};
type Active = { access: AcpAccess; sessionId: string; promptId: string };

async function fixture(
  t: TestContext,
  mode:
    | "retry-and-long-command"
    | "close"
    | "cancel-then-close"
    | "cancel-fails"
    | "invalid-event",
) {
  const directory = await mkdtemp(join(tmpdir(), "acp-regression-"));
  const token = "test-only-not-a-real-acp-credential";
  await writeFile(join(directory, "token"), token, { mode: 0o600 });
  await writeFile(join(directory, "client.mjs"), clientBundle);
  const entries: Record<string, unknown>[] = [];
  const log: DiagnosticLogger = (event, fields) => {
    entries.push({ event, ...fields });
  };
  const connection = createAcpConnection({ log });
  const channel = createAcpChannel({
    connection,
    token: async () => token,
    log,
  });
  const actions: { input: BridgeRequest; status: number }[] = [];
  const active = Promise.withResolvers<Active>();
  const cancelReceived = Promise.withResolvers<void>();
  const releaseCancel = Promise.withResolvers<void>();
  let injected = false;
  let running = false;
  const host = createChannelServer({
    channels: [
      {
        ...channel,
        async receive(request) {
          const input = requestSchema.parse(await request.clone().json());
          if (input.action === "cancel" && mode === "cancel-then-close") {
            cancelReceived.resolve();
            await releaseCancel.promise;
          }
          if (
            input.action === "cancel" &&
            mode === "cancel-fails" &&
            !injected
          ) {
            injected = true;
            actions.push({ input, status: 503 });
            return {
              response: new Response("temporary proxy failure", {
                status: 503,
              }),
            };
          }
          if (input.action === "poll" && running && !injected) {
            if (mode === "retry-and-long-command" || mode === "invalid-event") {
              injected = true;
              const status = mode === "invalid-event" ? 200 : 503;
              actions.push({ input, status });
              return {
                response:
                  mode === "invalid-event"
                    ? Response.json({
                        events: [{ sequence: 1, event: { type: "invalid" } }],
                        cursor: 1,
                      })
                    : new Response("temporary proxy failure", { status }),
              };
            }
          }
          const result = await channel.receive(request);
          actions.push({ input, status: result.response.status });
          return result;
        },
      },
    ],
    async dispatch(_channel, trigger, signal) {
      const access = await connection.connect({ signal });
      const state = {
        access,
        sessionId: trigger.address.conversationId,
        promptId: trigger.trigger.externalId,
      };
      const turn = access.turn(state.sessionId, state.promptId);
      running = true;
      active.resolve(state);
      if (mode === "retry-and-long-command") {
        const result = await access.call(state.sessionId, randomUUID(), {
          kind: "exec",
          command: "#".repeat(32_001),
          timeoutMs: 1000,
        });
        assert.equal(typeof result, "object");
        access.finish(state.sessionId, state.promptId, "Done.");
      } else {
        await new Promise<void>((_resolve, reject) => {
          turn.signal.addEventListener(
            "abort",
            () => reject(turn.signal.reason),
            { once: true },
          );
        });
      }
    },
    onError: (error: unknown) => {
      entries.push({
        event: "dispatch_failed",
        message: error instanceof Error ? error.message : "unknown",
      });
    },
  });
  await new Promise<void>((resolve) =>
    host.server.listen(0, "127.0.0.1", resolve),
  );
  const address = host.server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const child = spawn(
    process.execPath,
    [
      join(directory, "client.mjs"),
      "--url",
      endpoint,
      "--token-file",
      join(directory, "token"),
      "--approval-mode",
      "auto",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const pending = new Map<number, (frame: RpcFrame) => void>();
  const editorCalls: RpcFrame[] = [];
  const stderr: string[] = [];
  let nextId = 1;
  createInterface({ input: child.stderr }).on("line", (line) =>
    stderr.push(line),
  );
  const send = (frame: object) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
  createInterface({ input: child.stdout }).on("line", (line) => {
    const frame = JSON.parse(line) as RpcFrame;
    if (frame.method && frame.id !== undefined) {
      editorCalls.push(frame);
      const result =
        frame.method === "terminal/create"
          ? { terminalId: "terminal-1" }
          : frame.method === "terminal/wait_for_exit"
            ? { exitCode: 0 }
            : frame.method === "terminal/output"
              ? { output: "ok", truncated: false, exitStatus: { exitCode: 0 } }
              : {};
      send({ id: frame.id, result });
    } else if (frame.id !== undefined) {
      pending.get(frame.id)?.(frame);
      pending.delete(frame.id);
    }
  });
  const rpc = (method: string, params: unknown) => {
    const id = nextId++;
    return new Promise<RpcFrame>((resolve) => {
      pending.set(id, resolve);
      send({ id, method, params });
    });
  };
  t.after(async () => {
    releaseCancel.resolve();
    child.stdin.end();
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      delay(500),
    ]);
    child.kill("SIGKILL");
    await host.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.ok(
    (
      await rpc("initialize", {
        protocolVersion: 1,
        clientCapabilities: { terminal: true },
      })
    ).result,
  );
  const opened = await rpc("session/new", { cwd: directory, mcpServers: [] });
  const { sessionId } = openedSchema.parse(opened.result);
  const prompt = rpc("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "x".repeat(40_000) }],
  });
  await active.promise;
  return {
    rpc,
    notify: (method: string, params: unknown) => send({ method, params }),
    prompt,
    sessionId,
    entries,
    actions,
    stderr,
    editorCalls,
    cancelReceived,
    releaseCancel,
    endpoint,
  };
}

test("shipped client survives a transient poll failure and executes a >32KB command exactly once", {
  timeout: 10_000,
}, async (t) => {
  const f = await fixture(t, "retry-and-long-command");
  assert.deepEqual((await f.prompt).result, { stopReason: "end_turn" });
  const commands = f.editorCalls.filter(
    (frame) => frame.method === "terminal/create",
  );
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.params?.args?.[1]?.length, 32_001);
  assert.equal(
    f.actions.filter(({ input }) => input.action === "prompt").length,
    1,
  );
  assert.equal(
    f.actions.filter(({ input }) => input.action === "result").length,
    1,
  );
  assert.equal(
    f.actions.filter(
      ({ input }) => input.action === "close" || input.action === "cancel",
    ).length,
    0,
  );
  assert.ok(f.actions.some(({ status }) => status === 503));
  assert.ok(
    f.stderr.some((line) => line.includes("acp.client.poll_recovered")),
  );
  assert.ok(!f.stderr.join("\n").includes("x".repeat(100)));
  assert.ok(!f.stderr.join("\n").includes("#".repeat(100)));
});

test("closing an active prompt does not send a racing cancellation", {
  timeout: 10_000,
}, async (t) => {
  const f = await fixture(t, "close");
  assert.deepEqual(
    (await f.rpc("session/close", { sessionId: f.sessionId })).result,
    {},
  );
  assert.ok((await f.prompt).error);
  assert.equal(
    f.actions.filter(({ input }) => input.action === "close").length,
    1,
  );
  assert.equal(
    f.actions.filter(({ input }) => input.action === "cancel").length,
    0,
  );
  assert.ok(!f.actions.some(({ status }) => status === 409));
  assert.ok(
    f.entries.some(
      (entry) =>
        entry.event === "acp.attachment.detached" &&
        entry.reason === "client_close",
    ),
  );
});

test("close joins cancellation already on the wire and does not duplicate it", {
  timeout: 10_000,
}, async (t) => {
  const f = await fixture(t, "cancel-then-close");
  f.notify("session/cancel", { sessionId: f.sessionId });
  await f.cancelReceived.promise;
  const closing = f.rpc("session/close", { sessionId: f.sessionId });
  await delay(30);
  assert.equal(
    f.actions.filter(({ input }) => input.action === "close").length,
    0,
  );
  f.releaseCancel.resolve();
  assert.deepEqual((await closing).result, {});
  await f.prompt;
  const teardown = f.actions.filter(
    ({ input }) => input.action === "close" || input.action === "cancel",
  );
  assert.deepEqual(
    teardown.map(({ input }) => input.action),
    ["cancel", "close"],
  );
  assert.ok(teardown.every(({ status }) => status === 200));
});

test("malformed poll logs the initiating validation error, closes once, and can reconnect", {
  timeout: 10_000,
}, async (t) => {
  const f = await fixture(t, "invalid-event");
  assert.ok((await f.prompt).error);
  // close acknowledgement and the prompt response travel independently.
  for (
    let i = 0;
    i < 100 && !f.actions.some(({ input }) => input.action === "close");
    i++
  )
    await delay(10);
  assert.equal(
    f.actions.filter(({ input }) => input.action === "close").length,
    1,
  );
  assert.equal(
    f.actions.filter(({ input }) => input.action === "cancel").length,
    0,
  );
  const logs = f.stderr
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const failure = logs.findIndex(
    (entry) => entry.event === "acp.client.failure",
  );
  const close = logs.findIndex((entry) => entry.event === "acp.client.close");
  assert.ok(failure >= 0 && close > failure);
  assert.equal(logs[failure]?.errorType, "ValidationError");
  assert.equal(logs[failure]?.phase, "poll");
  assert.equal((await fetch(`${f.endpoint}/healthz`)).status, 200);
  assert.ok(
    (await f.rpc("session/new", { cwd: tmpdir(), mcpServers: [] })).result,
  );
});

test("a failed cancellation closes the attachment instead of orphaning a live remote turn", {
  timeout: 10_000,
}, async (t) => {
  const f = await fixture(t, "cancel-fails");
  f.notify("session/cancel", { sessionId: f.sessionId });
  assert.ok((await f.prompt).error);
  for (
    let i = 0;
    i < 100 && !f.actions.some(({ input }) => input.action === "close");
    i++
  )
    await delay(10);
  const teardown = f.actions.filter(
    ({ input }) => input.action === "cancel" || input.action === "close",
  );
  assert.deepEqual(
    teardown.map(({ input, status }) => [input.action, status]),
    [
      ["cancel", 503],
      ["close", 200],
    ],
  );
  assert.ok(
    f.entries.some(
      (entry) =>
        entry.event === "acp.attachment.detached" &&
        entry.reason === "client_close",
    ),
  );
  assert.ok(
    f.entries.some(
      (entry) =>
        entry.event === "dispatch_failed" &&
        entry.message === "Editor attachment closed: client_close.",
    ),
  );
  assert.ok(f.stderr.some((line) => line.includes('"reason":"cancel_failed"')));
  const again = await f.rpc("session/prompt", {
    sessionId: f.sessionId,
    prompt: [{ type: "text", text: "Do not submit to the old turn" }],
  });
  assert.match(again.error?.message ?? "", /Create a new session/);
  assert.equal(
    f.actions.filter(({ input }) => input.action === "prompt").length,
    1,
  );
  assert.ok(!f.actions.some(({ status }) => status === 409));
});

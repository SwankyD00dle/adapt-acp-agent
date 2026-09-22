import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { errorMetadata } from "../diagnostics.ts";
import {
  execInputSchema,
  execResultSchema,
  operationSchema,
  pollSchema,
  readInputSchema,
  requestSchema,
  resultSchema,
  writeInputSchema,
} from "../protocol.ts";

test("tool inputs and poll events share validation without arbitrary string caps", () => {
  const path = "a".repeat(4097);
  const operations = [
    { kind: "read", ...readInputSchema.parse({ path }) },
    {
      kind: "write",
      ...writeInputSchema.parse({ path, contents: "b".repeat(400_000) }),
    },
    { kind: "exec", ...execInputSchema.parse({ command: "c".repeat(32_001) }) },
  ];
  for (const operation of operations) {
    assert.deepEqual(operationSchema.parse(operation), operation);
    assert.doesNotThrow(() =>
      pollSchema.parse({
        events: [
          {
            sequence: 1,
            event: {
              type: "call",
              promptId: randomUUID(),
              callId: randomUUID(),
              operation,
            },
          },
        ],
        cursor: 1,
      }),
    );
  }
});

test("prompt, cwd, and result wire strings have no bridge-only maximum", () => {
  assert.doesNotThrow(() =>
    requestSchema.parse({ action: "open", cwd: `/${"x".repeat(5000)}` }),
  );
  assert.doesNotThrow(() =>
    requestSchema.parse({
      action: "prompt",
      sessionId: randomUUID(),
      promptId: randomUUID(),
      text: "x".repeat(40_000),
    }),
  );
  assert.doesNotThrow(() =>
    resultSchema.parse({ ok: false, error: "x".repeat(10_000) }),
  );
  assert.doesNotThrow(() =>
    execResultSchema.parse({
      stdout: "x".repeat(100_000),
      stderr: "",
      exitCode: 0,
      timedOut: false,
      truncated: false,
      durationMs: 1,
    }),
  );
});

test("shared validation retains nonempty commands, safe paths, and execution deadlines", () => {
  assert.equal(execInputSchema.safeParse({ command: " " }).success, false);
  assert.equal(
    operationSchema.safeParse({ kind: "exec", command: " ", timeoutMs: 1 })
      .success,
    false,
  );
  assert.equal(
    execInputSchema.safeParse({ command: "true", timeoutMs: 60_001 }).success,
    false,
  );
  for (const path of ["", "bad\0path"]) {
    assert.equal(readInputSchema.safeParse({ path }).success, false);
    assert.equal(
      writeInputSchema.safeParse({ path, contents: "" }).success,
      false,
    );
    assert.equal(
      operationSchema.safeParse({ kind: "read", path }).success,
      false,
    );
  }
});

test("diagnostics expose schema paths and error codes, not payloads or error data", () => {
  const secret = "DO_NOT_LOG_WORKSPACE_CONTENT";
  const invalid = operationSchema.safeParse({
    kind: "exec",
    command: { secret },
    timeoutMs: 1,
  });
  assert.equal(invalid.success, false);
  if (!invalid.success) {
    const metadata = errorMetadata(invalid.error);
    assert.equal(metadata.errorType, "ValidationError");
    assert.ok(JSON.stringify(metadata).includes("command"));
    assert.ok(!JSON.stringify(metadata).includes(secret));
  }
  const error = Object.assign(new Error(secret), {
    code: "ECONNRESET",
    data: secret,
    cause: Object.assign(new Error(secret), { code: "UND_ERR_SOCKET" }),
  });
  assert.deepEqual(errorMetadata(error), {
    errorType: "Error",
    errorCode: "ECONNRESET",
    causeCode: "UND_ERR_SOCKET",
  });
});

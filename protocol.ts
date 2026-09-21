import { z } from "zod";

export const maxFileBytes = 64_000;
export const maxOutputCharacters = 32_000;
export const filePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), "Paths cannot contain null bytes.");

const id = z.uuid();
const text = z.string().max(64_000);
export const operationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("read"),
    path: z.string().min(1).max(4096),
  }),
  z.strictObject({
    kind: z.literal("write"),
    path: z.string().min(1).max(4096),
    contents: z.string(),
  }),
  z.strictObject({
    kind: z.literal("exec"),
    command: z.string().min(1).max(32_000),
    timeoutMs: z.number().int().min(1).max(60_000),
  }),
]);
export type Operation = z.infer<typeof operationSchema>;
export const resultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: z.json() }),
  z.strictObject({ ok: z.literal(false), error: z.string().max(4096) }),
]);
export type ClientResult = z.infer<typeof resultSchema>;
export const requestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("open"),
    cwd: z.string().min(1).max(4096),
  }),
  z.strictObject({
    action: z.literal("prompt"),
    sessionId: id,
    promptId: id,
    text: z.string().trim().min(1).max(32_000),
  }),
  z.strictObject({
    action: z.literal("poll"),
    sessionId: id,
    after: z.number().int().nonnegative(),
  }),
  z.strictObject({
    action: z.literal("result"),
    sessionId: id,
    callId: id,
    result: resultSchema,
  }),
  z.strictObject({
    action: z.literal("cancel"),
    sessionId: id,
    promptId: id,
  }),
  z.strictObject({ action: z.literal("close"), sessionId: id }),
]);
export type BridgeRequest = z.infer<typeof requestSchema>;
export const eventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("message"), text: z.string() }),
  z.strictObject({
    type: z.literal("call"),
    promptId: id,
    callId: id,
    operation: operationSchema,
  }),
  z.strictObject({
    type: z.literal("done"),
    promptId: id,
    status: z.enum(["completed", "cancelled", "failed"]),
  }),
]);
export type BridgeEvent = z.infer<typeof eventSchema>;
export const pollSchema = z.strictObject({
  events: z.array(
    z.strictObject({ sequence: z.number().int(), event: eventSchema }),
  ),
  cursor: z.number().int(),
});
export const openedSchema = z.strictObject({ sessionId: id });
export const execResultSchema = z.strictObject({
  stdout: text,
  stderr: text,
  exitCode: z.number().int(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
  durationMs: z.number().nonnegative(),
});

import { z } from "zod";

// Resource budgets, not ACP string-validation limits.
export const maxFileBytes = 64_000;
export const maxOutputCharacters = 32_000;
export const editorLeaseMs = 45_000;
export const filePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), "Paths cannot contain null bytes.");

const id = z.uuid();
export const readInputSchema = z.object({ path: filePathSchema });
export const writeInputSchema = z.object({
  path: filePathSchema,
  contents: z.string(),
});
export const execInputSchema = z.object({
  command: z.string().trim().min(1),
  stdin: z.string().optional(),
  timeoutMs: z.number().int().min(1).max(60_000).default(30_000),
});
export const operationSchema = z.discriminatedUnion("kind", [
  readInputSchema.extend({ kind: z.literal("read") }).strict(),
  writeInputSchema.extend({ kind: z.literal("write") }).strict(),
  execInputSchema
    .omit({ stdin: true })
    .extend({ kind: z.literal("exec") })
    .strict(),
]);
export type Operation = z.infer<typeof operationSchema>;
export const resultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: z.json() }),
  z.strictObject({ ok: z.literal(false), error: z.string() }),
]);
export type ClientResult = z.infer<typeof resultSchema>;
export const requestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("open"), cwd: filePathSchema }),
  z.strictObject({
    action: z.literal("prompt"),
    sessionId: id,
    promptId: id,
    text: z.string().trim().min(1),
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
  z.strictObject({ action: z.literal("cancel"), sessionId: id, promptId: id }),
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
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
  durationMs: z.number().nonnegative(),
});

import { ZodError } from "zod";

export type DiagnosticLogger = (
  event: string,
  fields: Record<string, unknown>,
) => void;

/** Stderr only: stdout belongs to ACP. Callers supply metadata, never payloads. */
export const logDiagnostic: DiagnosticLogger = (event, fields) => {
  console.error(
    JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }),
  );
};

/** Error messages/data may contain workspace contents or credentials. */
export function errorMetadata(error: unknown): Record<string, unknown> {
  if (error instanceof ZodError)
    return {
      errorType: "ValidationError",
      issues: error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path,
      })),
    };
  const code = (value: unknown): string | number | undefined => {
    if (typeof value !== "object" || value === null || !("code" in value))
      return;
    if (typeof value.code === "number") return value.code;
    if (
      typeof value.code === "string" &&
      /^[A-Z][A-Z_0-9]{0,63}$/.test(value.code)
    )
      return value.code;
  };
  return {
    errorType: error instanceof Error ? error.name : "UnknownError",
    errorCode: code(error),
    causeCode: error instanceof Error ? code(error.cause) : undefined,
  };
}

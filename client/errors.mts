// Only inspect diagnostic fields, not arbitrary RPC payloads or stack traces.
function errorDiagnostics(error: unknown) {
  const codes: (string | number)[] = [];
  const messages: string[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number) => {
    if (typeof value === "string") {
      if (value && !messages.includes(value)) messages.push(value);
      return;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    if (
      "code" in value &&
      (typeof value.code === "string" || typeof value.code === "number")
    )
      codes.push(value.code);
    if ("message" in value && typeof value.message === "string")
      visit(value.message, depth + 1);
    if (depth >= 4) return;
    for (const field of ["data", "details", "cause"] as const)
      if (field in value)
        visit((value as Record<string, unknown>)[field], depth + 1);
  };
  visit(error, 0);
  return { codes, messages };
}

export function formatOperationError(error: unknown) {
  const { codes, messages } = errorDiagnostics(error);
  const code = codes.length ? ` [${[...new Set(codes)].join(", ")}]` : "";
  const [message = "Operation stopped.", ...details] = messages;
  return `${message}${code}${details.length ? `: ${details.join(": ")}` : ""}`;
}

export function isFileNotFound(error: unknown) {
  const { codes, messages } = errorDiagnostics(error);
  // Internal error is an SDK wrapper, not a filesystem failure. Any other
  // explicit code must agree that the file is missing; never mask EACCES etc.
  if (
    codes.some(
      (code) => ![-32603, -32002, "ENOENT", "FileNotFound"].includes(code),
    )
  )
    return false;
  if (
    codes.some(
      (code) => code === -32002 || code === "ENOENT" || code === "FileNotFound",
    )
  )
    return true;
  return messages.some((message) => {
    const detail = message
      .replace(/^cannot open file: .+\. Detail: /, "")
      .replace(/^Error: /, "");
    if (/^(?:ENOENT:|FileNotFound(?: \([^)]*\))?:)/.test(detail)) return true;
    if (/^(?:File not found|No such file or directory): .+/i.test(detail))
      return true;
    // VS Code may wrap the filesystem error from openTextDocument. Generic
    // "cannot open file", "Internal error", or permission errors are not absence.
    return /^Unable to read file .+ \(Error: Unable to resolve nonexistent file .+\)$/.test(
      detail,
    );
  });
}

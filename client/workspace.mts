import { lstat, opendir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  AgentContext,
  ClientCapabilities,
  SessionUpdate,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { Operation } from "../protocol.ts";
import { formatOperationError, isFileNotFound } from "./errors.mts";
import type { ApprovalMode } from "./types.ts";

const terminalControlTimeoutMs = 3000;

export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

export class Workspace {
  private readonly snapshots = new Map<string, string>();
  private readonly mutations = new Set<Promise<unknown>>();
  private uncertain = false;
  private uncertainWrite = false;

  private track<T>(promise: Promise<T>) {
    this.mutations.add(promise);
    const remove = () => {
      this.mutations.delete(promise);
    };
    void promise.then(remove, remove);
    return promise;
  }

  async settle() {
    await abortable(
      Promise.allSettled([...this.mutations]),
      AbortSignal.timeout(2 * terminalControlTimeoutMs + 1000),
    );
    if (this.uncertain || this.uncertainWrite)
      throw new Error("A local operation has an unknown outcome.");
  }
  readonly root: string;
  private readonly client: AgentContext;
  private readonly sessionId: string;
  private readonly capabilities: ClientCapabilities;
  private readonly approvalMode: ApprovalMode;
  constructor(
    root: string,
    client: AgentContext,
    sessionId: string,
    capabilities: ClientCapabilities,
    approvalMode: ApprovalMode = "ask",
  ) {
    this.root = root;
    this.client = client;
    this.sessionId = sessionId;
    this.capabilities = capabilities;
    this.approvalMode = approvalMode;
  }

  async path(input: string, allowRoot = false) {
    if (input.includes("\0")) throw new Error("Invalid file path.");
    const path = resolve(this.root, input);
    const inside = (candidate: string) => {
      const local = relative(this.root, candidate);
      if (
        (!local && !allowRoot) ||
        local === ".." ||
        local.startsWith(`..${sep}`) ||
        isAbsolute(local)
      )
        throw new Error(
          "Path is outside the attached workspace or is its root.",
        );
      const segments = local.split(sep).map((part) => part.toLowerCase());
      if (
        segments.some(
          (part) =>
            part === ".git" ||
            part === ".ssh" ||
            (part.startsWith(".env") && part !== ".env.example") ||
            /\.(pem|key|p12|pfx)$/i.test(part),
        )
      )
        throw new Error("Credential and Git metadata paths are blocked.");
    };
    inside(path);
    let parent = path;
    while (!(await exists(parent))) parent = dirname(parent);
    const canonical = await realpath(parent);
    if (canonical !== this.root) inside(canonical);
    return path;
  }

  private async isDirectory(path: string) {
    try {
      return (await stat(path)).isDirectory();
    } catch (error) {
      // Unsaved editor buffers may not exist on disk. Still read those via ACP.
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return false;
      throw error;
    }
  }

  private async listDirectory(path: string, signal: AbortSignal) {
    const entries: string[] = [];
    let bytes = 0;
    let scanned = 0;
    let truncated = false;
    // ACP only defines text-file reads. Enumerate locally, never on the host,
    // without reading file contents or following child symlinks.
    const directory = await opendir(path);
    for await (const entry of directory) {
      signal.throwIfAborted();
      if (++scanned > 1000) {
        truncated = true;
        break;
      }
      if (!entry.isFile() && !entry.isDirectory()) continue;
      try {
        await this.path(resolve(path, entry.name));
      } catch {
        continue; // Do not expose protected paths in directory context.
      }
      const line = `${JSON.stringify(entry.name)}${entry.isDirectory() ? "/" : ""}`;
      if (
        entries.length >= 200 ||
        bytes + Buffer.byteLength(line) + 1 > 16_000
      ) {
        truncated = true;
        break;
      }
      entries.push(line);
      bytes += Buffer.byteLength(line) + 1;
    }
    signal.throwIfAborted();
    return [
      "Directory listing (immediate children only; protected paths and symlinks omitted):",
      ...entries.sort(),
      ...(truncated
        ? [
            "[Truncated. Read a subdirectory or use an approved command for more.]",
          ]
        : entries.length === 0
          ? ["[No visible entries.]"]
          : []),
    ].join("\n");
  }

  private async read(path: string, signal: AbortSignal) {
    if (!this.capabilities.fs?.readTextFile)
      throw new Error("The editor did not advertise file reads.");
    const response = await abortable(
      this.client.request(
        "fs/read_text_file",
        { sessionId: this.sessionId, path },
        { cancellationSignal: signal },
      ),
      signal,
    );
    return response.content;
  }

  private async readIfPresent(path: string, signal: AbortSignal) {
    try {
      return await this.read(path, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (!isFileNotFound(error) || (await exists(path))) throw error;
      signal.throwIfAborted();
      return null;
    }
  }

  async update(update: SessionUpdate) {
    await this.client.notify("session/update", {
      sessionId: this.sessionId,
      update,
    });
  }

  private async approve(toolCall: ToolCallUpdate, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.approvalMode === "auto") return;
    const response = await abortable(
      this.client.request(
        "session/request_permission",
        {
          sessionId: this.sessionId,
          toolCall,
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
        { cancellationSignal: signal },
      ),
      signal,
    );
    signal.throwIfAborted();
    if (
      response.outcome.outcome !== "selected" ||
      response.outcome.optionId !== "allow"
    )
      throw new Error(
        "The developer rejected this action. Do not work around it.",
      );
  }

  private assertCanExecute(signal: AbortSignal, readOnly = false) {
    signal.throwIfAborted();
    if (this.uncertain)
      throw new Error(
        "A local operation has an unknown outcome. No further tools may run; inspect the workspace first.",
      );
    if (this.uncertainWrite && !readOnly)
      throw new Error(
        "A file write has an unknown outcome. Only read_file inspection is allowed; writes and commands remain blocked. Ask the developer to inspect the workspace before restarting the bridge.",
      );
  }

  async execute(callId: string, operation: Operation, signal: AbortSignal) {
    // Inspection never clears uncertainty: a delayed write may still arrive.
    this.assertCanExecute(signal, operation.kind === "read");
    const title =
      operation.kind === "exec"
        ? operation.command
        : `${operation.kind}: ${operation.path}`;
    await this.update({
      sessionUpdate: "tool_call",
      toolCallId: callId,
      title,
      kind:
        operation.kind === "write"
          ? "edit"
          : operation.kind === "exec"
            ? "execute"
            : "read",
      status: "pending",
      rawInput: operation,
    });
    try {
      let value: string | null | Awaited<ReturnType<Workspace["exec"]>>;
      if (operation.kind === "exec")
        value = await this.track(this.exec(callId, operation, signal));
      else {
        const path = await this.path(operation.path, operation.kind === "read");
        if (operation.kind === "read") {
          if (await this.isDirectory(path))
            value = await this.listDirectory(path, signal);
          else {
            value = await this.read(path, signal);
            // Bound tool output, not the internal reads used to verify writes.
            if (Buffer.byteLength(value) > 64_000)
              throw new Error(
                "File exceeds 64 KB. Read a smaller portion with an approved command.",
              );
            this.snapshots.set(path, value);
          }
        } else {
          if (!this.capabilities.fs?.writeTextFile)
            throw new Error("The editor did not advertise file writes.");
          const before = await this.readIfPresent(path, signal);
          if (before !== null && this.snapshots.get(path) !== before)
            throw new Error(
              "Read the current file before editing; it is unread or changed.",
            );
          await this.approve(
            {
              toolCallId: callId,
              title,
              kind: "edit",
              content: [
                {
                  type: "diff",
                  path,
                  oldText: before,
                  newText: operation.contents,
                },
              ],
            },
            signal,
          );
          await this.path(operation.path);
          const current = await this.readIfPresent(path, signal);
          if (current !== before)
            throw new Error(
              "File changed during review. Read it again before editing.",
            );
          this.assertCanExecute(signal);
          try {
            await abortable(
              this.track(
                this.client.request(
                  "fs/write_text_file",
                  {
                    sessionId: this.sessionId,
                    path,
                    content: operation.contents,
                  },
                  { cancellationSignal: signal },
                ),
              ),
              signal,
            );
          } catch (error) {
            // Includes cancellation while the editor's write is still pending.
            this.uncertainWrite = true;
            throw new Error(
              `File write outcome unknown. Use read_file on the target path to inspect its current state; writes and commands remain blocked. ${formatOperationError(error)}`,
              { cause: error },
            );
          }
          if ((await this.readIfPresent(path, signal)) !== operation.contents)
            throw new Error(
              "The editor did not apply the proposed edit. Read the file before trying again.",
            );
          this.snapshots.set(path, operation.contents);
          value = null;
        }
      }
      await this.update({
        sessionUpdate: "tool_call_update",
        toolCallId: callId,
        status: "completed",
      });
      return value;
    } catch (error) {
      await this.update({
        sessionUpdate: "tool_call_update",
        toolCallId: callId,
        status: "failed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: formatOperationError(error),
            },
          },
        ],
      }).catch(() => {});
      throw error;
    }
  }

  private async exec(
    callId: string,
    operation: Extract<Operation, { kind: "exec" }>,
    signal: AbortSignal,
  ) {
    if (!this.capabilities.terminal)
      throw new Error("The editor did not advertise terminals.");
    await this.approve(
      { toolCallId: callId, title: operation.command, kind: "execute" },
      signal,
    );
    this.assertCanExecute(signal);
    const started = Date.now();
    const timeout = AbortSignal.timeout(operation.timeoutMs);
    const executionSignal = AbortSignal.any([signal, timeout]);
    let exited = false;
    const control = async (
      method: "terminal/kill" | "terminal/release",
      terminalId: string,
    ) => {
      const deadline = AbortSignal.timeout(terminalControlTimeoutMs);
      try {
        await abortable(
          this.client.request(
            method,
            {
              sessionId: this.sessionId,
              terminalId,
            },
            { cancellationSignal: deadline },
          ),
          deadline,
        );
        if (method === "terminal/kill") {
          await abortable(
            this.client.request(
              "terminal/wait_for_exit",
              { sessionId: this.sessionId, terminalId },
              { cancellationSignal: deadline },
            ),
            deadline,
          );
          exited = true;
        }
        return true;
      } catch {
        this.uncertain = true;
        return false;
      }
    };
    let killTask: Promise<boolean> | undefined;
    let cleanupTask: Promise<void> | undefined;
    const kill = (terminalId: string) =>
      (killTask ??= control("terminal/kill", terminalId));
    const clean = (terminalId: string) =>
      (cleanupTask ??= (async () => {
        if (!exited) await kill(terminalId);
        await control("terminal/release", terminalId);
      })());
    const created = this.client.request(
      "terminal/create",
      {
        sessionId: this.sessionId,
        command: "bash",
        args: ["-c", operation.command],
        cwd: this.root,
        outputByteLimit: 32_000,
      },
      { cancellationSignal: executionSignal },
    );
    void this.track(
      created.then(
        async (terminal) => {
          if (executionSignal.aborted) await clean(terminal.terminalId);
        },
        () => {
          this.uncertain = true;
        },
      ),
    );
    let terminalId: string;
    try {
      ({ terminalId } = await abortable(created, executionSignal));
    } catch (error) {
      this.uncertain = true;
      throw error;
    }
    let timedOut = false;
    try {
      await abortable(
        this.update({
          sessionUpdate: "tool_call_update",
          toolCallId: callId,
          status: "in_progress",
          content: [{ type: "terminal", terminalId }],
        }),
        executionSignal,
      );
      try {
        await abortable(
          this.client.request(
            "terminal/wait_for_exit",
            {
              sessionId: this.sessionId,
              terminalId,
            },
            { cancellationSignal: executionSignal },
          ),
          executionSignal,
        );
        exited = true;
      } catch (error) {
        const stopped = await kill(terminalId);
        if (!timeout.aborted || signal.aborted) throw error;
        if (!stopped)
          throw new Error(
            "Terminal could not be stopped. Inspect running commands before retrying.",
          );
        timedOut = true;
      }
      signal.throwIfAborted();
      const outputSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(terminalControlTimeoutMs),
      ]);
      const output = await abortable(
        this.client.request(
          "terminal/output",
          {
            sessionId: this.sessionId,
            terminalId,
          },
          { cancellationSignal: outputSignal },
        ),
        outputSignal,
      );
      return {
        stdout: output.output.slice(0, 32_000),
        stderr: "",
        exitCode: output.exitStatus?.exitCode ?? -1,
        timedOut,
        truncated: output.truncated || output.output.length > 32_000,
        durationMs: Date.now() - started,
      };
    } finally {
      await clean(terminalId);
    }
  }
}

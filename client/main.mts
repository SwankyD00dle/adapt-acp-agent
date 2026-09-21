import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { createBridge } from "./bridge.mts";

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      "token-file": { type: "string" },
      "approval-mode": { type: "string", default: "ask" },
    },
  });
  const approvalMode = values["approval-mode"];
  if (approvalMode !== "ask" && approvalMode !== "auto")
    throw new Error("--approval-mode must be ask or auto.");
  if (!values.url || !values["token-file"])
    throw new Error(
      "Usage: node main.mts --url <deployment-base-url> --token-file <absolute-private-file> [--approval-mode ask|auto]",
    );
  const file = values["token-file"];
  if (!isAbsolute(file)) throw new Error("Use an absolute token-file path.");
  const info = await stat(file);
  if (!info.isFile() || info.size > 4096)
    throw new Error("Token file must be a regular file smaller than 4 KB.");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    throw new Error("Run chmod 600 on the token file.");
  const bridge = createBridge(
    values.url,
    (await readFile(file, "utf8")).trim(),
    approvalMode,
  );
  if (approvalMode === "auto")
    console.error(
      "acp-code: auto approval enabled; edits and commands run without bridge review. Editor permissions still apply.",
    );
  const connection = bridge.app.connect(
    ndJsonStream(
      Writable.toWeb(process.stdout),
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    ),
  );
  const stop = () => {
    connection.close();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await connection.closed;
  await bridge.close();
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "ACP bridge failed.");
  process.exitCode = 1;
});

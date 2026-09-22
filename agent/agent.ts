import {
  createGitHubAiSdkHarness,
  createPlatinum,
  defineAgent,
  secret,
  type GitHubAccess,
} from "@adaptcom/core";
import { clientBundle } from "../client/generated/bundle.js";
import { required } from "../settings.ts";
import {
  createAcpChannel,
  createClientDownloadChannel,
} from "./acp/channel.ts";
import type { AcpAccess } from "./types.ts";

export default defineAgent({
  id: "acp-code",
  timeoutMs: 15 * 60_000,
  harness: async ({ connections, secrets, workspaceDirectory }) =>
    createGitHubAiSdkHarness({
      workspaceDirectory,
      github: connections.get<GitHubAccess>("github"),
      model: createPlatinum({
        apiKey: await secrets.resolve(secret("model.apiKey"), {
          signal: AbortSignal.timeout(30_000),
        }),
        baseURL: process.env.PLATINUM_URL,
      })(required("PLATINUM_MODEL")),
      maxSteps: 30,
    }),
  channels: ({ connections, secrets }) => [
    createClientDownloadChannel(clientBundle),
    createAcpChannel({
      connection: connections.get<AcpAccess>("acp"),
      token: (context) => secrets.resolve(secret("acp.token"), context),
    }),
  ],
});

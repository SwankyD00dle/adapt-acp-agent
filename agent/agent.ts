import {
  createAiSdkHarness,
  createPlatinum,
  defineAgent,
  secret,
} from "@adaptcom/core";
import { clientBundle } from "../client/generated/bundle.js";
import { required } from "../settings.ts";
import {
  createAcpChannel,
  createClientDownloadChannel,
} from "./acp/channel.ts";
import { createAcpHarness } from "./harness.ts";
import type { AcpAccess } from "./types.ts";

export default defineAgent({
  id: "acp-code",
  timeoutMs: 15 * 60_000,
  harness: async ({ connections, secrets }) =>
    createAcpHarness(
      connections.get<AcpAccess>("acp"),
      createAiSdkHarness({
        model: createPlatinum({
          apiKey: await secrets.resolve(secret("model.apiKey"), {
            signal: AbortSignal.timeout(30_000),
          }),
          baseURL: process.env.PLATINUM_URL,
        })(required("PLATINUM_MODEL")),
        maxSteps: 30,
        timeoutMs: 600_000,
      }),
    ),
  channels: ({ connections, secrets }) => [
    createClientDownloadChannel(clientBundle),
    createAcpChannel({
      connection: connections.get<AcpAccess>("acp"),
      token: (context) => secrets.resolve(secret("acp.token"), context),
    }),
  ],
});

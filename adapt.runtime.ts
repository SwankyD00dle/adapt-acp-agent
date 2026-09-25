import { createGitHubPersonalTokenConnection } from "./agent/connections/github.ts";
import { createPlatinumConnection } from "./agent/connections/platinum.ts";
import { createAcpConnection } from "./agent/acp/connection.ts";
import { defineRuntimeConfig } from "@adaptcom/core";

export default defineRuntimeConfig({
  connections: {
    acp: () => createAcpConnection(),
    github: ({ secrets }) => createGitHubPersonalTokenConnection(secrets),
    platinum: ({ secrets }) => createPlatinumConnection(secrets),
  },
  secrets: {
    "model.apiKey": { source: "env", variable: "PLATINUM_AUTH_TOKEN" },
    "acp.token": { source: "env", variable: "ACP_TOKEN" },
    "github.token": { source: "env", variable: "GITHUB_TOKEN" },
    "platinum.apiToken": {
      source: "env",
      variable: "PLATINUM_AUTH_TOKEN",
    },
  },
});

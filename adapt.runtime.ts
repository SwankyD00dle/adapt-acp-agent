import { defineRuntimeConfig } from "@adaptcom/core";
import { createAcpConnection } from "./agent/acp/connection.ts";

export default defineRuntimeConfig({
  connections: {
    acp: () => createAcpConnection(),
  },
  secrets: {
    "model.apiKey": { source: "env", variable: "PLATINUM_AUTH_TOKEN" },
    "acp.token": { source: "env", variable: "ACP_TOKEN" },
  },
});

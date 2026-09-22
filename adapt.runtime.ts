import { createGitHubPersonalTokenConnection } from "./agent/connections/github.ts";
import { createGoogleCloudConnection } from "./agent/connections/google-cloud.ts";
import { createPlatinumConnection } from "./agent/connections/platinum.ts";
import { createAcpConnection } from "./agent/acp/connection.ts";
import { defineRuntimeConfig } from "@adaptcom/core";
import { required } from "./settings.ts";

export default defineRuntimeConfig({
  connections: {
    acp: () => createAcpConnection(),
    github: ({ secrets }) => createGitHubPersonalTokenConnection(secrets),
    platinum: ({ secrets }) => createPlatinumConnection(secrets),
    googleCloud: ({ secrets }) =>
      createGoogleCloudConnection({
        secrets,
        projectId: required("GCP_STAGING_PROJECT_ID"),
        cluster: process.env.GCP_STAGING_CLUSTER ?? "adapt-staging",
        location: process.env.GCP_STAGING_CLUSTER_LOCATION ?? "us-central1",
        namespace: process.env.GCP_KUBERNETES_NAMESPACE ?? "staging",
        loggingProjectId:
          process.env.GCP_CLOUD_LOGGING_PROJECT_ID ??
          required("GCP_STAGING_PROJECT_ID"),
      }),
  },
  secrets: {
    "model.apiKey": { source: "env", variable: "PLATINUM_AUTH_TOKEN" },
    "acp.token": { source: "env", variable: "ACP_TOKEN" },
    "github.token": { source: "env", variable: "GITHUB_TOKEN" },
    "platinum.apiToken": {
      source: "env",
      variable: "PLATINUM_AUTH_TOKEN",
    },
    "gcp.serviceAccountJson": {
      source: "env",
      variable: "GCP_SERVICE_ACCOUNT_JSON",
    },
  },
});

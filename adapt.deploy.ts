import { createAdaptDeploymentTarget, defineDeployment } from "@adaptcom/core";
import { required } from "./settings.ts";

export default defineDeployment({
  targets: {
    adapt: ({ environment }) => {
      const volume =
        process.env[`ADAPT_VOLUME_${environment.toUpperCase()}`] ??
        process.env.ADAPT_VOLUME;
      return createAdaptDeploymentTarget({
        apiKey: required("PLATINUM_AUTH_TOKEN"),
        baseURL: process.env.PLATINUM_URL,
        ...(process.env.SANDBOX_IMAGE
          ? { image: process.env.SANDBOX_IMAGE }
          : {}),
        ttlSeconds: Number(process.env.SANDBOX_TTL_SECONDS ?? 0),
        memoryMiB: Number(process.env.SANDBOX_MEMORY_MIB ?? 1024),
        ...(volume ? { volume } : {}),
        env: () => ({
          ACP_TOKEN: required("ACP_TOKEN"),
          GITHUB_TOKEN: required("GITHUB_TOKEN"),
          GCP_SERVICE_ACCOUNT_JSON: required("GCP_SERVICE_ACCOUNT_JSON"),
          GCP_STAGING_PROJECT_ID: required("GCP_STAGING_PROJECT_ID"),
          PLATINUM_AUTH_TOKEN: required("PLATINUM_AUTH_TOKEN"),
          PLATINUM_MODEL: required("PLATINUM_MODEL"),
          ...(process.env.GCP_CLOUD_LOGGING_PROJECT_ID
            ? {
                GCP_CLOUD_LOGGING_PROJECT_ID:
                  process.env.GCP_CLOUD_LOGGING_PROJECT_ID,
              }
            : {}),
          ...(process.env.GCP_KUBERNETES_NAMESPACE
            ? { GCP_KUBERNETES_NAMESPACE: process.env.GCP_KUBERNETES_NAMESPACE }
            : {}),
          ...(process.env.GCP_STAGING_CLUSTER
            ? { GCP_STAGING_CLUSTER: process.env.GCP_STAGING_CLUSTER }
            : {}),
          ...(process.env.GCP_STAGING_CLUSTER_LOCATION
            ? {
                GCP_STAGING_CLUSTER_LOCATION:
                  process.env.GCP_STAGING_CLUSTER_LOCATION,
              }
            : {}),
          ...(process.env.PLATINUM_URL
            ? { PLATINUM_URL: process.env.PLATINUM_URL }
            : {}),
        }),
      });
    },
  },
});

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
          PLATINUM_AUTH_TOKEN: required("PLATINUM_AUTH_TOKEN"),
          ACP_TOKEN: required("ACP_TOKEN"),
          PLATINUM_MODEL: required("PLATINUM_MODEL"),
          ...(process.env.PLATINUM_URL
            ? { PLATINUM_URL: process.env.PLATINUM_URL }
            : {}),
        }),
      });
    },
  },
});

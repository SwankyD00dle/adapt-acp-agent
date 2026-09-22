import type {
  AgentConnection,
  HttpAccess,
  SecretResolver,
} from "@adaptcom/core";
import { createHttpConnection, secret } from "@adaptcom/core";

export const defaultPlatinumURL = "https://platinum.adaptstaging.com/v1";

export type PlatinumAccess = HttpAccess;

/** Read-only Platinum API access plus fixed-command Orc inspection through exec. */
export function createPlatinumConnection(
  secrets: SecretResolver,
  baseURL = process.env.PLATINUM_URL ?? defaultPlatinumURL,
): AgentConnection<PlatinumAccess> {
  const http = createHttpConnection({
    name: "platinum-staging",
    baseURL,
    headers: async (context) => ({
      accept: "application/json",
      authorization: `Bearer ${await secrets.resolve(
        secret("platinum.apiToken"),
        context,
      )}`,
      "content-type": "application/json",
    }),
  });
  return http;
}

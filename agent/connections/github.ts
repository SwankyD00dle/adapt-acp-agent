import type {
  AgentConnection,
  ConnectionContext,
  GitHubAccess,
  HttpAccess,
  SecretResolver,
} from "@adaptcom/core";
import { createHttpConnection, secret } from "@adaptcom/core";

const githubApiBaseURL = "https://api.github.com/";

/** GitHub access for a user-scoped fine-grained personal access token. */
export function createGitHubPersonalTokenConnection(
  secrets: SecretResolver,
): AgentConnection<GitHubAccess> {
  return {
    describe: () => ({
      name: "github-token",
      config: {
        baseURL: githubApiBaseURL,
        auth: "personal-token",
      },
    }),
    async connect(context: ConnectionContext) {
      const token = await secrets.resolve(secret("github.token"), context);
      const http = await createHttpConnection({
        name: "github",
        baseURL: githubApiBaseURL,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "adapt-github-ai-sdk-harness",
          "x-github-api-version": "2026-03-10",
        },
      }).connect(context);
      return {
        ...http,
        token,
        env: githubCommandEnvironment(token),
      };
    },
  };
}

function githubCommandEnvironment(token: string): Record<string, string> {
  return {
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
    GH_TOKEN: token,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_1: "!gh auth git-credential",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export type GitHubApiAccess = GitHubAccess & HttpAccess;

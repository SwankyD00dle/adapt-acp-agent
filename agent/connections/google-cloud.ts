import { JWT } from "google-auth-library";
import {
  CoreV1Api,
  KubeConfig,
  type V1ContainerStatus,
  type V1Pod,
} from "@kubernetes/client-node";
import type { AgentConnection, SecretResolver } from "@adaptcom/core";
import { secret } from "@adaptcom/core";
import { z } from "zod";

const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";
const clusterSchema = z.object({
  endpoint: z.string().min(1),
  masterAuth: z.object({ clusterCaCertificate: z.string().min(1) }),
});
const serviceAccountSchema = z.object({
  type: z.literal("service_account"),
  client_email: z.string().email(),
  private_key: z.string().startsWith("-----BEGIN"),
});

export interface PodSummary {
  name: string;
  namespace: string;
  phase: string | null;
  podIP: string | null;
  nodeName: string | null;
  reason: string | null;
  message: string | null;
  containers: {
    name: string;
    ready: boolean;
    restartCount: number;
    state: string;
  }[];
}

export interface CloudLogEntry {
  timestamp?: string;
  severity?: string;
  logName?: string;
  resource?: Record<string, unknown>;
  jsonPayload?: unknown;
  textPayload?: string;
  protoPayload?: unknown;
}

export interface GoogleCloudAccess {
  listPods(input: {
    namespace?: string;
    labelSelector?: string;
    limit?: number;
  }): Promise<PodSummary[]>;
  podLogs(input: {
    namespace?: string;
    pod: string;
    container?: string;
    tailLines?: number;
    previous?: boolean;
  }): Promise<string>;
  listLogs(input: { filter: string; limit?: number }): Promise<CloudLogEntry[]>;
}

export function createGoogleCloudConnection(options: {
  secrets: SecretResolver;
  projectId: string;
  cluster: string;
  location: string;
  namespace: string;
  loggingProjectId: string;
}): AgentConnection<GoogleCloudAccess> {
  return {
    describe: () => ({
      name: "google-cloud-staging-readonly",
      config: {
        projectId: options.projectId,
        cluster: options.cluster,
        location: options.location,
        namespace: options.namespace,
        loggingProjectId: options.loggingProjectId,
        access: "read-only",
      },
    }),
    async connect(context) {
      const serviceAccount = serviceAccountSchema.parse(
        JSON.parse(
          await options.secrets.resolve(
            secret("gcp.serviceAccountJson"),
            context,
          ),
        ),
      );
      const auth = new JWT({
        email: serviceAccount.client_email,
        key: serviceAccount.private_key,
        scopes: [cloudPlatformScope],
      });
      const credentials = await auth.getAccessToken();
      const accessToken = credentials.token;
      if (!accessToken)
        throw new Error("Google Cloud did not return an access token.");
      context.signal.throwIfAborted();

      const cluster = await readCluster({
        accessToken,
        projectId: options.projectId,
        cluster: options.cluster,
        location: options.location,
        signal: context.signal,
      });
      const kube = createKubeClient({
        accessToken,
        endpoint: cluster.endpoint,
        caData: cluster.masterAuth.clusterCaCertificate,
        clusterName: options.cluster,
        namespace: options.namespace,
      });
      const core = kube.makeApiClient(CoreV1Api);

      return {
        async listPods(input) {
          context.signal.throwIfAborted();
          const response = await core.listNamespacedPod({
            namespace: input.namespace ?? options.namespace,
            ...(input.labelSelector
              ? { labelSelector: input.labelSelector }
              : {}),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          });
          context.signal.throwIfAborted();
          return response.items.map(summarizePod);
        },
        async podLogs(input) {
          context.signal.throwIfAborted();
          const logs = await core.readNamespacedPodLog({
            name: input.pod,
            namespace: input.namespace ?? options.namespace,
            ...(input.container ? { container: input.container } : {}),
            ...(input.previous === undefined
              ? {}
              : { previous: input.previous }),
            tailLines: input.tailLines ?? 200,
            timestamps: true,
          });
          context.signal.throwIfAborted();
          return logs;
        },
        async listLogs(input) {
          context.signal.throwIfAborted();
          return readLogs({
            accessToken,
            projectId: options.loggingProjectId,
            filter: input.filter,
            limit: input.limit ?? 50,
            signal: context.signal,
          });
        },
      };
    },
  };
}

async function readCluster(input: {
  accessToken: string;
  projectId: string;
  cluster: string;
  location: string;
  signal: AbortSignal;
}) {
  const path = [
    "projects",
    encodeURIComponent(input.projectId),
    "locations",
    encodeURIComponent(input.location),
    "clusters",
    encodeURIComponent(input.cluster),
  ].join("/");
  const response = await fetch(`https://container.googleapis.com/v1/${path}`, {
    headers: { authorization: `Bearer ${input.accessToken}` },
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Google Kubernetes Engine returned HTTP ${response.status}.`,
    );
  }
  return clusterSchema.parse(await response.json());
}

function createKubeClient(input: {
  accessToken: string;
  endpoint: string;
  caData: string;
  clusterName: string;
  namespace: string;
}) {
  const server = input.endpoint.startsWith("https://")
    ? input.endpoint
    : `https://${input.endpoint}`;
  const kube = new KubeConfig();
  kube.loadFromOptions({
    clusters: [
      {
        name: input.clusterName,
        server,
        caData: input.caData,
        skipTLSVerify: false,
      },
    ],
    users: [{ name: "google-cloud", token: input.accessToken }],
    contexts: [
      {
        name: input.clusterName,
        cluster: input.clusterName,
        user: "google-cloud",
        namespace: input.namespace,
      },
    ],
    currentContext: input.clusterName,
  });
  return kube;
}

async function readLogs(input: {
  accessToken: string;
  projectId: string;
  filter: string;
  limit: number;
  signal: AbortSignal;
}): Promise<CloudLogEntry[]> {
  const response = await fetch(
    "https://logging.googleapis.com/v2/entries:list",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        filter: input.filter,
        orderBy: "timestamp asc",
        pageSize: input.limit,
        resourceNames: [`projects/${input.projectId}`],
      }),
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Google Cloud Logging returned HTTP ${response.status}.`);
  }
  const body = (await response.json()) as { entries?: CloudLogEntry[] };
  return (body.entries ?? []).slice(0, input.limit);
}

function summarizePod(pod: V1Pod): PodSummary {
  return {
    name: pod.metadata?.name ?? "unknown",
    namespace: pod.metadata?.namespace ?? "unknown",
    phase: pod.status?.phase ?? null,
    podIP: pod.status?.podIP ?? null,
    nodeName: pod.spec?.nodeName ?? null,
    reason: pod.status?.reason ?? null,
    message: pod.status?.message ?? null,
    containers: (pod.status?.containerStatuses ?? []).map(summarizeContainer),
  };
}

function summarizeContainer(status: V1ContainerStatus) {
  const state = status.state ?? {};
  return {
    name: status.name ?? "unknown",
    ready: status.ready ?? false,
    restartCount: status.restartCount ?? 0,
    state: Object.keys(state)[0] ?? "unknown",
  };
}

# ACP Code

Connect ACP Patchbay in VS Code to a deployed veetwo coding agent. The agent runs
remotely; file reads, reviewed edits, and approved commands run in the workspace
where Patchbay launches the local client. No workspace checkout is uploaded and
no command falls back to execution on the deployment host.

Everything, including the bridge, deployment configuration, tests, and client
SDK dependency, lives in this example. This is an example-specific agent, not a
way to attach arbitrary, already-deployed agents without changing their tools.

```text
Patchbay in VS Code
  ↕ ACP v1 / stdio
downloaded client.mjs on the workspace machine
  ↕ dedicated-header-authenticated HTTPS POST /acp + polling
veetwo service → agent → editor-backed tools
```

## 1. Install

Run from the veetwo repository root with Node 24+ and pnpm:

```sh
pnpm install --frozen-lockfile
cp examples/acp-code/.env.example examples/acp-code/.env
```

The example declares `@adaptcom/core`, `@adaptcom/cli`, the ACP client SDK, and its build dependencies.
The workspace install builds and links the framework. To copy this example into
another project, follow the [package setup instructions](../README.md#copying-an-example-into-your-own-project).
Patchbay can run the standalone download with Node 24+ and no npm dependencies.
macOS/Linux with `bash` are supported; Windows requires a WSL workspace.

## 2. Create credentials and deploy

Create a dedicated client token outside the workspace. The command below refuses
to overwrite an existing token; reuse that file if you already created it.

```sh
mkdir -p "$HOME/.config/adapt"
node --input-type=module -e '
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
writeFileSync(`${homedir()}/.config/adapt/acp-code.token`, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
'
chmod 600 "$HOME/.config/adapt/acp-code.token"
```

Export your Adapt credentials using your existing credential workflow:
`PLATINUM_AUTH_TOKEN`, and optionally `PLATINUM_URL`. The token must be authorized
for both deployment and model access. Export the dedicated client token too:

```sh
export ACP_TOKEN="$(cat "$HOME/.config/adapt/acp-code.token")"
```

Do not give Patchbay the model/management token. Only the separate ACP token
belongs in the local token file.

Set in the project's `.env` or export in your shell:

```dotenv
PLATINUM_MODEL=<a-model-route-available-to-your-account>
SANDBOX_TTL_SECONDS=0
```

Also set `PLATINUM_AUTH_TOKEN`, `ACP_TOKEN`, and optional `PLATINUM_URL` there if
they are not already exported. Keep `.env` out of Git. Both local serving and
deployment use these environment variables; no vault setup is required.
`adapt.deploy.ts` explicitly forwards both tokens to the worker environment,
and `adapt.runtime.ts` resolves them from that environment. Treat deployment
environment configuration as sensitive, and redeploy after changing either token.
The deployed `ACP_TOKEN` must match the raw token in Patchbay's local token file.

```sh
pnpm --filter acp-code run deploy --environment staging
pnpm adapt status examples/acp-code --environment staging
```

**TTL 0 means no automatic expiration. Compute charges continue until you stop
this deployment.** Set a finite TTL instead if you prefer an expiring experiment.
No cloud resources are created by the example's tests.

Use the returned public service base URL, also stored under `.handle.url` in:

```text
examples/acp-code/.adapt/deployments/adapt/staging/deployment.json
```

Do not use the management API endpoint under `.handle.metadata.endpoint`.
Keep any ingress/port path in the service URL. The client appends `/acp` itself.

## 3. Attach Patchbay

Open the project you want the agent to work on, then open **Patchbay → Settings →
Agents** and add a custom command-line agent. Node 24+, `bash`, and `curl` must be
installed on the workspace machine; the repository and npm dependencies are not
needed there. `command -v node` prints your Node path.

### Download and run on every launch

Use this command in Patchbay, replacing the URL and absolute paths:

```sh
/bin/bash -c 'set -eu; client_dir="$(mktemp -d)"; trap '\''rm -rf "$client_dir"'\'' EXIT; curl --fail --silent --show-error --proto "=https" --max-time 60 "${1%/}/acp/client.mjs" -o "$client_dir/client.mjs"; "$2" "$client_dir/client.mjs" --url "$1" --token-file "$3"' acp-code https://your-public-service-base-url /absolute/path/to/node /absolute/path/to/.config/adapt/acp-code.token
```

If Patchbay separates executable and arguments, use `/bin/bash` as the executable
and the following as separate argument values (do not include the outer shell
quotes around the script):

```text
-c
set -eu; client_dir="$(mktemp -d)"; trap 'rm -rf "$client_dir"' EXIT; curl --fail --silent --show-error --proto "=https" --max-time 60 "${1%/}/acp/client.mjs" -o "$client_dir/client.mjs"; "$2" "$client_dir/client.mjs" --url "$1" --token-file "$3"
acp-code
https://your-public-service-base-url
/absolute/path/to/node
/absolute/path/to/.config/adapt/acp-code.token
```

This downloads the client embedded in that deployment, then starts its ACP stdio
bridge. A failed download stops startup; it never falls back to a stale client.
The temporary directory is removed when the client exits. Curl writes only to
the file and reports errors on stderr, leaving stdout/stdin exclusively for ACP.
Restart the Patchbay agent after redeploying; running clients do not auto-update.

Keep the **entire ingress/port prefix** in the public service base URL.
`GET /acp/client.mjs` is public and needs no token; `HEAD` returns artifact headers.
The standalone ES module contains the bridge, workspace adapter, and SDK, not
Node itself or deployment credentials. Only download executable code from a
deployment you trust. The response includes a SHA-256 ETag (an artifact identifier,
not a signature) and disables caching. The `/acp` API still requires your dedicated
token.

Quote paths containing spaces in a single command-line field. The token file
contains the raw token, not `ACP_TOKEN=...`. Do not paste credentials into the
command, URL, VS Code workspace settings, or chat. Patchbay launches this process;
it is not a URL-only connection and it does not require `adapt dev` locally.

Select the agent, create a **new session**, and confirm the session's working
directory is the project you want to edit. By default, the bridge uses
`--approval-mode ask`. File and command approvals may appear twice because both
the bridge and Patchbay enforce them independently.

ACP requires a session ID for prompts and editor callbacks. Here it identifies
only a live, leased editor attachment: there is no session listing, loading,
resumption, or history replay. Every new attachment starts a fresh conversation.

### Optional: automatic bridge approval

Add `--approval-mode auto` immediately after `--token-file "$3"` inside the shell
script. Then restart the agent and create a new session. This is a local client
option; no service redeployment is needed.
Remove the option or use `--approval-mode ask` to restore per-action bridge review.
Invalid modes are rejected at startup.

**Auto mode allows edits and shell commands without individual bridge review.**
Commands run with your workspace user's permissions, including access outside the
workspace and to the network. Use only with trusted work in a disposable branch
or isolated workspace. The client prints a startup warning to stderr.

Patchbay's own file/terminal permissions still apply. If it continues to prompt,
configure its permission/auto-approval controls separately; this flag does not
change extension settings or override editor rejections. Path protections,
read-before-write and stale-file checks, write verification, cancellation, command
limits, and unknown-outcome blocking remain enabled in both modes.

Use the default **Ask** mode for the following approval/rejection smoke tests.

Try these in a disposable Git branch:

1. `Read README.md and explain this project. Do not edit anything.`
2. `Create acp-smoke.txt containing hello. Ask before writing it.`
3. Reject an edit and confirm the file does not change.
4. `Run git status --short.` Approve only after reviewing the command.
5. Modify an open file without saving, then ask the agent to read it.

In SSH, WSL, or a dev container, the client must run in the **same filesystem
namespace as the workspace**. Install Node and download the client there. "Local"
means that workspace's machine, not necessarily the laptop.

For a local-only server test, set the model credentials and the same `ACP_TOKEN`
in the example's `.env` or environment, then run:

```sh
pnpm --filter acp-code serve --port 3000
```

Use `--url http://127.0.0.1:3000` in Patchbay. For the curl-and-run command, use
that base URL and change `--proto "=https"` to `--proto "=http"` for this loopback
test only. Do not use `adapt dev --ui` or terminal chat for this example: its tools require a live editor attachment.

## Safety and limits

- One developer/trust domain per deployment. Anyone with the ACP token can submit
  work, inspect bridge events, and answer callbacks. This is not multi-user RBAC.
- Direct file tools reject traversal, outside-workspace symlinks, `.git`, `.ssh`,
  `.env*` except `.env.example`, and common private-key extensions. Protected
  names are matched case-insensitively, including on macOS volumes. This is a
  guardrail, not a comprehensive secret classifier or OS sandbox.
- Approved terminal commands run with your workspace user's permissions and can
  access files/network outside the workspace. Path checks do **not** constrain
  shell commands. Review each command; never approve untrusted work blindly.
- Existing files must be read before editing. Reads use editor buffers, including
  unsaved changes. Contents and path resolution are rechecked after approval.
  New-file writes require an explicit not-found response from the editor as well
  as absence on disk. Transport, permission, and oversized-read failures never
  imply an empty file. If the editor returns only an ambiguous error for a missing
  file, create it in the editor first, then ask the agent to read and edit it.
  The client reads the file back before reporting success, since an editor may
  acknowledge a refused write without applying it. ACP has no atomic
  compare-and-swap write primitive: concurrent edits can still be overwritten
  during the editor's own approval/write interval. Use Git and avoid editing the
  same file while an agent edit is pending.
- Stop aborts local approval/work requests and sends turn-scoped cancellation.
  Already-dispatched mutations must settle before another local prompt starts.
  If their outcome is unknown, the bridge refuses further work until restarted
  after inspection. Killing a process cannot undo completed side effects.
- One active prompt per client process. The underlying channel host also queues
  turns serially across attachments. Maximum eight live attachments and 128 prompts
  per attachment; close and create a new attachment as needed.
- Polling is every 250 ms during a turn and one second while idle. Network errors,
  request timeouts, and HTTP 408/429/500/502/503/504 responses retry the same poll
  cursor with bounded backoff. Recovery ends 40 seconds after the last successful
  poll's send time, before the 45-second editor lease expires. Authentication,
  attachment/cursor conflicts, and malformed successful responses fail immediately.
  Only polls are retried: prompts, commands, writes, and tool results are never
  automatically replayed. Close/cancel are coordinated and idempotent; a failed
  cancellation closes the attachment instead of leaving an orphaned remote turn.
  A disconnected client loses its lease after 45 seconds. A 15-minute
  acceptance-to-completion watchdog prevents permanently busy turns, including failures outside the
  harness wrapper. Commands have an independent maximum 60-second timeout,
  starting before terminal creation is dispatched, after the bridge's approval.
  Creation delays count toward that deadline. Late-created terminals are cleaned
  up when their IDs arrive; without an ID the bridge cannot force-stop them and
  blocks further tools as an unknown outcome. Kill and release each have a
  separate three-second cleanup deadline. Kill acknowledgement is followed by
  a wait for the root process to exit within the same deadline; release is
  attempted even if either fails. This does not prove that detached descendants
  stopped, so do not use these tools for background jobs.
- Tool input schemas and bridge event schemas share validation. ACP strings
  (commands, paths, prompts, contents, and error/result text) have no bridge-only
  maximum length. File reads retain a 64 KB resource budget, terminal output a
  32 KB budget, and agent turns a 30-step budget; these are not wire validation
  limits. The underlying service host still enforces its own HTTP request-body
  budget (1 MB in `@adaptcom/core` 0.4.2). Terminal output combines stdout/stderr;
  stdin, interactive commands, and background-process management are unsupported.
- No token-by-token streaming, predictive Tab completion, MCP forwarding, images,
  automatic diagnostics subscription, saved-session list/load/resume/fork,
  history replay, or active-execution recovery. This is a restricted ACP adapter, not a full ACP implementation:
  even stdio MCP is intentionally unsupported. Patchbay always supplies its own
  MCP server, which is ignored with a stderr warning rather than falsely marked
  connected. Patchbay supplies context chips as ordinary text when the optional
  embedded-context capability is not advertised; file links are read explicitly.
  Attach text/file context explicitly.
- After disconnect/restart, inspect the workspace before creating a new session
  and provide any needed context again. The runtime still journals conversations
  on disk, but ACP cannot list, load, or replay them. The bridge's callbacks and
  leases are in memory; a new attachment never reconnects to an old conversation. Changed revisions require separate state
  under current veetwo service rules. Do not delete receipts casually: they retain
  your reusable ingress identity.

## Why the local client exists

The ACP SDK handles stdio framing, JSON-RPC dispatch/correlation, and protocol
schemas. `bridge.mts` maps the required ACP session ID to a live attachment in
the deployed example's HTTP polling API. `workspace.mts` delegates file and terminal operations through ACP,
with local approvals, stale-file checks, and bounded cancellation/cleanup.

These are transport and workspace policies, not a second agent loop. The SDK's
cooperative cancellation does not guarantee that an editor stopped a command or
write. Patchbay also has its own gates, but other ACP clients need not; the
example retains its independent permission request by default. Only the explicit
local `--approval-mode auto` option skips that request. `*.test.mts` files are regression fixtures, not client runtime code.

## Veetwo boundaries

**No core changes are required for this example.** It uses existing public
`defineAgent`, `AgentConnection`, `AgentChannel`, and `AgentHarness` interfaces,
with AI SDK function tools discovered from `agent/tools/`.

Like Slack and GitHub, ACP is bound in `adapt.runtime.ts` and selected through
`connections.get<AcpAccess>("acp")`. The registry shares one connection across
this installation's channel, harness, and tools; importing the agent no longer
creates a process-global broker.

```text
acp-code/
├── agent/
│   ├── agent.ts
│   ├── instructions.md
│   ├── harness.ts
│   ├── types.ts
│   ├── acp/
│   │   ├── broker.ts
│   │   ├── connection.ts
│   │   └── channel.ts
│   └── tools/
│       ├── read_file.ts
│       ├── write_file.ts
│       └── exec.ts
├── client/                  # Local ACP bridge, workspace executor, and build
│   └── types.ts             # Shared local-client types
├── tests/                   # Channel authentication and prompt dispatch
├── tsconfig.json
├── protocol.ts              # Shared client/server contract
├── adapt.runtime.ts
├── adapt.deploy.ts
└── settings.ts
```

Shared agent types such as `AcpAccess` live in `agent/types.ts`; client-only
shared types such as `ApprovalMode` live in `client/types.ts`. File-local types
stay with their implementation and are not exported. The wire schemas and their
types remain in `protocol.ts`. Workspace tools are defined in `agent/tools/`;
there is no separate `ToolEnvironment` adapter.

- `agent/acp/connection.ts` supplies operation-scoped live editor access and owns the
  live attachments. Each attachment ID also identifies its fresh runtime
  conversation. An internal `IdeBroker` in `agent/acp/broker.ts` handles callbacks,
  polling, deadlines, and cancellation, not saved sessions.
- `agent/acp/channel.ts` resolves and verifies the token per request, normalizes prompts,
  and routes live attachment operations without runtime-store access.
- `agent/harness.ts` binds execution to the editor turn and forwards committed messages.
  Its `withTools` support preserves that wrapper when discovered tools are injected.
- `agent/tools/read_file.ts`, `write_file.ts`, and `exec.ts` each export one
  tool factory. They resolve the shared ACP connection through the registry
  and send all workspace operations to the editor, never the deployment host.
- Opening an attachment uses the service host's lifetime signal (supplied as
  `request.signal` by veetwo's channel server). Harness/tool operation cancellation
  stops that work without detaching an otherwise healthy editor.

| Current veetwo limitation | Example workaround / shared-framework improvement |
| --- | --- |
| Channel host buffers complete responses and exposes exact routes, without a WebSocket upgrade hook | Authenticated JSON polling at `/acp`. Native SSE/WebSocket needs host support or a different custom host. |
| Existing chat API is not mounted by deployed channel services, and project factories do not receive the installed agent/store | A channel, harness wrapper, and discovered tools share a runtime-bound ACP connection instead of mounting `createAgentChatApi`. A reusable hosted-client surface would remove this glue. |
| No built-in client-tool RPC or approval round trip | Editor-backed function tools plus local ACP permission/file/terminal callbacks. Making arbitrary agents attachable needs a shared client-capability/tool-environment contract. |
| Existing harness exposes checkpointed messages, not token deltas | Display committed message chunks. Streaming in the existing harness needs a framework event/streaming extension; a separate custom harness is another option. |
| Serial dispatch, no channel dispatch-error callback, and no durable execution recovery | Immediate queued cancellation plus bounded watchdog and leases, without history loading or active-execution recovery. First-class dispatch lifecycle/error hooks would allow prompt failures to be reported immediately rather than waiting for the watchdog. |
| Harnesses differ in tool-injection support | This agent deliberately uses an injectable harness. A harness's internally owned file/terminal tools cannot be relocated merely by forwarding its chat. |

These are reasons to improve veetwo for a reusable product, not claims that every
feature is impossible in a larger custom example. Authentication, atomic edits,
and safe execution also require a capable editor client and host environment.

## Verify and operate

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm test
```

The regression suite checks shared validation, lease behavior, retry budgets,
request/detach diagnostics, cancellation races, and the downloadable client over
real loopback HTTP and ACP stdio. Editor terminals are mocked; tests do not run
workspace commands, launch the Patchbay UI, or provision a cloud deployment.
`tsconfig.json` checks the agent, deployment/runtime configuration, protocol,
client, and tests against the installed `@adaptcom/core` package.

Use `pnpm build` to regenerate `client/generated/bundle.js` before embedding it
in the service artifact. Calling `pnpm adapt build` or `pnpm adapt deploy`
directly does not invoke that script: run `pnpm build:client` first to avoid
embedding a stale client. No client compilation occurs on the deployment host.
The checked-in `client/generated/bundle.d.ts` declares the generated module's
export. For source development, `node client/main.mts ...` works from an
installed checkout.

```sh
pnpm adapt logs examples/acp-code --environment staging --follow
pnpm adapt stop examples/acp-code --environment staging
```

The bridge uses `X-ACP-Token` to work around the current Platinum/orc proxy
collision between guest `Authorization` and internal proxy credentials. For 401 errors, check that the local token file matches
the deployed worker's `ACP_TOKEN` environment variable;
redeploy after rotating it. For 404, check the public base URL and retained ingress
path, and ensure `/acp` was not appended twice. For "module not found," rerun
`pnpm install --frozen-lockfile`. For an expired session, create a new one instead
of replaying tools. If an edit/command outcome is unknown, inspect the workspace and
running processes before reconnecting.

### Disconnect diagnostics

Client JSON diagnostics go to **stderr**, never the ACP stdout stream. The server
also emits JSON diagnostics. They contain identifiers, statuses, timing, and
error/schema codes, not tokens, prompts, commands, file contents, or raw error
messages/data. Capture the first failure, not just the dispatch's final error:

- `acp.client.request_failed`: HTTP action, status, session/prompt/call ID,
  transport phase, error type/code, and remote error code when available.
- `acp.client.poll_retry`, `poll_recovered`, `poll_exhausted`: attempts and the
  last successful poll's age.
- `acp.client.failure`: initiating failure phase (`poll`, `editor_update`,
  `result_upload`, or `cancel`) and schema issue paths/codes when relevant.
- `acp.client.close`: cleanup reason and last-poll age.
- `acp.bridge.request`: server-side action, session/prompt/call ID, status, duration,
  and error code. Distinguishes a failing poll from a harmless cleanup request.
- `acp.attachment.detached`: `client_close`, `lease_expired`, or `host_aborted`,
  last-poll age (`null` if no poll succeeded), attachment age, cursor/sequence,
  active prompt ID, and pending callback count.

`pnpm build` rebuilds the checked-in downloadable client before building the
service. After deploying, **restart the Patchbay agent** to download that client;
a running client does not update itself. Regression tests cover the shipped
bundle as well as the source schemas, broker, and HTTP retry logic. They use
loopback HTTP and fake editor terminals, with no real commands or cloud deployment.

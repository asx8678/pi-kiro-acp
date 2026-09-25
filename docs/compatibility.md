# Kiro and Pi compatibility

## Supported contract, not a fabricated version claim

This build targets the v3 relay command:

```sh
kiro-cli acp --agent-engine v3 --auth-method cli
```

The adapter requires CLI help to advertise the engine/auth switches, ACP protocol
version 1, injected `customAgents`, activation via `session/set_mode`, and model
configuration exposed as session options. Model/effort changes use
`session/set_config_option`. No fallback to v2, guessed model IDs, extracted Kiro
bundles, hidden token commands, or unrelated HTTP inference APIs is provided.

The complete `--version` output is the exact compatibility key. The code ships
no qualified real version. `allowUnverified: true` is a development opt-in, not
an automatic certification. `approvedVersions` is for your own completed release
qualification. `orderedSteeringVersions` is a separate, stronger qualification;
never populate it merely because the method exists or returns `{queued:true}`.

## Pi contract

At runtime the package imports the host's `@earendil-works/pi-ai`, including
`createAssistantMessageEventStream`, `getCurrentSystemPrompt` and
`getCurrentTools`. It uses a native `registerProvider(provider)` registration.
It consumes the effective normalized transcript, not an early context-hook copy.

The checked source interface is recorded in `sources.md`. The static-import
`extension.mjs` entry point resolves these exports from the installed Pi host.
`bun run test:pi` also exercises the actual Pi CLI with an offline Kiro fixture;
Pi 0.87.1 passed this check. Earlier Pi releases lacking these exports cannot be
assumed compatible. See `testing.md` for the separate live check.

The bridge also exposes `completeStructured(model, normalizedContext, options)`
for callers that consume one declared tool as output data. This is a bridge
capability, not a standard Pi provider API or a constrained-decoding guarantee.
Fabric's reviewed v3 patch uses it for approvals, normalizes the classifier context,
and retains Fabric's validation of the decision and reason. It can retrieve the
capability from the registered native provider when Pi's model-settings wrapper
omits extra methods; an older bridge without the capability is refused.
The call uses an isolated session, honors cancellation and `timeoutMs`, and closes
before returning. It leaves Kiro's effort automatic instead of requesting the
generic classifier's potentially unsupported `minimal` effort. Ordinary tools
named `classify_result` still require an authoritative Pi result.

## Tool-surface verification

A `_kiro/tools/didChange` notification containing a complete `tools` array is
compared to the expected aliases. The adapter rejects extra tools immediately.

The official **Kiro CLI 2.24.0 v3 relay** uses a different observed format:
`_kiro/tools/didChange` reports a full `tags` snapshot, and `_kiro/mcp/status`
reports each connected server's tool catalog. For this exact CLI version, the
strict check accepts the combination only when:

- The tag snapshot belongs to the current session and arrives during or after
  activation of `kirocrew`; default-mode tags cannot qualify the bridge.
- Every tag is an exact `@kirocrew-core/<expected-alias>` with `source: "mcp"`.
  Built-in groups, other servers, unknown sources and unlisted aliases fail.
- The connected `kirocrew-core` server has `origin: "client"` and its enabled tool
  catalog matches the expected aliases. Readiness alone, missing provenance,
  disabled tools and incomplete catalogs cannot satisfy the check.
- Both reports remain consistent. Reconnection, removed tools or lost provenance
  after verification close the session instead of continuing on stale evidence.

An explicitly empty activation-era tag snapshot qualifies a tool-less session.
This format reports `toolAudit: "reported-tags-and-catalog"`; it is not labelled
as a native `tools` snapshot. Other CLI versions do not inherit this format's
support automatically. `compatibility.requireToolSnapshot` stays enabled.

The semantics of session-scoped tag snapshots and client-origin MCP catalogs are
also described by the upstream [KiroCrew ACP implementation](https://github.com/kirodotdev/KiroCrew/blob/main/docs/system-specs/modules/acp-client.md#kas-managed-mcp-readiness).
This validates the CLI-reported tool surface; it is not an operating-system
sandbox or full qualification of all inherited resources and workflows.

By default, missing supported inventory evidence blocks generation. Diagnostic model
*discovery* can report `toolAudit: "unreported"`; that is not a generation approval.
A supported deployment needs to establish what the chosen build can actually
report. If it cannot report the complete surface, retain the default fail-closed
behavior or explicitly approve relaxed experimentation in an isolated workspace.

To relax only this audit gate, edit your trusted config:

```json
{
  "compatibility": {
    "allowUnverified": true,
    "requireToolSnapshot": false
  }
}
```

These are override fields, not proof that native task tools are absent. The
profile still exposes only `@kirocrew-core`, but inherited/managed configuration and
server behavior have not been certified. A local empty directory alone is not
sufficient evidence of isolation.

## Qualification checklist

Run catalog discovery without inference. Then explicitly permit a bounded billed
smoke test. Record the actual model and effort responses; exercise Opus → Auto;
confirm no native tool runs; inspect the effective Kiro agent; test two workers;
hold a tool across the expected long test/approval duration; cancel while held;
change Fovea context while held; compact and branch in real Pi; kill a worker after
a known effect and verify no replay; and confirm no secrets are logged.

If a new benign client callback appears, add it only after checking its upstream
schema and recording a fixture. Unknown methods are not guessed. A callback
which performs a file/terminal action is intentionally denied: those effects
belong to Pi. Do not silence that failure by exposing native task tools.

## Unsupported or differently handled provider options

- Text input/output only; images fail before being silently omitted.
- Mandatory constrained decoding is rejected; MCP schemas do not imply decoder guarantees.
- `toolChoice: none` creates a tool-less, isolated auxiliary request.
- Temperature and per-request environment overrides are rejected.
- `maxTokens`, cache retention and arbitrary sampling controls are not mapped to a
  guaranteed Kiro service setting. Byte ceilings are enforced separately.
- `onPayload` can inspect/replace the context envelope but cannot re-route the
  transport or selected model. Invalid replacements are refused.
- Normalized provider events reach the observation callback. No HTTP status or
  headers are fabricated for ACP; `onResponse` has no stdio HTTP response to report.
- Usage observations remain explicitly unknown/observed rather than fabricated
  per-generation token/cost accounting.

## Credit reporting and protocol identity

Kiro CLI 2.24.0 v3 sends billing in `session/update` with
`sessionUpdate: "session_info_update"`, `_meta.kiro.kind: "turn_completion"`, and
`promptTurnSummaries` entries containing `unit: "credit"` and `usage`.
These are complete ACP-turn totals: repeated summaries replace the current
turn's amount rather than adding another charge. One ACP turn can span several
Pi tool handoffs. Older `_kiro.dev/metadata.meteringUsage` credit deltas are also
understood. If both formats arrive, the complete turn total is authoritative.
The [upstream KiroCrew ACP documentation](https://github.com/kirodotdev/KiroCrew/blob/main/docs/system-specs/modules/acp-client.md)
describes both formats; the v3 shape was also observed in the local live probe.

Only valid reported credit amounts update the footer and `/kiro usage`.
Missing billing data stays unknown. Totals cover received reports during the
current extension run, not the account balance, prior runs or other processes.
No token-to-credit or credit-to-USD conversion is inferred.

The default profile advertises the Crew identity from the latest stable release
checked on 2026-09-24: [v0.7.0](https://github.com/kirodotdev/KiroCrew/releases/tag/v0.7.0),
published that day at 14:17:46 UTC. The release tag and its
[publication manifest](https://github.com/kirodotdev/KiroCrew/releases/download/v0.7.0/stable-publication.json)
both resolve to commit `ba797801739c0a0a94663837feb3c1b761fc0855`.
The inspected values are:

| Protocol field | Declared value | Source |
|---|---|---|
| ACP `clientInfo.name` | `kirocrew` | [client.py](https://github.com/kirodotdev/KiroCrew/blob/ba797801739c0a0a94663837feb3c1b761fc0855/src/kiro_crew/acp/client.py#L267-L268) |
| ACP `clientInfo.version` | `0.1.2` | [client.py](https://github.com/kirodotdev/KiroCrew/blob/ba797801739c0a0a94663837feb3c1b761fc0855/src/kiro_crew/acp/client.py#L267-L268), [runtime.py](https://github.com/kirodotdev/KiroCrew/blob/ba797801739c0a0a94663837feb3c1b761fc0855/src/kiro_crew/acp/runtime.py#L962-L963) |
| Custom agent ID / mode | `kirocrew` | [default main agent](https://github.com/kirodotdev/KiroCrew/blob/ba797801739c0a0a94663837feb3c1b761fc0855/src/kiro_crew/agent.py#L384) |
| MCP descriptor and `serverInfo.name` | `kirocrew-core` | [core MCP server](https://github.com/kirodotdev/KiroCrew/blob/ba797801739c0a0a94663837feb3c1b761fc0855/src/kiro_crew/mcp_core.py#L2726-L2731) |
| MCP `serverInfo.version` | `1.0.0` | Same core MCP declaration |
| ACP v3 `protocolVersion` | integer `1` | [KAS harness](https://github.com/kirodotdev/KiroCrew/blob/ba797801739c0a0a94663837feb3c1b761fc0855/src/kiro_crew/acp/harness/kas.py#L58-L60) |

The stable release's product version is `0.7.0`, but BOTH ACP transports still
hardcode `CLIENT_VERSION = "0.1.2"` and send it in nested `clientInfo`. The adapter
matches this advertised version. Development main at
`e183a46e79c53109de3b24b0548e01a8dbef055c` instead reads its `0.8.0` package
version; that is the development identity, not the latest published stable one.
The [development declaration](https://github.com/kirodotdev/KiroCrew/blob/e183a46e79c53109de3b24b0548e01a8dbef055c/src/kiro_crew/acp/client.py#L274-L285)
explains the older literal and its telemetry impact. This profile pins a verified
release and does not fetch or change identity automatically at runtime.
The local package and CLI version remain independent. `pi-fabric` and `pi` are
available as explicit `client.name` overrides and use the adapter package version.
CLI `doctor` and `status` show the effective ACP `clientInfo`.

Discovery, auxiliary requests and workers use the same configured identity.
The MCP allowlist and inventory check both use `kirocrew-core`; all task tools
still come from the active Pi catalog. MCP protocol negotiation and advertised
capabilities describe the adapter's implemented HTTP transport. The connection
uses CLI-owned authentication and disables ACP filesystem/terminal callbacks.
It does not set an OAuth client ID, login User-Agent or Kiro `telemetryClientId`.

Crew's development source documents the ACP version's use in the host's
`acp_client_version` telemetry. Local handshake checks establish the declared
fields and compatibility; they do not establish AWS-side classification or
service authorization. Restart Pi to create connections using the new identity.

### Local installation ID

Crew separately generates a per-data-home UUID with Python's `uuid.uuid4().hex`.
Its [beacon module](https://github.com/kirodotdev/KiroCrew/blob/ba797801739c0a0a94663837feb3c1b761fc0855/src/kiro_crew/beacon.py#L328-L419)
accepts a 32-character lowercase hexadecimal ID, persists it owner-only, and uses
a temporary file plus `os.link` so concurrent creators reuse the winning file.
The adapter uses Node's cryptographic `randomUUID()` with hyphens removed and
the same atomic publication approach in its own private state directory.

`node scripts/install-pi.mjs`, package `postinstall`, CLI `init`/`setup`, and
first extension load initialize the file if missing. Existing IDs are retained.
The adapter refuses malformed state instead of silently replacing it or using
Crew's process-local fallback; setup must establish one durable identity.
The local ID is separate from all ACP/MCP implementation names and versions.
It is not transmitted to Kiro or Crew, and it does not change `telemetryClientId`.

## Platform

Node 22.16+ with `node:sqlite` is required. Linux was tested. The POSIX launcher
owns its subprocess group and terminates it on cancellation. Windows only has
root-process termination in this implementation and is not a qualified isolation
platform. Do not assume that Kiro v3 itself provides an OS sandbox on the relay path.

Pi itself must run under a compatible Node runtime. Bun-hosted Pi and alternative
runtimes were not tested and cannot be assumed to support the built-in SQLite API.

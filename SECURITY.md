# Security and privacy

## Trust boundary

This is trusted extension code running inside Pi with the user's operating-system
permissions. It is **not** a sandbox. A tool allowlist does not isolate a process,
and a native shell tool can still do anything its OS credentials permit.

The provider never connects directly to an LLM service. Its only model transport
is an official CLI process launched without a shell. The process receives the
normal CLI-owned Kiro authentication environment. Unrelated common inference
API-key variables are removed from that subprocess, but Kiro/AWS authentication
is not extracted or rewritten. This cannot enforce network policy for other
trusted extensions or arbitrary programs. Use environment-level controls when
Kiro-only inference is an administrative requirement.

## Tool execution

The internal MCP listener binds only to 127.0.0.1 with an ephemeral port and
256-bit random bearer token. Host and Origin are validated, browser CORS is not
opened, request bytes are bounded, and tool names come only from the current Pi
request. The handler never invokes the underlying Pi tool. It emits a Pi-native
call and waits for an authoritative matching Pi result. Unknown tools, conflicting
request IDs and ambiguous results fail closed.

A narrowly scoped Kiro MCP permission rule permits reaching this internal
handoff endpoint, not authorizing the actual project action. Pi's normal hooks
and policy remain in the execution path. Unexpected independent Kiro permission
requests are denied and treated as incompatibility, not auto-approved based on
a tool's title. Do not use this configuration to bypass enterprise restrictions.

Complete effective tool inventory is required by default. Opting out does not
prove native tools are disabled. No supported raw API exists here to remove
Kiro's internal system prompt or guarantee a single underlying model invocation.

## Data stored

The trusted configuration is owner-private. The state directory is mode 0700;
configuration and catalog files and the SQLite database are mode 0600 on POSIX.
The handoff journal stores IDs, model-independent binding hashes, argument/result
hashes, process ownership, phase and timestamps, not raw tool arguments or bodies.
The accounting tables and `usage.jsonl` retain IDs, timestamps, outcomes and usage
totals. By default, task/response excerpts and supplied session names are **not**
persisted; reports use generic task labels and ID-derived session names.

Setting `reporting.retainTaskExcerpts: true` explicitly opts into storing bounded
user-task excerpts, final-response excerpts and supplied session names in both
SQLite and task reports. Basic credential redaction is defense in depth, not a
secret detector: arbitrary API keys, personal information and source text can
remain in opted-in excerpts. Keep this disabled for sensitive work.

Changing the setting does not scrub existing databases, logs, backups or reports
written by older/running versions. Stop or restart all bridge/worker processes
when changing retention policy, then review historical copies separately. Do not
delete unresolved handoff/recovery state just to remove old accounting excerpts.

Raw Kiro stderr is drained but not retained because it may contain secrets.
Provider-event observers receive normalized content and accounting observations;
other Pi extensions can inspect those, as they can inspect ordinary model data.
The local status/usage commands should still be treated as private diagnostics.

The ACP client name `kirocrew`, its advertised version, the agent name and the
MCP server name/version are public software identifiers shared by installations.
They do not contain a personal account or installation ID. This adapter does
not copy Crew's private `beacon_install_id` or set Kiro's `telemetryClientId`.
Crew generates its own random installation ID locally when needed; see its
[installation-ID implementation](https://github.com/kirodotdev/KiroCrew/blob/ba797801739c0a0a94663837feb3c1b761fc0855/src/kiro_crew/beacon.py#L368-L419).
Keep local configuration and state in the Pi user profile, outside this checkout.
The repository also ignores local profiles, `.env` files, `kiro-acp.json` and
its backups, Crew beacon state files, and the adapter's generated installation
ID and temporary files to prevent accidental inclusion.

The adapter generates its own random UUIDv4 in Crew's 32-character lowercase
hex format, saved as `kiro-acp-installation-id` inside `stateDir`. The state
directory is mode 0700 and this file is mode 0600 on POSIX. Setup writes a private
temporary file and atomically links it into place, so concurrent first installs
adopt one persisted ID. Reinstalls and upgrades preserve a valid existing ID.
Malformed files fail setup without silently rotating the identity; restore the
file or explicitly remove it before setup if a new identity is desired.
No process-local fallback is described as a persisted installation ID.

The ID is not included in ACP messages, MCP metadata, configuration templates,
setup/status output or telemetry requests. The adapter does not send Crew
heartbeat requests. A fresh installation should copy configuration only; copying
the private ID file to a second state directory also copies its identity.

Kiro itself may retain sessions, send context to its service, apply managed
resources, and maintain its own logs according to its configuration. This package
cannot make that state disappear and does not delete user Kiro session records.

## Recovery and cancellation

Cancellation prevents continuation and terminates the owned POSIX process group.
It cannot roll back effects already performed by Pi. A lost acknowledgment never
justifies repeating an uncertain mutation. Inspect actual files and Pi's recorded
results before using `reconcile --acknowledge-reviewed`.

The journal is not a distributed exactly-once transaction. In particular, an OS
process can die between a file write and durable transcript recording. That case
is deliberately uncertain and requires reconciliation.

## Reporting issues

This source archive has no hosted issue tracker. Keep reports local to the team
maintaining your copy. Include the redacted CLI version, configuration keys,
phase and a minimized fixture; do not attach auth databases, bearer tokens,
customer source files or complete conversation logs by default.

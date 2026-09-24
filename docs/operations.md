# Configuration and operations

## Configuration precedence

Use `PI_KIRO_ACP_CONFIG` for an explicit absolute user-controlled configuration
file. Otherwise the default is `kiro-acp.json` inside `PI_CODING_AGENT_DIR`, or
`~/.pi/agent`. The extension does not load executable project configuration to
select a model transport. Preserve the same trusted profile in child processes.

Run `init --experimental` to produce a complete validated file. Defaults are
implemented in `src/config.ts`; unknown keys are errors. The JSON schema is
versioned with `version: 1` and provider ID `kiro-acp`.

| Setting | Meaning |
|---|---|
| `cli.binary` | Official Kiro executable (trusted path or PATH name) |
| `cli.prefixArgs` | Trusted launcher prefix; empty normally, fixture in tests |
| `cli.rpcTimeoutMs` | Control/initialization timeout |
| `cli.promptTimeoutMs` | Wall-clock bound on the entire ACP prompt including tool waits |
| `cli.cancelGraceMs` | Process termination grace, including bounded best-effort cancel delivery |
| `compatibility.allowUnverified` | Explicit experimental version opt-in |
| `compatibility.approvedVersions` | Full CLI version strings qualified by the operator |
| `compatibility.orderedSteeringVersions` | Separately qualified context-ordering contract |
| `compatibility.requireToolSnapshot` | Require complete effective callable inventory |
| `models.plannerId` | Validated preference; select the same actual entry in Pi |
| `models.workerId` | Intended worker selection, normally exact `auto` |
| `models.contextWindow` | Fallback token window when Kiro reports no size; default 64,000 |
| `models.maxTokens` | User model metadata ceiling; not a Kiro-enforced output cap |
| `sessions.idleTtlMs` | Idle, non-pending session eviction |
| `sessions.maxResident` | Resident binding limit in one runtime |
| `sessions.forceRebuild` | Debug/replay baseline instead of reuse |
| `limits.maxPromptBytes` | Actual serialized effective-context byte ceiling |
| `limits.maxFrameBytes` | Incoming/outgoing RPC and MCP frame bound |
| `limits.maxOutputBytes` | Visible model text/thinking byte ceiling |
| `limits.maxToolResultBytes` | Actual Pi result byte ceiling |
| `limits.maxQueuedEvents` | Local CLI/test stream bound; Pi owns its actual stream |
| `limits.maxHandoffMs` | Maximum held internal MCP wait |
| `admission.scope` | Explicit local account/policy coordination label |
| `admission.maxActive` | Shared local active-continuation capacity |
| `admission.maxQueued` | Shared queued continuation ceiling |
| `admission.waitMs` | Maximum wait to obtain a continuation slot |
| `policy.kiroOnly` | Guard current Pi paths against another provider |
| `budget.dailyCredits` | Optional reported-credit cutoff; **0 disables it** in this profile |
| `budget.warningCredits` | Warning threshold in reported credits per local day; installed value 50 |
| `budget.warningFraction` | Warning fraction used only when warningCredits is 0 and a cutoff is enabled |
| `reporting.timeZone` | IANA time zone for calendar days, months and dashboard times; defaults to the system zone, installed Europe/Paris |
| `reporting.accountCacheMs` | Minimum interval between automatic account-usage reads; default 300,000 ms; explicit refresh bypasses it |
| `efficiency.enabled` | Apply the reviewed Fabric routing/worker/output efficiency profile |
| `efficiency.contextTokens` | Target used by configure:efficiency to build per-model Pi compaction settings |
| `stateDir` | Private catalog/journal/workspace directory |

Model discovery uses positive integer context sizes from model metadata first,
then explicit token sizes in model descriptions (for example `1M context window`
or `200K token context window`). K/M mean 1,000/1,000,000 tokens, not bytes.
Ambiguous descriptions keep the configured fallback. Both ACP model config
options (including groups) and legacy `availableModels` entries are supported.
Discovery runs with the existing once-per-startup catalog load; `/kiro models`
and `/kiro doctor` explicitly refresh it. Cache files retain the reported size,
description and source. Fallbacks are resolved from the current configuration,
not saved as vendor limits.

Model diagnostics label `contextWindowSource` as `metadata`, `description`, or
`configured-fallback`. Auto and other models without an advertised window retain
the fallback even when other catalog entries advertise 1M. The separate
`limits.maxPromptBytes` ceiling still applies to serialized context; increasing
the displayed model window does not increase transport or prompt byte limits.

`promptTimeoutMs` must be at least `maxHandoffMs`. For long tools set a sufficiently
larger whole-prompt budget; a tool consuming the entire prompt budget still
leaves no time for inference. These local settings do not prove Kiro's own MCP
client tolerates the same duration. Test long waits on your actual build.

## State layout

```text
<stateDir>/
  catalog.json       Live catalog cache and source CLI version
  state.sqlite       Recovery/admission/owner metadata, credit ledger and account cache
  state.sqlite-wal   SQLite WAL while active
  state.sqlite-shm   SQLite shared-memory coordination while active
  usage.jsonl        Private task reports, credit totals and cumulative session totals
  discovery/         Dedicated control-session working directory
  usage/             Dedicated account-inspection working directory when no session is available
  workspaces/.../    Dedicated upstream session working directories
```

Pi continues to own actual project cwd and tool execution. The upstream working
directory is not a grant to use native Kiro filesystem tools. Empty directories
may remain after a run; they contain no bridge-written prompt copies. Kiro may
create its own local/session files according to its configuration.

The journal prunes completed/cancelled handoffs older than seven days when a new
runtime starts. Uncertain effects are retained. Do not delete state to make an
uncertainty warning disappear. After all owners are closed and uncertain records
are resolved, an operator can archive or remove the dedicated state directory.
Kiro's separate session records are not deleted by this package.

## Recovery playbook

When a tool was exposed and the transport dies, inspect the Pi transcript and
actual files/tests. Do not retry a mutation based solely on a missing upstream
acknowledgment. A matching real Pi result supplied on continuation can reconcile
the journal without running the tool again.

For manual reconciliation after review:

```sh
# Close the owning Pi instance first.
node dist/src/cli.js journal
node dist/src/cli.js reconcile HANDOFF_ID --acknowledge-reviewed
```

This changes bookkeeping only; it does not undo or repeat a command. Then state
what actually happened in the next Pi task. A live owner blocks manual clearing.

`/kiro reset` requires an idle provider and refuses unresolved durable effects,
even if cancellation already removed their in-memory binding. It keeps recovery
identity stable across resets and restarts. `/kiro cancel` closes active bindings,
but cancellation is not rollback. On a transport error, the package does not
select another model/provider or silently restart a mutation.

**Upgrading older state:** close old Pi instances before restarting with this
build. Earlier reset epochs were hashed and cannot be mapped back to their
conversations. Unresolved legacy records without a stable-key marker therefore
block new dispatch, even if the current conversation has a different key. Supply
exactly one matching real Pi result, or use the review-and-reconcile procedure
above after closing its owner. Do not delete the database or mark uncertain
effects as completed merely to clear this guard. The added marker table preserves
old writers' handoff-table layout; completed history is retained.

## Troubleshooting

**No models in Pi:** run the CLI `models` command under the same config/profile,
then `/kiro models` or reload Pi. Check native provider helper compatibility.

**Unqualified version:** this is intentional. Decide whether to opt into an
isolated experiment; do not mark a version approved without running the gates.

**Full inventory missing:** read `compatibility.md`. MCP tags/readiness do not
answer the full surface question. Relaxing the gate reduces assurance.

**Unexpected native tool/permission:** stop. Check effective agent and enterprise
configuration. Do not solve it with unrestricted permissions or a native shell.

**Unsupported effort:** select a level actually returned for that model. No label
is advertised merely because another model supports it.

**Worker cannot see `kiro-acp/auto`:** install the provider in the trusted profile
loaded by the worker and inherit its config environment. Keep `runner: pi` and
`extensions: true`. Confirm Auto is a real current catalog selection.

**Context rebuilds frequently:** inspect Fovea system-section/context changes.
This is a conservative correctness path. Do not enable ordered steering until
its live ordering contract is verified for the exact CLI build.

**Pi shows $0:** numeric token/USD compatibility placeholders. The footer and
`/usage` show Kiro-reported credits separately, including shared persistent
totals across local workers. Task reports are appended to `usage.jsonl`.
`awaiting credit report` means no charge report has arrived; it is not a zero
charge. `/usage` also displays the account's plan usage and remaining allowance
as returned by the official CLI. Press `r` or run `/usage refresh` for a fresh
account read. A failed refresh preserves the last account snapshot with its
timestamp/error, and never invents a balance. Pi cost fields cannot enforce a
hard Kiro-credit budget.

See [the efficiency profile and accounting format](efficiency.md) for the
warning-only 50-credit threshold, task log revisions, coverage, context settings,
and the version-checked Fabric routing patch.

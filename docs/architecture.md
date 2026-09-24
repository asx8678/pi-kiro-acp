# Architecture of the implemented extension

This describes the implemented extension. See [compatibility](compatibility.md)
for supported behavior and limitations, and [testing](testing.md) for verification
results and remaining qualification work.

## Ownership and call graph

```text
Pi agent / Fabric / Fovea
  │ normalized model request
  ▼
Native Pi provider (src/index.ts)
  ▼
ProviderRuntime
  ├─ Catalog cache and live discovery
  ├─ Snapshot/fingerprint of effective Pi context
  ├─ Auxiliary requests isolated from Main
  └─ Binding per Pi conversation
       ├─ State machine
       ├─ V3Session → RpcProcess → official Kiro CLI
       ├─ ToolServer → exact current Pi catalog
       ├─ StreamWriter → host Pi event stream
       ├─ Journal → durable metadata only
       └─ Admission → shared local continuation slots
```

There is no registered `kiro` Fabric runner. There is no direct call from the MCP
handler to a Pi tool implementation. The native Pi loop remains responsible for
validation, hooks, rendering, execution and result persistence.

## Core lifecycle

A generation snapshots the effective transcript after Pi has assembled system
sections and tools. Its binding key contains scope, Pi session identity, local
branch-reset epoch, working directory and purpose. Auxiliary requests receive
unique bindings and are closed after completion. Concurrent generation into the
same active binding is refused rather than mixing context.

A new Binding starts its internal loopback server, inspects the official CLI,
negotiates v3, injects a minimal custom agent and activates it. It discovers model
options, selects the exact requested model/effort, waits for the bridge catalog
to be loaded, and verifies the effective tool inventory when required. No model
prompt is sent until these steps pass.

The Pi stream and ACP prompt have different lifetimes. One ACP prompt may yield
several Pi streams at tool boundaries. A Pi `done(toolUse)` does not imply that
the ACP prompt is over.

## Handoff sequence

1. The authenticated MCP call names a tool from the immutable current catalog.
2. The journal records its request identity, Pi call ID and argument hash.
3. The coordinator reserves the handoff before yielding, so duplicate IDs share
   the same response and different concurrent calls cannot both dispatch.
4. Prior text events drain before the tool event. The record becomes EXPOSED_TO_PI.
5. The active-continuation lease is released. A normal Pi tool call ends the stream.
6. Pi executes and supplies its real `toolResult` in the next provider request.
7. The coordinator matches the exact ID/name, bounds output, records its hash,
   and checks the new context before releasing any result to Kiro.
8. After synchronization, it reacquires admission and resolves the held request.
9. Kiro continues; the next Pi stream receives the new text or another tool call.

Numeric and string JSON-RPC IDs remain distinct. Reusing an ID with changed
arguments fails. A completed recent handoff can return its already recorded
result, but never dispatch the effect again.

## Context synchronization

System instructions and tool declarations are extracted using current Pi helpers.
The projection fingerprints content rather than message counts or timestamps.
It preserves user/assistant/tool-result roles in deterministic replay text and
rejects unsupported image blocks. Reasoning content is not silently conflated
with an ordinary user instruction.

A compatible append continues the persistent session. A changed system prompt,
changed tool schema, rewritten prefix, model/effort change, observed compaction,
or unqualified new steering at a held boundary triggers rebuilding from Pi's
current context. An actual result is accepted before teardown so a completed
project effect is not repeated.

The ordered-steering path exists only for exact versions qualified by the
operator. A queue acknowledgment alone is not considered universal evidence of
ordering. The default list is empty, so unknown ordering uses cancellation and
reconstruction rather than stale continuation.

Replay is a textual compatibility projection. It is not claimed to reproduce a
raw inference API's system-role semantics or eliminate Kiro's own internal state.

## State and recovery

The state machine allows STARTING → READY → GENERATING → WAITING_FOR_PI_TOOL →
SYNCHRONIZING → GENERATING, plus cancellation/closed/recovery states. Invalid
transitions fail rather than mutating a loosely interpreted boolean collection.

SQLite WAL with full synchronous commits stores handoff metadata and owner
instances. A closed instance is distinct from a live instance even when Pi reloads
an extension in the same OS PID. The journal contains no prompt/argument/result
bodies. Historical Kiro sockets or HTTP callbacks are never restored after death.

A known Pi result can reconcile an old handoff. A possible effect with no
trustworthy result becomes UNCERTAIN. The operator must inspect real state before
manual reconciliation. This is conservative at-most-one known dispatch, not a
universal exactly-once transaction across arbitrary external systems.

## Admission and resource cleanup

The local account scope shares SQLite admission leases across Pi processes.
Active inference and resident sessions are counted differently: a parent blocked
on a Pi tool releases its active slot so the child can run. It must reacquire
before the result is released. Dead/closed owners can be reclaimed; a merely old
timestamp is not proof that a living process stopped.

Resident session limits are per runtime in this release. Idle non-pending sessions
are swept; a pending effect is never discarded as ordinary idle cache.

Shutdown closes the lifetime cancellation signal first, then drains bindings and
startup operations before closing the journal. HTTP-listener startup and close
are serialized. The package includes regression tests for startup-close races,
async payload cancellation and discovery cancellation.

## Module map

| File | Responsibility |
|---|---|
| `src/index.ts` | Native Pi registration, host helpers and lifecycle commands |
| `src/provider/runtime.ts` | Generation ownership, isolation and binding reuse |
| `src/provider/stream.ts` | Balanced Pi events and unknown accounting placeholders |
| `src/provider/models.ts` | Live/catalog-to-Pi model projection |
| `src/kiro/jsonrpc.ts` | Strict framing, requests, subprocess and CLI inspection |
| `src/kiro/v3.ts` | v3 agent, mode/config, inventory and event normalization |
| `src/context/snapshot.ts` | Effective context, fingerprints and replay |
| `src/tools/catalog.ts` | Exact schemas and aliases |
| `src/tools/mcp-server.ts` | Authenticated held-request transport |
| `src/sessions/coordinator.ts` | Tool handoff and continuation state |
| `src/storage/journal.ts` | Transactional metadata and recovery |
| `src/admission/leases.ts` | Shared local generation admission |
| `src/diagnostics/metrics.ts` | Bounded accounting observations and counters |
| `src/config.ts` | Trusted user configuration and private file writes |
| `src/cli.ts` | Setup, discovery, demo and billed probe |

## Production release gates

The remaining gate is real-runtime qualification, not more claims based on mocks.
See `compatibility.md` and `testing.md`. Do not enable actors, durable residents,
recursive execution or prewalk merely because a basic worker prototype functions.

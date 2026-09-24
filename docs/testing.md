# Tests and qualification

## Reproduce the shipped tests

The archive contains compiled tests, so the offline suite needs only Node:

```sh
bun run test
node dist/src/cli.js demo
```

To test changed source rather than the shipped build:

```sh
bun install --ignore-scripts --omit=peer
bun run typecheck
bun run build
bun run test
```

The fixture implements the expected ACP dialect and uses a **real** subprocess
and **real** authenticated loopback MCP calls. It performs no inference or
remote HTTP calls. Test models named `test-opus` and `auto` are fixture labels,
not evidence that any real model is available or that model quality was tested.

The suite covers canonical/context fingerprints, hidden schemas, constrained
output refusal, strict UTF-8/NDJSON, exact model switches, stream event balance,
HTTP authentication/Origin/Host, held-call timeout, deduplication, SQLite recovery,
shared admission, parent/child deadlock avoidance, same-PID reload, Fovea-style
changes, auxiliary isolation, real host marker writes, unknown native callbacks,
and startup/shutdown races.

A host-side marker write in a test verifies execution ownership in the supplied
harness. It is not a real Pi `fabric_exec` implementation. Native-provider tests
use a structural Pi API mock, not an installed upstream runtime.

The installed Pi CLI can additionally be checked without real inference:

```sh
bun run test:pi
```

This creates a temporary Pi profile, loads the package's actual entry point, and
uses the offline fixture's Kiro 2.24-style tag/catalog reports. Pi executes one
inert `bridge_probe` tool and the provider returns `PI_ACTUAL_HOST_OK`. It requires
subprocesses and a loopback listener. The temporary profile is removed afterward.

To exercise the installed Pi host with the real Kiro CLI and a discovered model,
explicitly opt in to inference using your existing Kiro configuration:

```sh
bun run test:pi --live auto --allow-billed
```

This uses the same inert tool and temporary Pi profile, requires strict tool
verification, and checks that Pi executes exactly one call and receives its real
result. It can incur Kiro usage/cost. It does not test Fabric or Fovea workflows.

Tool-surface tests cover native/foreign tags, missing provenance, incomplete or
disabled catalogs, reconnects, removal after verification, unsupported versions,
default-mode reports and cross-session reports. The complete-inventory guard is
enabled in these tests.

Catalog refresh tests verify that startup and repeated picker requests share a
single discovery, picker cancellation does not cancel the shared load, rejected
publications reuse the loaded result, and explicit commands can refresh or retry.

### Local verification, 2026-09-24

Verified with Pi 0.87.1, Kiro CLI 2.24.0, Node 24.20.0 and Bun 1.4.2:

- Typecheck and build passed; all 95 automated tests passed.
- The installed Pi host passed the offline Kiro fixture check.
- The standalone live Auto smoke test completed one host tool round trip.
- An earlier live Auto probe passed using the former Kiro Crew ACP/MCP identities and
  captured `0.03691427512437811` reported credits from a v3 `turn_completion`
  event. Credit usage varies per request; this value records that probe only.
- `bun run test:pi --live auto --allow-billed` passed with the real Pi host and
  real Kiro CLI. Pi executed one inert tool and received `PI_ACTUAL_HOST_OK`.

`compatibility.requireToolSnapshot` remained enabled. These checks verify basic
inference and host execution; they do not qualify all Fabric/Fovea workflows.

The identity profile matches stable Crew v0.7.0's advertised `kirocrew` / `0.1.2`,
agent `kirocrew`, and MCP endpoint `kirocrew-core` / `1.0.0`. Offline transport
checks capture serialized initialization for the default and both Pi name
overrides, verify v3/CLI-auth launch flags and disabled callbacks, and verify
that changing the local package version preserves the pinned Crew versions.
MCP and tool-surface checks use `kirocrew-core`, including the exact protocol
response and a host tool handoff. Earlier billed probes above predate this profile.

The stable-release update passed the TypeScript build and all 97 automated tests.
A no-prompt `doctor` check against Kiro CLI 2.24.0 reported
`clientInfo: { name: "kirocrew", version: "0.1.2" }`, returned the model catalog,
and reported `toolAudit: "reported-tags-and-catalog"`. This used an isolated
adapter state directory and the user's effective client configuration.
The source of the values is stable Crew **v0.7.0**, published 2026-09-24:
both upstream ACP transports still hardcode `0.1.2`, independently of the
product's `0.7.0` version. Development main's `0.8.0` identity is a separate build.

The earlier development Crew identity profile passed the TypeScript build, all 97 automated
tests, and the installed Pi host check with the offline fixture. A separate live
check against Kiro CLI 2.24.0 accepted ACP `kirocrew` / `0.8.0`, activated agent
`kirocrew`, and verified an HTTP MCP server named `kirocrew-core` advertising
version `1.0.0`. The expected inert tool appeared in the connected client-origin
catalog and activation-era tags (`toolAudit: "reported-tags-and-catalog"`).
The check used isolated adapter state, prohibited `session/prompt`, and recorded
zero tool executions. This verifies the declared fields and ACP/MCP compatibility,
not AWS telemetry delivery or internal client classification.

## Build verification

The installation-ID change passed the build, all 105 automated tests, and the
installed Pi host check with the offline fixture. Coverage includes Crew's UUIDv4
hex format, distinct state directories, persistence across setup/reinstall,
eight concurrent first creators, POSIX permissions, malformed/symlinked state,
profile overrides, and initialization when Pi loads an extension whose install
scripts were skipped. A packaging regression places dummy private state under
included source directories and verifies that npm excludes it.

The new installer also initialized the local installed profile. Its ID has mode
0600 in a mode-0700 directory; its value was withheld from output and confirmed
absent from repository files, configuration and npm package contents. The Pi
package list and unrelated settings were preserved. These installation checks
make no model calls and do not add or verify outbound telemetry.

Use the commands above to reproduce the build and test suite. Tested versions,
results and verification scope are recorded on this page. Node's SQLite
experimental warnings are expected on the tested Node version. The source build has no runtime package
requirements other than Node core and the actual Pi host package when installed.

## Required live qualification

1. Check real CLI flags/version, initialization, agent activation, model/effort
   options and all reverse callbacks. Record redacted fixtures and identify
   changes as protocol adaptations, not generic exception suppression.
2. Run `live-smoke ID --allow-billed`. It sends paid inference and calls one inert
   host tool. Verify account entitlement, exact model selection and no fallback.
3. Use actual Pi with Fabric and Fovea in a disposable project. Test read/edit/test
   and a Fovea update at a suspended tool boundary. Verify normal Pi hooks/UI.
4. Cancel during startup, text generation, tool execution and human approval.
   Confirm the owned Kiro process is gone and no orphan request can continue.
5. Hold the MCP call for the maximum real workload/approval duration. Local HTTP
   server settings alone do not validate Kiro's client timeout behavior.
6. Run Main plus two workers, including capacity one and a parent awaiting child
   completion. Check model/context separation and process resource use.
7. Kill the transport after a known effect. Require the actual Pi result or an
   uncertainty record, never an automatic repeat.
8. Test compaction, resume, model switching and tree navigation. Qualify advanced
   actors, durable residency, recursion and prewalk separately before enabling.
9. Audit administrative resources, credential handling, local data retention and
   actual Kiro account billing. No mock can verify these.

Do not equate a passing offline suite or a passing inert smoke test with these
production gates.

# Recommended blocker fixes — results

**Code fixes and bounded live checks completed. Normal-profile activation is now
configured and startup-verified; restart Pi for supervised experimental use.**
See [the activation record](activation-2026-09-25.md). This is not full production
qualification.

## Acceptance ledger

- [x] Fabric **0.96.3**: reviewed worker start/relaunch, worker entry, approval
  inference, Jev and merged-configuration paths enforce Kiro-only routing.
  Native approval context normalization preserves instructions and tool schemas.
- [x] Version/SHA-256-locked, idempotent patching. Unknown or modified source is
  refused before edits. Readiness checks exact paths, package identity/version
  and the policy artifact hash. Original sources are retained.
- [x] Efficiency configuration pins **0.96.3**, not 0.94.0, and preflights the
  Fovea patch when that package is installed.
- [x] Fovea **0.31.1**: explicit operations observe same-run opaque edits in
  non-Git folders, even with turn sync disabled. New force/hint requests cannot
  be swallowed by older in-flight refreshes; supplied snapshots remain exact.
- [x] Typecheck/build and **219 offline tests** pass. `npm run test:compat`
  reproduces the original stale result, then verifies the fix against real
  packages, including installed Pi → fake ACP → real Fabric/Fovea with both
  custom and native edits in one invocation. Foreign routes resolve zero
  credentials and make zero network calls. Native approval uses an inert
  provider in this probe, not billed classification.
- [x] Five-minute live approval: **300.160 seconds**, one ACP prompt, one effect,
  correct continuation and no surviving recorded processes.
- [x] Actual Main + two **plain-text leaf workers**, Auto and Haiku 4.5: capacity
  one serialized them (peak active 1, queued 1); capacity three allowed overlap
  (peak active 2). Main waited without holding admission. Both workers returned
  their separate markers with exact model evidence; each case used three prompts.
- [x] Kill the real test Kiro transport after one known effect: journal recorded
  `UNCERTAIN`; explicit host abort ended the held tool. Saved-session resume
  reconciled the saved Pi result without repeating the effect. Two prompts total.
- [x] Final no-inference audit: zero surviving recorded processes/process groups,
  zero leases, reservations and open journal owners. Uncertainty records retained.

## Qualification caveats and harness corrections

The current installation is Fabric 0.96.3, newer than the initial 0.96.1 report.
Its actual dispatch sources were reviewed; unsupported versions still fail closed.

The first worker case initially failed a **meter-label assertion**, not execution:
ACP retained Auto as its default, so the forwarding shim labelled those requests
`unselected`. Retained worker status and Pi assistant events independently confirmed
`kiro-acp/auto` and `kiro-acp/claude-haiku-4.5`. The failed report was archived and
validated without repeating inference or relabelling raw metering records.
That disposable copy also lacked Fabric's skill tree. The capacity-one case only
qualifies the observed plain-text worker/admission path, not child Fabric tools.
Package copying was corrected; capacity three had complete resources and no worker
stderr. Child tool execution and independent worker interruption remain unqualified.

Fovea's repaired mutation path passed actual Pi/Fabric execution with **fake ACP**;
it was not rerun with billed Kiro after the cap was exhausted. RPC approval responses
were automated, not supervised terminal interaction. Supervised TUI, near-limit
automatic compaction, billed auto-approval, durable actors, recursion and prewalk
remain separate qualification gates. Offline evidence does not qualify them.

## Accounting and configuration

The original counter was never reset: **24/24 approved prompt attempts** were used,
including the earlier interrupted cases. A stop latch prohibits further prompts.
The ledger reports **0.6872834434 credits**, with **six prompts unreported**; this
is not an exact charge. No pre-run account snapshot exists for an attributable
delta. The final account control query succeeded without inference.

At the end of qualification, all patches used disposable copies and normal
packages/settings were unchanged. Following the user's explicit activation
approval, the normal profile was backed up, configured and verified with **zero
additional model requests**. See [the activation record](activation-2026-09-25.md)
for exact settings, backup location, startup evidence and remaining limitations.

For deliberate activation, use the build/patch/profile workflow in
[efficiency.md](efficiency.md#applying-or-updating-the-profile), ensure the provider
is registered in Pi and explicitly choose the CLI compatibility policy, then
restart Pi and existing workers. Unknown upstream versions must be reviewed first.
The configuration command resets model/budget preferences and makes backups;
it is not run automatically by these tests.

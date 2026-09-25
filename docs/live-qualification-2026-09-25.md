# Live qualification — 2026-09-25

**Initial-run verdict: partially verified, not production-qualified.** Further live prompts
were stopped after a same-run Fovea freshness check failed. No production profile
or installed package was modified to bypass a guard.

## Follow-up status

The compatibility fixes and remaining bounded checks were subsequently completed.
See [the blocker-fix acceptance ledger](blocker-fixes.md) for current results,
qualification boundaries, harness corrections and activation steps. The original
run below is preserved as historical evidence. The shared cap ended at **24/24**;
reported usage is **0.6872834434 credits with six prompts unreported**. Normal
packages/settings remain unchanged.

## Environment and controls

- macOS; Node 24.21.0; Pi 0.87.1; Kiro CLI 2.24.0.
- Actual Auto inference, plus an explicit switch to advertised `claude-haiku-4.5`.
- Fovea 0.31.1. Installed Fabric 0.96.1 was inspected but not enabled for inference.
- Disposable project and private Pi profiles/state. Experimental-version opt-in
  applied only to the qualification configuration; strict tool inventory remained on.
- Shared SQLite counter in a CLI forwarding shim, capped at 24 ACP prompt attempts
  across processes, including compaction. Automatic retries/cache warming disabled.
  An offline six-process race proved that only two requests passed a two-request cap.
- Maximum planned approval wait: five minutes. Held-call limit 330 seconds;
  whole-prompt deadline 420 seconds. A shared stop latch prevents further prompts.
- Real Pi RPC clients consumed events continuously and exercised the actual
  extension dialog protocol. Responses were automated, **not a supervised TUI pass**.

## Results (initial run)

| Check | Outcome | Evidence / boundary |
|---|---|---|
| Live baseline | Pass | Auto executed one harmless host tool; actual marker returned; one ACP prompt |
| Startup cancellation | Pass | No prompt forwarded; abort returned in 4 ms |
| Streamed-text cancellation | Pass | Abort completed in about 2.00 s; no stale output after completion |
| Running-host-tool cancellation | Pass | About 2.01 s; no marker written; held effect retained as uncertain |
| Approval-dialog cancellation | Pass | About 2.01 s; no marker written; subsequent request succeeded without replay |
| 30-second approval | Pass | Held for 30.113 s; one prompt, one effect, correct continuation |
| Two-minute approval | Pass | Held for 120.194 s; one prompt, one effect, correct continuation |
| Five-minute approval | Inconclusive | Interrupted by the shared safety stop; do not claim five-minute support |
| Manual compaction | Pass | Actual summarization of synthetic history; persisted compaction entry and preserved marker |
| Explicit model switch | Pass | Switched Auto to Haiku 4.5 and retained the prior result without a tool call |
| Fork history isolation | Pass | Fork excluded the abandoned result and performed no tool effect |
| Saved-session resume | Pass | Restored prior result without replaying the tool |
| Fovea same-run custom-tool edit | Failed check | Second focus returned the old declaration after the host changed the file |
| Fabric Main + two workers, capacities 1 and 3 | Blocked | Installed dispatch guard not ready; version mismatch requires fresh review |
| Kill transport after a known effect | Not run | Stopped before this stage |
| Supervised TUI approval, interactive tree navigation, near-limit automatic compaction | Not run | RPC/manual-compaction checks do not qualify these variants |

An initial compaction attempt was rejected locally because the short baseline
session was below `keepRecentTokens: 128`; **no compaction prompt was sent**.
This precautionarily interrupted the first two-minute wait. Pi's pure preparation
function then verified eligibility at `keepRecentTokens: 0`; only the temporary
profile was changed, and the uncompleted cases were resumed. The successful
30-second test was not repeated. Both interrupted attempts remain in accounting.

## Fovea finding: bounded scope

The test used actual `fovea_focus`, then a custom `bridge_probe` host tool that
changed a disposable `fixture.ts`, then another focus with `fresh: true`:

```ts
// On disk after the host tool:
export const liveMarker = 'AFTER_HOST_EDIT';
// Returned by the second focus:
export const liveMarker = 'BEFORE_HOST_EDIT';
```

Both focus calls succeeded, the host effect executed once, and the graph root was
the same canonical directory as the edited file. Installed Fovea's immediate
mutation hooks specifically handle tools named `edit` and `write`; `fresh` resets
**disclosure**, not necessarily filesystem indexing. Therefore this is evidence
of stale same-run context on the tested **custom-tool mutation path**, not proof
that native `pi.edit` or every Fovea workflow is broken. Those supported paths
still need qualification with the actual Fabric integration.

## Fabric blocker

`fabricGuardStatus()` reported `installed: true, ready: false`. Installed Fabric
is 0.96.1; `scripts/patch-fabric.mjs` is reviewed for 0.94.0 and explicitly refuses
other versions. No patch was forced, guard disabled, alternative provider used,
or stand-in worker test presented as Fabric qualification.

Next: review/update support for the installed Fabric version, then run actual
Main/two-worker tests with shared admission capacities one and three, parent waits,
worker interruption, model/context separation and resource cleanup.

## Accounting and cleanup

- **15 of 24 approved ACP prompt attempts forwarded.** The cap was not reset.
- Local reported credits: **0.3649991448092869** across the available reports;
  **five prompts had no credit report**. This is not an exact total charge.
- Final account-usage control query succeeded without inference. No pre-run
  account snapshot was taken, so an account delta cannot be attributed to this run.
- Final audit: zero surviving recorded Pi/Kiro processes or owned process groups,
  zero leases, zero binding reservations, zero open journal owners.
- Three uncertain records from interrupted tool/approval waits were preserved.
  They were not deleted or falsely marked successful to clear the run.
- The private reports, synthetic transcripts, counter database, journal, and
  harness scripts remain with the operator; none are included in the package.

Before declaring the full workflow ready, resolve the Fabric compatibility gate,
qualify the intended mutation/synchronization path, and complete the remaining
five-minute, crash-after-effect, worker and supervised UI checks. Passing the
checks above does not qualify durable actors, recursion or prewalk.

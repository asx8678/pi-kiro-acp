# Normal-profile activation — 2026-09-25

**Configured and startup-verified for supervised experimental use.** Quit the
existing Pi process and start a **fresh** `pi` session to activate the new defaults.
The currently running conversation was not hot-switched or restarted.

## Completed checks

- [x] Private pre-change backup of settings and every patched package file.
- [x] Registered the local `pi-kiro-acp` package in `~/.pi/agent/settings.json`.
- [x] Applied and verified Fabric **0.96.3** and Fovea **0.31.1** patches in the
  normal installation; pinned both package selections to those reviewed versions.
- [x] Created `~/.pi/agent/kiro-acp.json` with explicit experimental CLI opt-in,
  strict tool-inventory verification and the ordinary `kiro-cli` binary.
- [x] Guarded live discovery with Kiro CLI **2.24.0** returned nine models,
  including Auto, and `reported-tags-and-catalog` verification. Inference was
  prohibited at the RPC request boundary.
- [x] Selected `kiro-acp/auto` for Main and workers; at most two concurrent
  workers and three active account continuations. Daily warning: **50 credits**;
  **no spending cutoff**. Task text/excerpt retention remains disabled.
- [x] Disabled Pi retries, the separately configured `pi-retry` extension, cache
  warming, Jev and automatic prewalk. Unrelated package selections were preserved.
- [x] Set the tested 420-second prompt deadline and 330-second held-tool ceiling.
- [x] A fresh real Pi RPC process using normal settings, without `--model`, chose
  **kiro-acp/auto** and registered `/kiro`, `/usage`, `/fabric` and `/fovea`.
  Auto exposes no reasoning effort in the current catalog, so Pi selected `off`.
- [x] Startup produced no stderr, exited cleanly, left zero leases/reservations/
  open journal owners, and recorded **zero model requests or credit prompts**.
  Installed patch integrity was rechecked afterward.

The startup check used only a temporary CLI forwarding guard that refuses all
inference; normal settings, packages, state and default-model selection were used.
That verification override is **not** saved in the normal bridge configuration.
No user prompt, worker, compaction or billed test was started during activation.
The previous qualification run remains capped and stopped at **24/24** attempts.

## Configuration and recovery

Changed normal-profile files:

- `~/.pi/agent/settings.json`
- `~/.pi/agent/kiro-acp.json`
- `~/.pi/agent/fabric.json`
- `~/.pi/agent/fovea.json`

Private original files, existence/mode/hash manifest and activation evidence:

```text
~/.pi/agent/backups/kiro-activation-2026-09-25T07-37-30-820Z/
```

Credentials were not read, changed or copied into this backup. Newly initialized
bridge state is separate from the backup. To undo activation, stop Pi and restore
the configuration **and package files** using the manifest (not just the default
model); it records which files did not previously exist. Do not restore old package
files over a subsequently upgraded Fabric/Fovea installation without checking its
version. Keep the private bridge state unless deliberately retiring its ledger.

The local package depends on this repository staying in place. Rebuilding changed
policy code, reinstalling packages or upgrading versions requires rechecking the
patches and restarting Pi. See [efficiency.md](efficiency.md) for that workflow.

## Remaining limits

This activation does not upgrade the [qualification verdict](blocker-fixes.md):
supervised TUI, child worker-tool execution/interruption, near-limit automatic
compaction and advanced actor/recursion/prewalk workflows remain unqualified.
Use the app under supervision; this is not an unattended-production certification.

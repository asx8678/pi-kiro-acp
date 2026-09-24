# Changelog

## Unreleased

- Generate a private installation ID once during setup using Crew's UUIDv4 hex
  format. Add an installer, package lifecycle hook and first-load fallback;
  preserve IDs across upgrades and concurrent starts, and keep them out of
  configuration, command output, protocol messages and Git.
- Make `/usage` easier to scan with a balance bar, summary columns, aligned
  credit tables, days with activity by default, and focused session/task views
  with readable titles and selected-entry details. `a` shows all calendar days.
- Add `/usage` with account credits remaining/allowance, recorded daily and
  monthly totals, date selection, and session/task drill-down. Read plan usage
  through the official Kiro CLI with caching and no model prompts. Use the
  configured local time zone for calendar grouping and remove UTC footer text.
- Add persistent shared Kiro credit accounting, parent/worker task attribution,
  private task/session JSONL reports and warning-only daily feedback (50 credits
  in the installed profile; no spending cutoff). Summaries use existing text.
- Add a reproducible, version-checked Fabric 0.94.0 dispatch patch and efficient
  Auto defaults, worker/output bounds, local compaction and manual Fovea updates.
- Show Kiro-reported context percentages separately from Pi estimates, and align
  prompt/frame byte ceilings without changing advertised model windows.
- Discover per-model context windows from ACP metadata or explicit catalog
  descriptions, preserve them in the cache, and label configured fallbacks.
- Display Kiro-reported credits in the footer and `/kiro usage`, with support for
  v3 turn-completion totals and legacy metadata deltas; deduplicate turn summaries.
- Advertise Kiro Crew client, agent and MCP identities over ACP/MCP, and use
  neutral host wording in generated bridge prompts and transcript wrappers.
- Load the live model catalog once at Pi startup and reuse it for model-picker
  requests. Share concurrent loads; keep manual refresh through `/kiro models`
  and `/kiro doctor`.
- Fix Pi host package resolution with a static-import extension entry point.
- Support Kiro CLI 2.24.0's combined tool-tag and client-origin MCP catalog
  reports while retaining strict verification and rejecting native/foreign tools.
- Process early session reports before mode activation and reject stale or
  changed inventory evidence. Scope every inventory report to its ACP session.
- Add tool-surface regressions and an installed-Pi/offline-Kiro host test.

## 0.1.0 — 2026-09-24

Initial experimental implementation. Includes native Pi provider registration, v3
ACP process management, explicit model/effort selection, persistent sessions,
Pi-owned MCP tool handoffs, context fingerprints, conservative rebuilds, SQLite
recovery, local cross-process admission, CLI diagnostics, examples and precompiled
artifacts. Includes an offline protocol fixture and automated tests.

Live Kiro/Pi/Fabric/Fovea qualification is not claimed. No real CLI version is
approved by default. Text-only; live ordered steering and advanced Fabric modes
remain qualification-gated. See docs/compatibility.md.

# Efficiency profile and credit reports

The installed profile uses Kiro Auto, a **50-credit daily warning**, and **no
spending cutoff** (`budget.dailyCredits: 0`). Nothing is stopped merely because
the warning threshold is exceeded. Days use the configured local time zone
(Europe/Paris in the installed profile), including daylight-saving transitions.
Missing billing reports remain unknown; Pi's zero token/USD fields are not
credit measurements.

## Settings

| Area | Profile |
|---|---|
| Main model / workers | `kiro-acp/auto`; low effort where the selected model supports it |
| Worker bounds | Two concurrent, four starts per Fabric execution, depth one, 15-minute timeout |
| Worker transport | Local process with extensions; no durable workers |
| Model routing | Official Kiro CLI ACP; reject foreign worker providers, Claude/Veda runners, and Jev inference |
| Code mode | Fabric enabled; batch independent reads and return computed findings |
| Tool output | 12,000 characters per Fabric result; 64,000 per nested result |
| Context | Compact around 48,000 **estimated** Pi tokens; retain about 8,192 recent tokens |
| Compaction | Fabric's local summary engine, without an additional model summary call |
| ACP byte ceilings | 4 MiB effective prompt, 16 MiB frame, 256 KiB tool result |
| Fovea | Manual navigation retained; no automatic steering turns; symbol grep replaces duplicate output |
| Automatic planning / retries | Prewalk disabled; automatic Pi inference retries disabled |
| Catalog | One live load per startup; only explicit commands refresh it |
| Package manager | Bun; Fabric package selection pinned to the reviewed 0.94.0 |

Reported model windows remain unchanged, including the six 1M entries. Auto's
unknown window retains the labelled 64,000-token fallback. Pi model-specific
`compaction.modelOverrides` reserve the difference between the advertised window
and the 48,000-token target. This is an efficiency setting, not a claim that
Kiro's real window shrank. The byte ceilings remain independent hard bounds;
the adapter never silently truncates a transcript to fit them.

The footer also displays Kiro's `context_usage.usagePercentage`, with the model
label. It is kept separate from Pi's token estimate and is never used to invent
an Auto context capacity or token usage. Auxiliary summary context is excluded
from that foreground indicator.

## Task and session accounting

`/usage` opens the credit dashboard:

- The account section shows **plan credits remaining / allowance**, used
  credits, the reported billing reset date, and any reported bonus/add-on packs.
- Recorded activity shows today, this month, the previous month and all-time
  totals from the shared local ledger in separate summary columns. The account
  balance has a remaining-credits bar. These figures retain their own scopes.
- The daily table starts with days that have recorded activity; `a` toggles all
  calendar days. Dates use readable month names and credits align on the right.
  `—` means no records; `Pending` or `+ ?` indicates missing credit reports.
- Up/down selects a day; Enter opens its sessions and then a session's tasks.
  Left/right changes month; `1` selects this month and `2` the previous month.
  Unnamed sessions use the task description as their display title. The
  selected session/task's details appear below the table; Esc preserves the
  previous selection when going back. Names and recorded values are unchanged.
- `d` accepts `YYYY-MM-DD` or `YYYY-MM`. You can also open a selection directly
  with `/usage 2026-09-24` or `/usage 2026-08`.
- `r` refreshes the account snapshot; `/usage refresh` does the same. Esc goes
  back, and `q` closes the dashboard.

The footer shows recorded credits used today and plan credits remaining. Its
`cached` marker means the account read exceeds the configured cache age (five
minutes by default) or a refresh failed. The dashboard shows when it was checked. `/kiro usage` retains the
detailed JSON diagnostics. Outside Pi:

```sh
node dist/src/cli.js usage
node dist/src/cli.js usage 2026-09-24
node dist/src/cli.js usage 2026-08 --json
node dist/src/cli.js usage --refresh
```

Account usage is read through Kiro CLI's `_kiro/account/getUsage` ACP extension,
the same method its own usage display uses in CLI 2.24.0. Authentication remains
CLI-owned. This read sends no `session/prompt` and does not use a model. Account
reads are cached for `reporting.accountCacheMs` (five minutes by default) and
attempted at interactive startup, after a task settles, and when opening the
dashboard. There is no background network polling. Explicit refresh bypasses
the cache; offline mode uses only existing data. The dashboard's local ledger
refreshes every five seconds without a network call or catalog refresh.

The plan balance covers the Kiro account, including usage outside this bridge;
the daily/session/monthly breakdown covers only recorded bridge activity. The
account's billing cycle may differ from a calendar month. Packs remain separate
from the plan allowance. Unsupported or ambiguous account responses show an
unavailable balance, and a failed refresh keeps any previous snapshot and
reports the error. The adapter does not scrape credentials or call a billing
service directly.

The shared SQLite ledger survives restarts and aggregates the parent, local
Fabric workers, and auxiliary provider requests using the same configuration,
state directory and account scope. Absolute totals are stored per ACP prompt,
so repeated/corrected turn summaries do not create duplicate charges. A single
ACP prompt can include many Pi tool continuations. Each prompt's usage belongs
to its local start day, even when it finishes after midnight. Sessions spanning
multiple days appear on each relevant day with just that day's charges. Missing
reports remain visible as pending amounts, never assumed zero.

Each settled task appends a private JSON line to:

```text
~/.pi/agent/kiro-acp/usage.jsonl
```

Each line contains the session ID/name, task ID, UTC start/finish/report times,
duration, a short user-task excerpt, a short final-response excerpt, outcome,
reported task credits, per-model totals, pending/unreported prompts, and
cumulative session credits. Unnamed sessions use their stable session ID as the
name. Summaries are produced locally from existing text; logging consumes no
model credits. Only bounded excerpts are retained, with basic credential
redaction; this is a private local log, not a full transcript.

Workers inherit a local task attribution ID. It is removed from the Kiro
subprocess environment and is not part of ACP client/agent identity. Late worker
reports append a newer `revision` for the same task. **Use the latest revision
per task ID. Do not sum revisions or cumulative session totals.** The database
remains the source for shared totals.

### Reported tokens

After a user task settles, a widget below the editor shows credits, then
**Last prompt tokens** and **Session tokens** on separate lines. A prompt here
means the complete user task, including its ACP requests, tool continuations
and attributed Fabric workers. Session totals use the stable session ID and
survive restarting Pi. Late worker reports update these totals. The widget
does not add messages to model context or replace Pi's normal footer.

Only explicit non-negative integer counts in Kiro `turn_completion` metadata
are recorded. Input, output, cache and reasoning fields retain their own
coverage; missing fields are not zero. Totals are used only when explicitly
reported, never derived by adding potentially overlapping fields. Incomplete
coverage is labelled `partial` with reported/recorded request counts. Repeated
reports replace the previous counts for that ACP prompt. Context occupancy,
text-size estimates, credits and `throughput.estimatedTokens` are excluded.
Unqualified ACP response `usage` is also excluded because its turn-versus-session
scope is ambiguous; cumulative session values must not be counted per prompt.

Installed Kiro CLI 2.24.0 reports credits and context percentage but omits exact
per-turn token counts. These lines therefore say **not reported by Kiro** until
the CLI supplies them. No historical counts are inferred. `/usage` shows the
selected task/session's recorded token details (session totals cover all days),
and `/kiro usage` includes the current session's token diagnostics. Task log
records include `tokens` and `sessionTokens`, with a reported-request count for
each field; the same revision rules as credits apply.

Local history coverage starts when credit recording is first used. It excludes
earlier runs, other state directories/accounts and unrelated native Kiro
sessions. The dashboard shows its earliest recorded day; periods without
entries say `no records`, including previous months before recording began.
No historical daily/session breakdown or monthly invoice is inferred from
the account total. If a process is killed before Kiro
reports a charge, it stays unknown; a hard kill can also prevent the final task
log line, while previously recorded credit rows remain in SQLite.

## Applying or updating the profile

From this repository:

```sh
bun run build
bun run patch:fabric
bun run configure:efficiency
```

Then restart Pi and existing worker processes. The configuration script saves
private timestamped backups of changed settings. It is an explicit profile
reset: it selects Auto, a 50-credit warning and no cutoff. Rerun it after a
deliberate catalog refresh to rebuild per-model compaction settings.

Fabric 0.94.0 has no public hook that enforces provider policy at every built-in
inference dispatch point. `patch:fabric` therefore applies a narrowly scoped,
version- and SHA-256-checked local patch to worker launch, model preparation,
auto-approval completion, Jev requests, and merged configuration. Original
files are retained beside the patched files. All anchors are checked before
editing, and a manifest records the resulting hashes. The bridge checks this
manifest before serving inference or allowing `fabric_exec`.

A reinstall can remove the patch; rerun `patch:fabric` and restart Pi. A different
Fabric version is rejected until its dispatch paths are reviewed. This protects
the reviewed built-in Fabric paths; it is not an operating-system network sandbox
for arbitrary extensions, MCP servers or shell commands. Strict Kiro native-tool
inventory verification remains enabled.

## Verification for this change

Bun typecheck/build, installed-Pi offline model loading, the existing local
fake-Kiro handoff demo, and the existing installed-Pi/fake-Kiro check passed.
Manual local inspection confirmed the installed dispatch refusals, merged
profile, shared-ledger aggregation, late-worker report revisions, warning-only
admission above 50 synthetic credits, and context-percentage normalization.
The usage dashboard was also opened in installed Pi to check month/date entry
and session/task navigation. Calendar inspection covered Paris daylight-saving
boundaries and cross-month session attribution. The official CLI account read
returned the actual plan allowance; account history and local task totals were
kept separate.
No new tests were written and no paid inference prompts were sent for this
change. Actual credit savings depend on tasks and Kiro routing; they have not
been measured with billed workloads.

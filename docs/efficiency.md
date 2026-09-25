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
| Package manager | Bun; Fabric package selection pinned to the reviewed 0.96.3 |

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
  Rows start with stable short hashed session/task/request IDs, including when
  excerpt retention is disabled. Stored names and descriptions are not restored
  or changed. Selection follows identity across refreshes, sorting and back
  navigation; a removed selection falls back to a remaining row.
- `d` accepts `YYYY-MM-DD` or `YYYY-MM`. You can also open a selection directly
  with `/usage 2026-09-24` or `/usage 2026-08`.
- `/` opens search; Enter applies a case-insensitive label, date or ID filter.
  `/` edits it and `c` clears it. Summary totals remain for the full selected
  day/month, not just matching rows. Drill-down starts unfiltered; Esc restores
  the parent search, sort and selection.
- `s` cycles date ascending, date descending, credits descending and credits
  ascending. Missing credit reports stay last in either credit sort.
- `t` opens complete, scrollable token details for a session/task/request; Enter
  also does this on a task row. Up/down and Page Up/Down scroll; `t` or Esc returns
  to the list. Counts retain per-field coverage and are never added together.
- Dashboard tokens and credits use the same selected local day, attributed by
  prompt start. Multi-day tasks are filtered accordingly; task reports and
  `/kiro usage` keep their all-days token totals. Legacy requests without task
  records remain drillable and keep their tokens. Finished tasks without an
  explicit outcome show "Settled", not "Unfinished" or a fabricated success outcome.
- `r` refreshes the account snapshot; `/usage refresh` does the same. Esc goes
  back, and `q` closes the dashboard.

The footer uses one compact status line for recorded credits used today, plan
credits remaining and Kiro context usage. Unavailable plan/context fields are
omitted; missing credit reports remain labelled `pending`. For example:

```text
Kiro · Today 3.1 cr · Plan 774.21/2,000 left · Context 3.7% (auto)
```

Its `cached` marker means the account read exceeds the configured cache age (five
minutes by default) or a refresh failed. The dashboard always shows a relative
"Updated …" age beside the balance, including compact layouts; `STALE` uses the
same configured threshold and also marks failed refreshes. `/kiro usage` retains the
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

Local usage views use a bounded cache invalidated by SQLite's local change count
and cross-connection data version, so worker corrections are not pinned in stale
views. Transactions bypass the cache. Indexed session/day queries avoid scanning
account-wide history for session tokens or formatting every prompt's date. Status
updates coalesce over 50 ms and share one credit snapshot; dashboard rendering and
resizing use a prepared view model and perform no SQL. Navigation and explicit or
periodic refresh update that model. Budget admission still reads current daily
totals directly; it never trusts the display cache. Number/date formatters are
reused; row credit strings and column widths are prepared on data/view changes,
so painting a large list only measures and formats its visible rows. A local
1,000-session probe using the installed Pi TUI helpers measured a 0.161 ms median
paint (15 samples, versus about 12.6 ms in the earlier review), with zero SQL
queries. These synthetic measurements are not latency guarantees.

A local synthetic comparison against commit `a6afed5` used 50,000 prompt/token
records across 100 sessions and 28 days (Node 24.21.0; 11-sample medians):

| Data refresh | Before | After a ledger write | Unchanged-data cache hit |
|---|---:|---:|---:|
| Widget | 112.6 ms | 4.3 ms | 0.019 ms |
| Dashboard | 307.3 ms | 17.9 ms | 0.027 ms |

Daily totals and session-token results matched the original implementation.
These are local measurements, not latency guarantees; the post-write column
invalidates the application cache, not the operating-system file cache. A separate
offline probe of the installed Pi stream factory confirmed that a two-event limit
still delivers exactly one terminal overflow error. No billed inference was used.

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

Each line contains session/task IDs, UTC start/finish/report times, duration,
outcome, reported credits, per-model totals, pending/unreported prompts and
cumulative session credits. By default, tasks use a generic label and sessions
use an ID-derived name; user-task text and final-response excerpts are not saved.

`reporting.retainTaskExcerpts` defaults to **false**, including for older configs
that omit the setting. Explicitly setting it to `true` retains up to 300 characters
of task text, 500 characters of final response and 200 characters of supplied
session name in SQLite and task reports. This consumes no extra model credits.
Basic credential redaction cannot reliably remove secrets; opt in only if this
local text retention is acceptable. Disabling it affects new writes, not existing
logs, database rows or backups. Restart all bridge workers when changing it. See
[Security and privacy](../SECURITY.md#data-stored).

Each request captures its task and session before asynchronous hooks/startup.
Prompt records use that immutable task ID rather than whichever task happens to
be foreground when the CLI responds. Concurrent conversations retain separate
attribution, while explicit child-worker inheritance still joins the parent task.
Validated absolute credit corrections are persisted before run totals are read
from the ledger; floating-point delta drift cannot discard a correction or leave
a corrected charge blocking the budget.

Workers inherit a local task attribution ID. It is removed from the Kiro
subprocess environment and is not part of ACP client/agent identity. Late worker
reports append a newer `revision` for the same task. **Use the latest revision
per task ID. Do not sum revisions or cumulative session totals.** The database
remains the source for shared totals.

### Reported tokens

Token details are available in `/usage` and `/kiro usage`; they do not add rows
below the editor. The `lastPrompt` diagnostic means the complete settled user
task, including its ACP requests, tool continuations and attributed Fabric
workers. Session totals use the stable session ID and survive restarting Pi.
Late worker reports update these totals.

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
per-turn token counts. Detailed usage views say **not reported by Kiro** until
the CLI supplies them; the status line omits token counts. No historical counts
are inferred. `/usage` shows the selected task/session's recorded token details
for the selected day, and `/kiro usage` includes the current session's token
diagnostics. Task log records include `tokens` and `sessionTokens`, with a
reported-request count for each field; the same revision rules as credits apply.

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
bun run repair:fabric
bun run patch:fovea  # when Fovea is installed
bun run configure:efficiency
```

Then restart Pi and existing worker processes. The configuration script saves
private timestamped backups of changed settings. It is an explicit profile
reset: it selects Auto, a 50-credit warning and no cutoff. Rerun it after a
deliberate catalog refresh to rebuild per-model compaction settings.

Fabric 0.96.3 has no public hook that enforces provider policy at every built-in
inference dispatch point. `patch:fabric` therefore applies a narrowly scoped,
version- and SHA-256-checked local patch to worker launch, model preparation,
auto-approval completion, Jev requests, worker relaunch and merged configuration.
Native approval calls normalize Pi's legacy context so system instructions and
classification schemas reach the native provider. This does not qualify billed
auto-approval inference. Original files are retained beside patched files. Every
source hash and anchor is checked before editing; `--check` verifies without writes.
The bridge checks the exact manifest paths, package version and policy artifact
hash before serving inference or allowing `fabric_exec`. After rebuilding changed
policy code, rerun the patch. The former 0.94.0 patch is no longer the current target.

A reinstall can remove the patch; run `bun run repair:fabric` and restart Pi. This
maintenance command synchronizes the installed package, exact npm dependency and
Pi package selection with the bridge's reviewed version, then applies and checks
the patch. It saves private configuration/lockfile backups and preserves other
settings, including package resource filters. It can upgrade or downgrade Fabric
to that reviewed version; it never selects the latest unreviewed release. The
normal `install:pi` workflow also runs this repair when Fabric is selected or installed.
Startup reports a mismatch before the first prompt; dispatch remains blocked until
repair succeeds. Stop Pi before maintenance and restart existing workers afterward.
A different
Fabric version is rejected until its dispatch paths are reviewed. This protects
the reviewed built-in Fabric paths; it is not an operating-system network sandbox
for arbitrary extensions, MCP servers or shell commands. Strict Kiro native-tool
inventory verification remains enabled.

### Fovea same-run freshness

`patch:fovea` supports the reviewed **0.31.1** source only. Explicit sketch, focus,
dwell and impact operations force the existing incremental filesystem refresh,
including in non-Git roots with turn sync disabled. A pending older refresh cannot
swallow a newer force/hint request. Internal consumers supplying an exact snapshot
still reuse that snapshot. This adds a bounded file-discovery/stat sweep to explicit
non-Git calls, not background polling, automatic steering, or a full reparse of
unchanged content. `fresh` continues to control disclosure separately.

The efficiency installer checks this patch when Fovea is installed. An upstream
update/reinstall requires rechecking the source and restarting Pi; no unsupported
version is patched by guessing anchors. Normal profile settings are not installed
by the compatibility tests. See [the blocker acceptance ledger](blocker-fixes.md).

## Verification for the original efficiency change

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
No new tests were written for the original efficiency change; the later
lifecycle/accounting hardening adds dedicated regressions described in
[testing.md](testing.md). No paid inference prompts were sent for this change. Actual credit savings depend on tasks and Kiro routing; they have not
been measured with billed workloads.

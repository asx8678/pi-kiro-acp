# Planner / implementer workflow

Main uses the explicitly selected Kiro-backed Opus model. Implementation workers
are Pi workers using the real `kiro-acp/auto` catalog entry, with extensions enabled.
Do not silently substitute another provider or planner model.

Before delegating, record the objective, exact repository/worktree identity,
relevant files, interface constraints, invariants, tests, acceptance conditions and
escalation triggers. Assign a coherent bounded task rather than supervising each
read or edit. Use real test results and diffs for acceptance.

Workers should verify their repository identity first, preserve the approved
interfaces, work only within the agreed scope, and return changed files, actual
test commands/results, unresolved failures and design questions. Never report a
test as passed without running or receiving trustworthy evidence for it.

Use Fabric's normal `agents.run` / `agents.spawn` workflow. Kiro is the model
transport, not an independent task executor. Keep all tools in Pi/Fabric and
allow Fovea's effective context changes to reach the provider. Stop and escalate
a repeated implementation failure or a required design change back to Main.

Do not use this prompt to override project permissions or enterprise policy.

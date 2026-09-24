import type { Config } from '../config.js';
import type { Journal } from './journal.js';
import type { CreditReport } from '../kiro/credits.js';
import { tokenFields, type TokenReport, type TokenTotals } from '../kiro/tokens.js';
import { BridgeError, redact } from '../errors.js';
import fs from 'node:fs';
import path from 'node:path';
import { uid } from '../util.js';
import { dayRange, localDay, monthDays, monthRange, shiftMonth, validDay, validMonth } from '../diagnostics/calendar.js';
import type { AccountUsage } from '../kiro/account-usage.js';

interface TaskRow {
    id: string; session_id: string; session_name: string; summary: string;
    started_at: number; finished_at: number | null; revision: number;
    result_summary: string | null; outcome: string | null;
}
export interface TaskDetails { sessionId: string; sessionName?: string; summary: string }
export interface UsageTotals { credits: number | null; prompts: number; unreported: number; unfinished: number }
export interface DayUsage extends UsageTotals { day: string }
export interface SessionUsage extends UsageTotals { id: string; name: string; startedAt: number; tasks: number; summary: string }
export interface TaskUsage extends UsageTotals { id: string; summary: string; outcome: string; startedAt: number; finishedAt: number | null; resultSummary: string | null }

/** Shared accounting with bounded task/result excerpts; never stores full transcripts. */
export class CreditLedger {
    readonly logFile: string;
    private activeTask?: string;
    private taskBySession = new Map<string, string>();
    private ownedTasks = new Set<string>();
    private readonly inheritedTask = process.env.PI_KIRO_CREDIT_OWNER_PID !== String(process.pid) ? process.env.PI_KIRO_CREDIT_TASK_ID : undefined;
    constructor(private journal: Journal, private scope: string, private budget: Config['budget'], readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') {
        this.logFile = path.join(journal.dir, 'usage.jsonl');
        if (fs.existsSync(this.logFile) && fs.lstatSync(this.logFile).isSymbolicLink())
            throw new BridgeError('STORAGE', 'Refusing a symlinked credit log.');
        fs.closeSync(fs.openSync(this.logFile, 'a', 0o600));
        fs.chmodSync(this.logFile, 0o600);
        journal.db.exec(`CREATE TABLE IF NOT EXISTS credit_prompts (
            scope TEXT NOT NULL, id TEXT NOT NULL, model TEXT NOT NULL,
            started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            owner_instance TEXT NOT NULL, finished INTEGER NOT NULL DEFAULT 0,
            credits REAL, source TEXT, PRIMARY KEY(scope,id));
            CREATE INDEX IF NOT EXISTS credit_prompts_day ON credit_prompts(scope,started_at);
            CREATE INDEX IF NOT EXISTS credit_prompts_owner ON credit_prompts(scope,owner_instance);
            CREATE TABLE IF NOT EXISTS credit_tasks (
                scope TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT NOT NULL,
                session_name TEXT NOT NULL, summary TEXT NOT NULL, started_at INTEGER NOT NULL,
                finished_at INTEGER, revision INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,id));
            CREATE TABLE IF NOT EXISTS credit_account_usage (scope TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS prompt_tokens (
                scope TEXT NOT NULL, prompt_id TEXT NOT NULL, source TEXT NOT NULL, updated_at INTEGER NOT NULL,
                ${tokenFields.map(field => `${field} INTEGER`).join(',')}, PRIMARY KEY(scope,prompt_id));`);
        // Additive migration keeps older running bridge processes compatible.
        journal.transaction(() => {
            const columns = journal.db.prepare('PRAGMA table_info(credit_prompts)').all();
            if (!columns.some(column => column.name === 'task_id'))
                journal.db.exec('ALTER TABLE credit_prompts ADD COLUMN task_id TEXT');
            const taskColumns = journal.db.prepare('PRAGMA table_info(credit_tasks)').all();
            if (!taskColumns.some(column => column.name === 'result_summary'))
                journal.db.exec('ALTER TABLE credit_tasks ADD COLUMN result_summary TEXT');
            if (!taskColumns.some(column => column.name === 'outcome'))
                journal.db.exec('ALTER TABLE credit_tasks ADD COLUMN outcome TEXT');
            journal.db.exec('CREATE INDEX IF NOT EXISTS credit_prompts_task ON credit_prompts(scope,task_id); CREATE INDEX IF NOT EXISTS credit_tasks_session ON credit_tasks(scope,session_id);');
        });
        journal.db.function('kiro_credit_day', { deterministic: true }, at => localDay(Number(at), this.timeZone));
    }
    private createTask(details: TaskDetails): string {
        const id = uid('task_');
        const summary = redact(details.summary).replace(/\s+/g, ' ').trim().slice(0, 300) || 'Provider request';
        const name = (details.sessionName || `Session ${details.sessionId.slice(0, 12)}`).slice(0, 200);
        this.journal.db.prepare('INSERT INTO credit_tasks(scope,id,session_id,session_name,summary,started_at) VALUES (?,?,?,?,?,?)')
            .run(this.scope, id, details.sessionId, name, summary, Date.now());
        this.taskBySession.set(details.sessionId, id);
        this.ownedTasks.add(id);
        return id;
    }
    beginTask(details: TaskDetails): string {
        this.endTask();
        if (this.inheritedTask && this.task(this.inheritedTask)) {
            this.activeTask = this.inheritedTask;
            return this.activeTask;
        }
        const id = this.createTask(details);
        this.activeTask = id;
        // Only the explicit host task controls worker inheritance. Resolving another
        // conversation's fallback task must not overwrite this process-wide context.
        process.env.PI_KIRO_CREDIT_TASK_ID = id;
        process.env.PI_KIRO_CREDIT_OWNER_PID = String(process.pid);
        return id;
    }
    ensureTask(details: TaskDetails): string {
        if (this.inheritedTask && this.task(this.inheritedTask))
            return this.inheritedTask;
        return this.taskBySession.get(details.sessionId) ?? this.createTask(details);
    }
    noteResult(summary: string, outcome?: string): void {
        if (this.activeTask && this.ownedTasks.has(this.activeTask))
            this.journal.db.prepare('UPDATE credit_tasks SET result_summary=COALESCE(?,result_summary),outcome=COALESCE(?,outcome) WHERE scope=? AND id=?')
                .run(summary ? redact(summary).replace(/\s+/g, ' ').trim().slice(0, 500) : null, outcome?.slice(0, 32) ?? null, this.scope, this.activeTask);
    }
    endTask(id = this.activeTask): void {
        if (!id) return;
        if (this.ownedTasks.has(id)) {
            this.journal.db.prepare('UPDATE credit_tasks SET finished_at=? WHERE scope=? AND id=?').run(Date.now(), this.scope, id);
            this.publish(id);
            this.ownedTasks.delete(id);
            for (const [session, task] of this.taskBySession)
                if (task === id) this.taskBySession.delete(session);
            if (process.env.PI_KIRO_CREDIT_TASK_ID === id) {
                delete process.env.PI_KIRO_CREDIT_TASK_ID;
                delete process.env.PI_KIRO_CREDIT_OWNER_PID;
            }
        }
        if (this.activeTask === id) this.activeTask = undefined;
    }
    /** Finish all runtime-owned fallback tasks, never an inherited parent's task. */
    close(): void {
        for (const id of [...this.ownedTasks]) this.endTask(id);
        this.activeTask = undefined;
        this.taskBySession.clear();
    }
    private task(id: string): TaskRow | undefined {
        return this.journal.db.prepare('SELECT * FROM credit_tasks WHERE scope=? AND id=?').get(this.scope, id) as unknown as TaskRow | undefined;
    }
    private publish(id: string): void {
        this.journal.transaction(() => {
            const task = this.task(id);
            if (!task?.finished_at)
                return;
            const totals = this.journal.db.prepare(`SELECT SUM(credits) AS reportedCredits, COUNT(*) AS prompts,
                SUM(CASE WHEN credits IS NULL THEN 1 ELSE 0 END) AS unreportedPrompts,
                SUM(CASE WHEN finished=0 THEN 1 ELSE 0 END) AS pendingPrompts
                FROM credit_prompts WHERE scope=? AND task_id=?`).get(this.scope, id);
            const models = this.journal.db.prepare('SELECT model,SUM(credits) AS reportedCredits,COUNT(*) AS prompts FROM credit_prompts WHERE scope=? AND task_id=? GROUP BY model').all(this.scope, id);
            const session = this.journal.db.prepare(`SELECT SUM(p.credits) AS reportedCredits, COUNT(*) AS prompts,
                SUM(CASE WHEN p.credits IS NULL THEN 1 ELSE 0 END) AS unreportedPrompts FROM credit_prompts p
                JOIN credit_tasks t ON p.scope=t.scope AND p.task_id=t.id WHERE t.scope=? AND t.session_id=?`).get(this.scope, task.session_id);
            const report = {
                type: 'task_summary', taskId: id, revision: task.revision + 1,
                sessionId: task.session_id, sessionName: task.session_name,
                startedAt: new Date(task.started_at).toISOString(), finishedAt: new Date(task.finished_at).toISOString(),
                recordedAt: new Date().toISOString(), durationSeconds: Math.round((task.finished_at - task.started_at) / 1000),
                summary: task.summary, summarySource: 'Local excerpt of the user task; no extra inference',
                resultSummary: task.result_summary, outcome: task.outcome ?? 'settled',
                credits: totals, byModel: models, sessionCredits: session,
                tokens: this.taskTokens(id), sessionTokens: this.sessionTokens(task.session_id),
                includesWorkers: true, scope: this.scope,
                accounting: 'Kiro-reported credits and tokens only. Missing reports are unknown. Token fields retain their own report coverage and may overlap; do not sum them to infer a total. Later revisions replace earlier totals for the same task; never sum revisions or cumulative session totals.',
            };
            fs.appendFileSync(this.logFile, JSON.stringify(report) + '\n', { mode: 0o600 });
            fs.chmodSync(this.logFile, 0o600);
            this.journal.db.prepare('UPDATE credit_tasks SET revision=revision+1 WHERE scope=? AND id=?').run(this.scope, id);
        });
    }
    private updateReport(id: string): void {
        const row = this.journal.db.prepare('SELECT task_id FROM credit_prompts WHERE scope=? AND id=?').get(this.scope, id);
        if (typeof row?.task_id === 'string')
            this.publish(row.task_id);
    }
    start(id: string, model: string, at: number, taskId?: string): void {
        const task = taskId ?? this.activeTask ?? this.ensureTask({ sessionId: this.journal.instance, summary: 'Provider request' });
        if (!this.task(task))
            throw new BridgeError('STORAGE', 'Prompt task does not belong to this accounting scope.');
        this.journal.db.prepare('INSERT OR IGNORE INTO credit_prompts(scope,id,model,started_at,updated_at,owner_instance,task_id) VALUES (?,?,?,?,?,?,?)')
            .run(this.scope, id, model, at, at, this.journal.instance, task);
    }
    finish(id: string): void {
        if (!this.journal.closed) {
            this.journal.db.prepare('UPDATE credit_prompts SET finished=1,updated_at=? WHERE scope=? AND id=?')
                .run(Date.now(), this.scope, id);
            this.updateReport(id);
        }
    }
    record(report: CreditReport): void {
        if (!report.promptId || report.total === undefined || !Number.isFinite(report.total) || report.total < 0)
            throw new BridgeError('STORAGE', 'Credit report is missing a valid prompt identity/total.');
        const result = this.journal.db.prepare('UPDATE credit_prompts SET credits=?,source=?,updated_at=? WHERE scope=? AND id=?')
            .run(report.total, report.source, Date.now(), this.scope, report.promptId);
        if (Number(result.changes) !== 1)
            throw new BridgeError('STORAGE', 'Credit report has no matching admitted prompt.');
        this.updateReport(report.promptId);
    }
    currentRunCredits(): number | null {
        const row = this.journal.db.prepare('SELECT SUM(credits) AS used FROM credit_prompts WHERE scope=? AND owner_instance=?')
            .get(this.scope, this.journal.instance) as { used: number | null };
        return row.used;
    }
    recordTokens(report: TokenReport): void {
        const values = tokenFields.map(field => report.counts[field] ?? null);
        if (!report.promptId || report.source !== 'turn_completion' || values.every(value => value === null)
            || values.some(value => value !== null && (!Number.isSafeInteger(value) || value < 0)))
            throw new BridgeError('STORAGE', 'Token report is missing a valid prompt identity/count.');
        if (!this.journal.db.prepare('SELECT 1 FROM credit_prompts WHERE scope=? AND id=?').get(this.scope, report.promptId))
            throw new BridgeError('STORAGE', 'Token report has no matching admitted prompt.');
        // Replace absolute per-turn counts. Replayed or corrected reports cannot double the totals.
        this.journal.db.prepare(`INSERT INTO prompt_tokens(scope,prompt_id,source,updated_at,${tokenFields.join(',')})
            VALUES (${Array(4 + tokenFields.length).fill('?').join(',')}) ON CONFLICT(scope,prompt_id) DO UPDATE SET
            source=excluded.source,updated_at=excluded.updated_at,${tokenFields.map(field => `${field}=excluded.${field}`).join(',')}`)
            .run(this.scope, report.promptId, report.source, Date.now(), ...values);
        this.updateReport(report.promptId);
    }
    private tokenTotals(where: string, id: string): TokenTotals {
        const row = this.journal.db.prepare(`SELECT COUNT(*) AS prompts,COUNT(u.prompt_id) AS reportedPrompts,
            ${tokenFields.map(field => `SUM(u.${field}) AS ${field},COUNT(u.${field}) AS ${field}Reports`).join(',')}
            FROM credit_prompts p LEFT JOIN credit_tasks t ON p.scope=t.scope AND p.task_id=t.id
            LEFT JOIN prompt_tokens u ON p.scope=u.scope AND p.id=u.prompt_id WHERE p.scope=? AND ${where}`)
            .get(this.scope, id)!;
        const fields: TokenTotals['fields'] = {};
        for (const field of tokenFields)
            if (typeof row[field] === 'number')
                fields[field] = { tokens: row[field], reportedPrompts: Number(row[`${field}Reports`]) };
        return { prompts: Number(row.prompts), reportedPrompts: Number(row.reportedPrompts), fields };
    }
    taskTokens(taskId: string): TokenTotals { return this.tokenTotals('p.task_id=?', taskId); }
    sessionTokens(sessionId: string): TokenTotals { return this.tokenTotals('COALESCE(t.session_id,p.owner_instance)=?', sessionId); }
    tokenUsage(sessionId: string) {
        const last = this.journal.db.prepare(`SELECT id FROM credit_tasks WHERE scope=? AND session_id=? AND finished_at IS NOT NULL
            ORDER BY finished_at DESC,rowid DESC LIMIT 1`).get(this.scope, sessionId);
        return {
            lastPrompt: typeof last?.id === 'string' ? { taskId: last.id, ...this.taskTokens(last.id) } : null,
            session: this.sessionTokens(sessionId),
        };
    }
    snapshot(now = Date.now()) {
        const day = localDay(now, this.timeZone);
        const [start, end] = dayRange(day, this.timeZone);
        const row = this.journal.db.prepare(`SELECT SUM(credits) AS used, COUNT(*) AS prompts,
            SUM(CASE WHEN credits IS NULL THEN 1 ELSE 0 END) AS unreported,
            SUM(CASE WHEN finished=0 AND owner_instance IN (SELECT instance FROM owners WHERE state='open') THEN 1 ELSE 0 END) AS pending
            FROM credit_prompts WHERE scope=? AND started_at>=? AND started_at<?`)
            .get(this.scope, start, end) as { used: number | null; prompts: number; unreported: number | null; pending: number | null };
        const all = this.journal.db.prepare('SELECT SUM(credits) AS used FROM credit_prompts WHERE scope=?').get(this.scope) as { used: number | null };
        const limit = this.budget.dailyCredits || null;
        return {
            scope: this.scope, day, timeZone: this.timeZone, reportedCredits: row.used, allTimeReportedCredits: all.used,
            prompts: row.prompts, unreportedPrompts: row.unreported ?? 0, pendingPrompts: row.pending ?? 0,
            dailyLimit: limit, warningCredits: this.budget.warningCredits || (limit === null ? null : limit * this.budget.warningFraction),
            warning: (this.budget.warningCredits > 0 || limit !== null) && (row.used ?? 0) >= (this.budget.warningCredits || (limit ?? 0) * this.budget.warningFraction),
            exhausted: limit !== null && (row.used ?? 0) >= limit,
            logFile: this.logFile,
            coverage: 'Recorded bridge activity, including its workers and auxiliary prompts. Earlier and external CLI activity is excluded. Missing reports are unknown. Days use the configured local time zone and prompt start time.',
        };
    }
    accountUsage(): AccountUsage | undefined {
        const row = this.journal.db.prepare('SELECT data FROM credit_account_usage WHERE scope=?').get(this.scope);
        if (typeof row?.data !== 'string') return;
        return JSON.parse(row.data) as AccountUsage;
    }
    saveAccountUsage(usage: AccountUsage): void {
        this.journal.db.prepare('INSERT INTO credit_account_usage(scope,data) VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET data=excluded.data').run(this.scope, JSON.stringify(usage));
    }
    private totals(start = 0, end = 8640000000000000): UsageTotals {
        return this.journal.db.prepare(`SELECT SUM(credits) AS credits,COUNT(*) AS prompts,
            COALESCE(SUM(CASE WHEN credits IS NULL THEN 1 ELSE 0 END),0) AS unreported,
            COALESCE(SUM(CASE WHEN finished=0 THEN 1 ELSE 0 END),0) AS unfinished
            FROM credit_prompts WHERE scope=? AND started_at>=? AND started_at<?`).get(this.scope, start, end) as unknown as UsageTotals;
    }
    dashboard(selection?: string, now = Date.now()) {
        const today = localDay(now, this.timeZone), currentMonth = today.slice(0, 7), previousMonth = shiftMonth(currentMonth, -1);
        const selected = selection || currentMonth;
        if (!validMonth(selected) && !validDay(selected)) throw new BridgeError('CONFIG', 'Usage: /usage [YYYY-MM | YYYY-MM-DD | refresh]');
        const month = selected.slice(0, 7), range = monthRange(month, this.timeZone);
        const dayRows = this.journal.db.prepare(`SELECT kiro_credit_day(started_at) AS day,SUM(credits) AS credits,COUNT(*) AS prompts,
            COALESCE(SUM(CASE WHEN credits IS NULL THEN 1 ELSE 0 END),0) AS unreported,
            COALESCE(SUM(CASE WHEN finished=0 THEN 1 ELSE 0 END),0) AS unfinished
            FROM credit_prompts WHERE scope=? AND started_at>=? AND started_at<? GROUP BY day ORDER BY day`)
            .all(this.scope, ...range) as unknown as DayUsage[];
        const days = monthDays(month).map(day => dayRows.find(row => row.day === day) ?? { day, credits: null, prompts: 0, unreported: 0, unfinished: 0 });
        let sessions: SessionUsage[] = [];
        if (validDay(selected)) {
            sessions = this.journal.db.prepare(`SELECT COALESCE(t.session_id,p.owner_instance) AS id,
                COALESCE(MAX(t.session_name),'Unnamed session') AS name,MIN(p.started_at) AS startedAt,
                COUNT(DISTINCT p.task_id) AS tasks,COALESCE(MIN(t.summary),'Provider request') AS summary,
                SUM(p.credits) AS credits,COUNT(*) AS prompts,
                COALESCE(SUM(CASE WHEN p.credits IS NULL THEN 1 ELSE 0 END),0) AS unreported,
                COALESCE(SUM(CASE WHEN p.finished=0 THEN 1 ELSE 0 END),0) AS unfinished
                FROM credit_prompts p LEFT JOIN credit_tasks t ON t.scope=p.scope AND t.id=p.task_id
                WHERE p.scope=? AND p.started_at>=? AND p.started_at<? GROUP BY COALESCE(t.session_id,p.owner_instance) ORDER BY startedAt`)
                .all(this.scope, ...dayRange(selected, this.timeZone)) as unknown as SessionUsage[];
        }
        const first = this.journal.db.prepare('SELECT MIN(started_at) AS started FROM credit_prompts WHERE scope=?').get(this.scope);
        return {
            timeZone: this.timeZone, today, currentMonth, previousMonth, selected, month,
            todayUsage: this.totals(...dayRange(today, this.timeZone)),
            currentMonthUsage: this.totals(...monthRange(currentMonth, this.timeZone)),
            previousMonthUsage: this.totals(...monthRange(previousMonth, this.timeZone)),
            selectedUsage: this.totals(...(validDay(selected) ? dayRange(selected, this.timeZone) : range)),
            allTime: this.totals(), recordedSince: typeof first?.started === 'number' ? localDay(first.started, this.timeZone) : null,
            days, sessions, account: this.accountUsage(), logFile: this.logFile,
        };
    }
    sessionTasks(day: string, sessionId: string): TaskUsage[] {
        return this.journal.db.prepare(`SELECT COALESCE(t.id,p.id) AS id,COALESCE(t.summary,'Provider request') AS summary,
            COALESCE(t.outcome,'unfinished') AS outcome,MIN(p.started_at) AS startedAt,t.finished_at AS finishedAt,t.result_summary AS resultSummary,
            SUM(p.credits) AS credits,COUNT(*) AS prompts,
            COALESCE(SUM(CASE WHEN p.credits IS NULL THEN 1 ELSE 0 END),0) AS unreported,
            COALESCE(SUM(CASE WHEN p.finished=0 THEN 1 ELSE 0 END),0) AS unfinished
            FROM credit_prompts p LEFT JOIN credit_tasks t ON t.scope=p.scope AND t.id=p.task_id
            WHERE p.scope=? AND p.started_at>=? AND p.started_at<? AND COALESCE(t.session_id,p.owner_instance)=?
            GROUP BY COALESCE(t.id,p.id) ORDER BY startedAt`)
            .all(this.scope, ...dayRange(day, this.timeZone), sessionId) as unknown as TaskUsage[];
    }
    assertAvailable(): void {
        if (!this.budget.dailyCredits)
            return;
        const usage = this.snapshot();
        if (usage.exhausted)
            throw new BridgeError('LIMIT', `Daily Kiro budget reached: ${usage.reportedCredits} / ${usage.dailyLimit} credits (${usage.day}, ${this.timeZone}). New requests and continuations are blocked; already-running inference may still report credits.`);
    }
}

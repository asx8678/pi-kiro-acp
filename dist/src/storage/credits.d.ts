import type { Config } from '../config.js';
import type { Journal } from './journal.js';
import type { CreditReport } from '../kiro/credits.js';
import { type TokenReport, type TokenTotals } from '../kiro/tokens.js';
import type { AccountUsage } from '../kiro/account-usage.js';
export interface TaskDetails {
    sessionId: string;
    sessionName?: string;
    summary: string;
}
export interface UsageTotals {
    credits: number | null;
    prompts: number;
    unreported: number;
    unfinished: number;
}
export interface DayUsage extends UsageTotals {
    day: string;
}
export interface SessionUsage extends UsageTotals {
    id: string;
    name: string;
    startedAt: number;
    tasks: number;
    summary: string;
}
export interface TaskUsage extends UsageTotals {
    id: string;
    kind: 'task' | 'prompt';
    summary: string;
    outcome: string;
    startedAt: number;
    finishedAt: number | null;
    resultSummary: string | null;
}
/** Shared accounting with bounded task/result excerpts; never stores full transcripts. */
export declare class CreditLedger {
    private journal;
    private scope;
    private budget;
    readonly timeZone: string;
    private readonly retainTaskExcerpts;
    readonly logFile: string;
    private activeTask?;
    private cache;
    private cacheVersion;
    private cached;
    private taskBySession;
    private ownedTasks;
    private readonly inheritedTask;
    constructor(journal: Journal, scope: string, budget: Config['budget'], timeZone?: string, retainTaskExcerpts?: boolean);
    private createTask;
    beginTask(details: TaskDetails): string;
    ensureTask(details: TaskDetails): string;
    noteResult(summary: string, outcome?: string): void;
    endTask(id?: string | undefined): void;
    /** Finish all runtime-owned fallback tasks, never an inherited parent's task. */
    close(): void;
    private task;
    private publish;
    private updateReport;
    start(id: string, model: string, at: number, taskId?: string): void;
    finish(id: string): void;
    record(report: CreditReport): void;
    currentRunCredits(): number | null;
    recordTokens(report: TokenReport): void;
    private tokenTotals;
    taskTokens(taskId: string, day?: string): TokenTotals;
    promptTokens(promptId: string, day?: string): TokenTotals;
    sessionTokens(sessionId: string, day?: string): TokenTotals;
    tokenUsage(sessionId: string): {
        lastPrompt: {
            prompts: number;
            reportedPrompts: number;
            fields: Partial<Record<import("../kiro/tokens.js").TokenField, {
                tokens: number;
                reportedPrompts: number;
            }>>;
            taskId: string;
        } | null;
        session: TokenTotals;
    };
    private readTokenUsage;
    snapshot(now?: number): {
        scope: string;
        day: string;
        timeZone: string;
        reportedCredits: number | null;
        allTimeReportedCredits: number | null;
        prompts: number;
        unreportedPrompts: number;
        pendingPrompts: number;
        dailyLimit: number | null;
        warningCredits: number | null;
        warning: boolean;
        exhausted: boolean;
        logFile: string;
        coverage: string;
    };
    private readSnapshot;
    accountUsage(): AccountUsage | undefined;
    saveAccountUsage(usage: AccountUsage): void;
    private totals;
    dashboard(selection?: string, now?: number): {
        timeZone: string;
        today: string;
        currentMonth: string;
        previousMonth: string;
        selected: string;
        month: string;
        todayUsage: UsageTotals;
        currentMonthUsage: UsageTotals;
        previousMonthUsage: UsageTotals;
        selectedUsage: UsageTotals;
        allTime: UsageTotals;
        recordedSince: string | null;
        days: DayUsage[];
        sessions: SessionUsage[];
        account: AccountUsage | undefined;
        logFile: string;
    };
    private readDashboard;
    sessionTasks(day: string, sessionId: string): TaskUsage[];
    private readSessionTasks;
    assertAvailable(): void;
}

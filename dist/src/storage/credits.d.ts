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
    readonly logFile: string;
    private activeTask?;
    private ownsTask;
    private readonly inheritedTask;
    constructor(journal: Journal, scope: string, budget: Config['budget'], timeZone?: string);
    beginTask(details: TaskDetails): void;
    ensureTask(details: TaskDetails): void;
    noteResult(summary: string, outcome?: string): void;
    endTask(): void;
    private task;
    private publish;
    private updateReport;
    start(id: string, model: string, at: number): void;
    finish(id: string): void;
    record(report: CreditReport): void;
    recordTokens(report: TokenReport): void;
    private tokenTotals;
    taskTokens(taskId: string): TokenTotals;
    sessionTokens(sessionId: string): TokenTotals;
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
    sessionTasks(day: string, sessionId: string): TaskUsage[];
    assertAvailable(): void;
}

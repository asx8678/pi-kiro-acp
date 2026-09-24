import { type Obj } from '../util.js';
import type { CreditReport } from '../kiro/credits.js';
import type { TokenReport } from '../kiro/tokens.js';
import type { CreditLedger } from '../storage/credits.js';
export declare class Metrics {
    readonly ledger?: CreditLedger | undefined;
    private accountCacheMs;
    constructor(ledger?: CreditLedger | undefined, accountCacheMs?: number);
    generations: number;
    toolCalls: number;
    rebuilds: number;
    cancellations: number;
    failures: number;
    readonly usageProvenance = "Pi token/USD fields are compatibility placeholders, not free inference; reported Kiro credits are tracked separately";
    private observations;
    private creditsUsed;
    private creditReports;
    private creditSources;
    onCredits?: () => void;
    private context?;
    startPrompt(id: string, model: string, at: number): void;
    finishPrompt(id: string): void;
    observeContext(generation: string, model: string, percent: number): void;
    clearContext(generation: string): void;
    observe(data: Obj): void;
    observeCredits(report: CreditReport): void;
    observeTokens(report: TokenReport): void;
    get credits(): {
        used: number | null;
        reports: number;
        scope: string;
        sources: string[];
    };
    creditStatus(): string;
    snapshot(): Obj;
}

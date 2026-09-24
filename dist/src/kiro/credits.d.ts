export interface CreditReport {
    delta: number;
    reports: number;
    source: 'meteringUsage' | 'turn_completion';
    promptId?: string;
    total?: number;
}
export declare function creditAmounts(entries: unknown, field: 'value' | 'usage'): {
    total: number;
    reports: number;
} | undefined;
/** One ACP prompt can span several host generations. Credit totals follow ACP. */
export declare class PromptCredits {
    private total?;
    private summarized;
    get used(): number | undefined;
    reset(): void;
    observe(entries: unknown, source: CreditReport['source']): CreditReport | undefined;
}

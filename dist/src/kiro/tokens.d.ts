import { type Obj } from '../util.js';
export declare const tokenFields: readonly ["totalTokens", "inputTokens", "outputTokens", "uncachedInputTokens", "cacheReadInputTokens", "cacheWriteInputTokens", "thoughtTokens"];
export type TokenField = typeof tokenFields[number];
export type TokenCounts = Partial<Record<TokenField, number>>;
export interface TokenReport {
    promptId: string;
    source: 'turn_completion';
    counts: TokenCounts;
}
export interface TokenTotals {
    prompts: number;
    reportedPrompts: number;
    fields: Partial<Record<TokenField, {
        tokens: number;
        reportedPrompts: number;
    }>>;
}
/** Kiro's explicit per-turn metadata only. Context occupancy and throughput estimates are not usage. */
export declare function turnTokens(meta: Obj, promptId: string): TokenReport | undefined;

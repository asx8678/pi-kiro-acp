import { object, type Obj } from '../util.js';

export const tokenFields = ['totalTokens', 'inputTokens', 'outputTokens', 'uncachedInputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens', 'thoughtTokens'] as const;
export type TokenField = typeof tokenFields[number];
export type TokenCounts = Partial<Record<TokenField, number>>;
export interface TokenReport { promptId: string; source: 'turn_completion'; counts: TokenCounts }
export interface TokenTotals {
    prompts: number;
    reportedPrompts: number;
    fields: Partial<Record<TokenField, { tokens: number; reportedPrompts: number }>>;
}

/** Kiro's explicit per-turn metadata only. Context occupancy and throughput estimates are not usage. */
export function turnTokens(meta: Obj, promptId: string): TokenReport | undefined {
    if (meta.kind !== 'turn_completion' || meta.estimated === true || meta.tokensEstimated === true)
        return;
    const candidates = [meta.tokenUsage, meta.usage, meta.metrics, meta].filter(object);
    const aliases: Record<TokenField, string[]> = {
        totalTokens: ['totalTokens'], inputTokens: ['inputTokens'], outputTokens: ['outputTokens'],
        uncachedInputTokens: ['uncachedInputTokens'], cacheReadInputTokens: ['cacheReadInputTokens', 'cachedReadTokens', 'cachedTokens'],
        cacheWriteInputTokens: ['cacheWriteInputTokens', 'cachedWriteTokens'], thoughtTokens: ['thoughtTokens'],
    };
    const counts: TokenCounts = {};
    for (const field of tokenFields) {
        for (const candidate of candidates) {
            if (candidate.estimated === true || candidate.tokensEstimated === true || meta[`${field}Estimated`] === true || candidate[`${field}Estimated`] === true)
                continue;
            if (field === 'outputTokens' && (meta.output_tokens_estimated === true || candidate.output_tokens_estimated === true))
                continue;
            const value = aliases[field]
                .filter(key => meta[`${key}Estimated`] !== true && candidate[`${key}Estimated`] !== true)
                .map(key => candidate[key]).find(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
            if (typeof value === 'number') { counts[field] = value; break; }
        }
    }
    // Do not derive totalTokens by summing fields with potentially overlapping cache/reasoning counts.
    if (Object.keys(counts).length)
        return { promptId, source: 'turn_completion', counts };
    return;
}

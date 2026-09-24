import { object } from '../util.js';
export const tokenFields = ['totalTokens', 'inputTokens', 'outputTokens', 'uncachedInputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens', 'thoughtTokens'];
/** Kiro's explicit per-turn metadata only. Context occupancy and throughput estimates are not usage. */
export function turnTokens(meta, promptId) {
    if (meta.kind !== 'turn_completion' || meta.estimated === true)
        return;
    const candidates = [meta.tokenUsage, meta.usage, meta.metrics, meta].filter(object);
    const aliases = {
        totalTokens: ['totalTokens'], inputTokens: ['inputTokens'], outputTokens: ['outputTokens'],
        uncachedInputTokens: ['uncachedInputTokens'], cacheReadInputTokens: ['cacheReadInputTokens', 'cachedReadTokens', 'cachedTokens'],
        cacheWriteInputTokens: ['cacheWriteInputTokens', 'cachedWriteTokens'], thoughtTokens: ['thoughtTokens'],
    };
    const counts = {};
    for (const field of tokenFields) {
        for (const candidate of candidates) {
            if (candidate.estimated === true || candidate.tokensEstimated === true || meta[`${field}Estimated`] === true || candidate[`${field}Estimated`] === true)
                continue;
            if (field === 'outputTokens' && (meta.output_tokens_estimated === true || candidate.output_tokens_estimated === true))
                continue;
            const value = aliases[field].map(key => candidate[key]).find(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
            if (typeof value === 'number') {
                counts[field] = value;
                break;
            }
        }
    }
    // Do not derive totalTokens by summing fields with potentially overlapping cache/reasoning counts.
    if (Object.keys(counts).length)
        return { promptId, source: 'turn_completion', counts };
    return;
}
//# sourceMappingURL=tokens.js.map
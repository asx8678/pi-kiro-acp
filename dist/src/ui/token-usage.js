const labels = {
    totalTokens: 'total', inputTokens: 'in', outputTokens: 'out', uncachedInputTokens: 'uncached in',
    cacheReadInputTokens: 'cache read', cacheWriteInputTokens: 'cache write', thoughtTokens: 'thinking',
};
export function tokenText(usage) {
    if (!usage.prompts)
        return 'no recorded requests';
    if (!usage.reportedPrompts)
        return 'not reported by Kiro';
    const fields = Object.entries(usage.fields);
    const parts = fields.map(([field, count]) => `${count.tokens.toLocaleString('en-US')} ${labels[field]}${count.reportedPrompts < usage.prompts ? ` (partial ${count.reportedPrompts}/${usage.prompts} requests)` : ''}`);
    if (!usage.fields.totalTokens)
        parts.unshift('total not reported');
    return parts.join(' · ');
}
//# sourceMappingURL=token-usage.js.map
import { object } from '../util.js';
export function creditAmounts(entries, field) {
    if (!Array.isArray(entries))
        return;
    let total = 0, reports = 0;
    for (const entry of entries) {
        if (!object(entry) || entry.unit !== 'credit')
            continue;
        const value = entry[field];
        if (typeof value !== 'number' && !(typeof value === 'string' && value.length <= 128 && /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())))
            continue;
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0 || !Number.isFinite(total + n))
            continue;
        total += n;
        reports++;
    }
    return reports ? { total, reports } : undefined;
}
/** One ACP prompt can span several host generations. Credit totals follow ACP. */
export class PromptCredits {
    total;
    summarized = false;
    get used() { return this.total; }
    reset() { this.total = undefined; this.summarized = false; }
    observe(entries, source) {
        const summary = source === 'turn_completion';
        if (!summary && this.summarized)
            return;
        const parsed = creditAmounts(entries, summary ? 'usage' : 'value');
        if (!parsed)
            return;
        const total = summary ? parsed.total : (this.total ?? 0) + parsed.total;
        if (!Number.isFinite(total))
            return;
        const previous = this.total;
        this.total = total;
        this.summarized ||= summary;
        if (summary && previous === total)
            return; // Repeated turn summaries must not charge the same turn twice.
        return { delta: total - (previous ?? 0), reports: parsed.reports, source };
    }
}
//# sourceMappingURL=credits.js.map
import { object } from '../util.js';

export interface CreditReport {
    delta: number;
    reports: number;
    source: 'meteringUsage' | 'turn_completion';
    promptId?: string;
    total?: number;
}
export function creditAmounts(entries: unknown, field: 'value' | 'usage'): { total: number; reports: number } | undefined {
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
    private total?: number;
    private summarized = false;
    get used(): number | undefined { return this.total; }
    reset(): void { this.total = undefined; this.summarized = false; }
    observe(entries: unknown, source: CreditReport['source']): CreditReport | undefined {
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

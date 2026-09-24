import { object } from '../util.js';
export class Metrics {
    ledger;
    accountCacheMs;
    constructor(ledger, accountCacheMs = 300000) {
        this.ledger = ledger;
        this.accountCacheMs = accountCacheMs;
    }
    generations = 0;
    toolCalls = 0;
    rebuilds = 0;
    cancellations = 0;
    failures = 0;
    usageProvenance = 'Pi token/USD fields are compatibility placeholders, not free inference; reported Kiro credits are tracked separately';
    observations = [];
    creditsUsed = null;
    creditReports = 0;
    creditSources = new Set();
    onCredits;
    context;
    startPrompt(id, model, at) {
        this.ledger?.start(id, model, at);
        this.onCredits?.();
    }
    finishPrompt(id) {
        this.ledger?.finish(id);
        this.onCredits?.();
    }
    observeContext(generation, model, percent) {
        this.context = { generation, model, percent, at: Date.now(), source: 'Kiro context_usage.usagePercentage; separate from Pi token estimates' };
        this.onCredits?.();
    }
    clearContext(generation) {
        if (this.context?.generation === generation) {
            this.context = undefined;
            this.onCredits?.();
        }
    }
    observe(data) {
        // Only documented scalar accounting shapes; never retain arbitrary upstream payloads.
        const out = { at: Date.now() };
        for (const key of ['used', 'size', 'inputTokens', 'outputTokens'])
            if (typeof data[key] === 'number' && Number.isFinite(data[key]) && data[key] >= 0)
                out[key] = data[key];
        if (object(data.cost) && typeof data.cost.amount === 'number' && Number.isFinite(data.cost.amount) && data.cost.amount >= 0 && typeof data.cost.currency === 'string')
            out.cost = { amount: data.cost.amount, currency: data.cost.currency };
        if (Object.keys(out).length === 1)
            return;
        this.observations.push(out);
        if (this.observations.length > 100)
            this.observations.shift();
    }
    observeCredits(report) {
        const total = (this.creditsUsed ?? 0) + report.delta;
        if (!Number.isFinite(report.delta) || !Number.isFinite(total) || total < 0)
            return;
        this.ledger?.record(report);
        this.creditsUsed = total;
        this.creditReports += report.reports;
        this.creditSources.add(report.source);
        this.observations.push({ at: Date.now(), credits: report.delta, source: report.source });
        if (this.observations.length > 100)
            this.observations.shift();
        this.onCredits?.();
    }
    observeTokens(report) {
        this.ledger?.recordTokens(report);
        this.onCredits?.();
    }
    get credits() {
        return { used: this.creditsUsed, reports: this.creditReports, scope: 'current extension run in this Pi process', sources: [...this.creditSources] };
    }
    creditStatus() {
        if (this.ledger) {
            const usage = this.ledger.snapshot();
            const format = (n) => n > 0 && n < 0.01 ? '<0.01' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n);
            const limit = usage.dailyLimit === null ? '' : ` / ${usage.dailyLimit}`;
            const used = usage.reportedCredits === null && usage.prompts > 0 ? 'awaiting credit report' : `${format(usage.reportedCredits ?? 0)}${limit} credits`;
            const pending = usage.unreportedPrompts && usage.reportedCredits !== null ? `; ${usage.unreportedPrompts} awaiting credit report` : '';
            const account = this.ledger.accountUsage();
            const allowance = account?.allowance;
            const plan = allowance?.remaining !== null && allowance?.remaining !== undefined && allowance.total !== null
                ? ` | Plan left ${format(allowance.remaining)}/${format(allowance.total)}${account?.lastError || Date.now() - account.checkedAt > this.accountCacheMs ? ' (cached)' : ''}`
                : ' | Plan balance unavailable';
            const context = this.context ? ` | Kiro context ${this.context.percent.toFixed(1)}% (${this.context.model})` : '';
            return `Kiro today: ${used}${pending}${usage.exhausted ? ' [limit reached]' : usage.warning ? ' [daily warning]' : ''}${plan}${context}`;
        }
        const n = this.creditsUsed;
        const value = n === null ? 'unknown' : n > 0 && n < 0.000001 ? '<0.000001' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(n);
        return `Kiro credits used: ${value} (this run)`;
    }
    snapshot() { return { generations: this.generations, toolCalls: this.toolCalls, rebuilds: this.rebuilds, cancellations: this.cancellations, failures: this.failures, usageProvenance: this.usageProvenance, credits: this.credits, sharedCredits: this.ledger?.snapshot(), account: this.ledger?.accountUsage(), kiroContext: this.context ?? null, reportedObservations: this.observations }; }
}
//# sourceMappingURL=metrics.js.map
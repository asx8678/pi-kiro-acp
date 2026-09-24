import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Journal } from '../src/storage/journal.js';
import { CreditLedger } from '../src/storage/credits.js';
import { Metrics } from '../src/diagnostics/metrics.js';
import { PromptCredits } from '../src/kiro/credits.js';
import { turnTokens } from '../src/kiro/tokens.js';
import { parseAccountUsage } from '../src/kiro/account-usage.js';
import { dayRange } from '../src/diagnostics/calendar.js';
import { ProviderRuntime } from '../src/provider/runtime.js';
import { config, model, context, collect, cleanup } from './helpers.js';
import { deferred } from '../src/util.js';

function fixture() {
    const c = config(), journal = new Journal(c.stateDir);
    c.budget.dailyCredits = 0.4;
    const ledger = new CreditLedger(journal, c.admission.scope, c.budget, 'UTC'), metrics = new Metrics(ledger);
    return { c, journal, ledger, metrics, close() { ledger.close(); journal.close(); fs.rmSync(c.stateDir, { recursive: true, force: true }); } };
}

test('absolute credit corrections cannot be discarded by floating-point drift', () => {
    const f = fixture();
    try {
        const task = f.ledger.beginTask({ sessionId: 'corrections', summary: 'test' });
        f.metrics.startPrompt('a', 'test-opus', Date.now(), task);
        f.metrics.startPrompt('b', 'auto', Date.now(), task);
        const a = new PromptCredits(), b = new PromptCredits();
        const report = (credits: PromptCredits, id: string, usage: number) => {
            const value = credits.observe([{ unit: 'credit', usage }], 'turn_completion');
            if (value) f.metrics.observeCredits({ ...value, promptId: id, total: credits.used });
        };
        report(a, 'a', 0.2); report(b, 'b', 0.5);
        assert.throws(() => f.ledger.assertAvailable(), /budget reached/);
        report(a, 'a', 0); report(b, 'b', 0);
        assert.equal(f.ledger.snapshot().reportedCredits, 0);
        assert.equal(f.metrics.credits.used, 0);
        assert.doesNotThrow(() => f.ledger.assertAvailable());
        report(b, 'b', 0);
        assert.equal(f.ledger.snapshot().reportedCredits, 0);
    } finally { f.close(); }
});

test('legacy direct accounting calls still default to the explicit host task', () => {
    const f = fixture();
    try {
        const task = f.ledger.beginTask({ sessionId: 'host', summary: 'host task' });
        f.metrics.startPrompt('legacy', 'auto', Date.now());
        assert.equal(f.ledger.taskTokens(task).prompts, 1);
        assert.equal(f.ledger.sessionTokens('host').prompts, 1);
    } finally { f.close(); }
});

test('standalone metrics replace attributed totals rather than summing corrections', () => {
    const metrics = new Metrics();
    for (const [promptId, total, delta] of [['a', 0.2, 0.2], ['b', 0.5, 0.5], ['a', 0, -0.2], ['b', 0, -0.5]] as const)
        metrics.observeCredits({ promptId, total, delta, reports: 1, source: 'turn_completion' });
    assert.equal(metrics.credits.used, 0);
});

test('parallel runtime sessions retain separate prompt attribution', { timeout: 15000 }, async () => {
    const c = config(), r = new ProviderRuntime(c);
    try {
        const answers = await Promise.all([
            collect(r.generate(model(c), context('alpha'), { sessionId: 'alpha' })),
            collect(r.generate(model(c, 'auto'), context('beta'), { sessionId: 'beta' })),
        ]);
        assert.deepEqual(answers.map(answer => answer.stopReason), ['stop', 'stop']);
        assert.equal(r.credits.sessionTokens('alpha').prompts, 1);
        assert.equal(r.credits.sessionTokens('beta').prompts, 1);
        await r.close();
        const reports = fs.readFileSync(c.stateDir + '/usage.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.deepEqual(reports.map(report => report.sessionId).sort(), ['alpha', 'beta']);
    } finally { await cleanup(r, c); }
});

test('request attribution is captured before asynchronous payload hooks', { timeout: 15000 }, async () => {
    const c = config(), r = new ProviderRuntime(c), entered = deferred<void>(), release = deferred<void>();
    try {
        const first = r.credits.beginTask({ sessionId: 'same', summary: 'first task' });
        const stream = r.generate(model(c), context('first request'), { sessionId: 'same', onPayload: async () => { entered.resolve(); await release.promise; } });
        await entered.promise;
        const second = r.credits.beginTask({ sessionId: 'same', summary: 'later task' });
        assert.notEqual(first, second);
        release.resolve();
        assert.equal((await collect(stream)).stopReason, 'stop');
        assert.equal(r.credits.taskTokens(first).prompts, 1);
        assert.equal(r.credits.taskTokens(second).prompts, 0);
    } finally { release.resolve(); await cleanup(r, c); }
});

test('captured prompt tasks survive a host task switch and preserve worker inheritance', () => {
    const f = fixture();
    const oldOwner = process.env.PI_KIRO_CREDIT_OWNER_PID;
    let worker: CreditLedger | undefined;
    try {
        const first = f.ledger.beginTask({ sessionId: 'first', summary: 'first' });
        const fallback = f.ledger.ensureTask({ sessionId: 'other', summary: 'other' });
        assert.equal(process.env.PI_KIRO_CREDIT_TASK_ID, first);
        const second = f.ledger.beginTask({ sessionId: 'second', summary: 'second' });
        f.ledger.start('late-first', 'auto', Date.now(), first);
        f.ledger.start('second', 'auto', Date.now(), second);
        f.ledger.start('fallback', 'auto', Date.now(), fallback);
        assert.equal(f.ledger.sessionTokens('first').prompts, 1);
        assert.equal(f.ledger.sessionTokens('second').prompts, 1);
        assert.equal(f.ledger.sessionTokens('other').prompts, 1);
        // Simulate the inherited environment observed by a distinct worker process.
        process.env.PI_KIRO_CREDIT_OWNER_PID = String(process.pid + 1);
        worker = new CreditLedger(f.journal, f.c.admission.scope, f.c.budget, 'UTC');
        const inherited = worker.ensureTask({ sessionId: 'worker', summary: 'worker' });
        assert.equal(inherited, second);
        worker.start('worker', 'auto', Date.now(), inherited);
        worker.close();
        assert.equal(f.ledger.sessionTokens('second').prompts, 2);
        assert.equal(f.journal.db.prepare('SELECT finished_at FROM credit_tasks WHERE id=?').get(second)?.finished_at, null);
    } finally {
        worker?.close();
        if (oldOwner === undefined) delete process.env.PI_KIRO_CREDIT_OWNER_PID;
        else process.env.PI_KIRO_CREDIT_OWNER_PID = oldOwner;
        f.close();
    }
});

test('estimated token envelopes and aliases never become exact usage', () => {
    const counts = { inputTokens: 100, outputTokens: 20 };
    assert.equal(turnTokens({ kind: 'turn_completion', tokensEstimated: true, tokenUsage: counts }, 'p'), undefined);
    assert.equal(turnTokens({ kind: 'turn_completion', estimated: true, metrics: counts }, 'p'), undefined);
    assert.equal(turnTokens({ kind: 'turn_completion', tokenUsage: { ...counts, tokensEstimated: true } }, 'p'), undefined);
    assert.deepEqual(turnTokens({ kind: 'turn_completion', cachedTokensEstimated: true, tokenUsage: { cachedTokens: 100, outputTokens: 20 } }, 'p')?.counts, { outputTokens: 20 });
    assert.deepEqual(turnTokens({ kind: 'turn_completion', tokenUsage: { ...counts, outputTokensEstimated: true } }, 'p')?.counts, { inputTokens: 100 });
    assert.deepEqual(turnTokens({ kind: 'turn_completion', tokenUsage: counts }, 'p')?.counts, counts);
});

test('token replacements preserve field coverage without inferring totals', () => {
    const f = fixture();
    try {
        const task = f.ledger.ensureTask({ sessionId: 'tokens', summary: 'tokens' });
        f.ledger.start('a', 'auto', Date.now(), task); f.ledger.start('b', 'auto', Date.now(), task);
        f.ledger.recordTokens({ promptId: 'a', source: 'turn_completion', counts: { inputTokens: 100, outputTokens: 20 } });
        f.ledger.recordTokens({ promptId: 'a', source: 'turn_completion', counts: { inputTokens: 80 } });
        assert.deepEqual(f.ledger.sessionTokens('tokens'), { prompts: 2, reportedPrompts: 1, fields: { inputTokens: { tokens: 80, reportedPrompts: 1 } } });
    } finally { f.close(); }
});

test('account parsing keeps ambiguous allowances unavailable', () => {
    const allowance = { resourceType: 'credit', used: 20, limit: 100 };
    assert.equal(parseAccountUsage({ success: true, data: { usageBreakdowns: [allowance, allowance] } }).status, 'unavailable');
    assert.equal(parseAccountUsage({ success: true, data: { usageBreakdowns: [allowance] } }).allowance?.remaining, 80);
});

test('local credit days respect both daylight-saving boundaries', () => {
    for (const [day, hours] of [['2026-03-29', 23], ['2026-10-25', 25]] as const) {
        const [start, end] = dayRange(day, 'Europe/Paris');
        assert.equal(end - start, hours * 3600000);
    }
});

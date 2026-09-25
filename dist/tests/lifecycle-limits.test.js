import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setImmediate as tick } from 'node:timers/promises';
import { ProviderRuntime } from '../src/provider/runtime.js';
import { V3Session } from '../src/kiro/v3.js';
import { Catalog } from '../src/tools/catalog.js';
import { Journal } from '../src/storage/journal.js';
import { CreditLedger } from '../src/storage/credits.js';
import { BoundedStream, LocalStream, StreamWriter } from '../src/provider/stream.js';
import { BridgeError } from '../src/errors.js';
import { deferred } from '../src/util.js';
import { config, context, model, collect, cleanup } from './helpers.js';
const timeout = { timeout: 15000 };
async function bounded(promise, ms = 2500) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Test deadline exceeded')), ms); })]);
    }
    finally {
        clearTimeout(timer);
    }
}
for (const timing of ['immediate', 'late'])
    test(`payload hook abort observes its ${timing} rejection`, timeout, async () => {
        const c = config(), r = new ProviderRuntime(c), ctl = new AbortController();
        try {
            const answer = await collect(r.generate(model(c), context(), {
                signal: ctl.signal,
                onPayload: () => {
                    ctl.abort();
                    const error = new Error('Payload hook rejected after abort');
                    return timing === 'immediate' ? Promise.reject(error)
                        : new Promise((_, reject) => setImmediate(() => reject(error)));
                },
            }));
            assert.equal(answer.stopReason, 'aborted');
            assert.equal(r.metrics.generations, 0, 'an aborted payload hook must never start inference');
            assert.deepEqual(r.status().sessions, []);
            // Let both immediate and delayed unhandled rejections reach the test runner.
            await tick();
            await tick();
        }
        finally {
            await cleanup(r, c);
        }
    });
test('shutdown does not await a stalled observer and late rejection cannot dispatch events', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c), entered = deferred(), gate = deferred();
    let callbacks = 0;
    try {
        const stream = r.generate(model(c), context('plain output'), { sessionId: 'observer', onProviderStreamEvent: async () => { callbacks++; entered.resolve(); await gate.promise; } });
        await bounded(entered.promise);
        await bounded(r.close());
        assert.equal(r.journal.closed, true);
        assert.equal((await stream.result()).stopReason, 'aborted');
        const count = callbacks;
        gate.reject(new Error('late observer failure'));
        await tick();
        assert.equal(callbacks, count);
    }
    finally {
        gate.resolve();
        await cleanup(r, c);
    }
});
test('closing skips stalled observers but drains already-received final accounting', timeout, async () => {
    const c = config(), entered = deferred(), gate = deferred();
    const s = new V3Session(c, c.stateDir, new Catalog([]), async () => { entered.resolve(); await gate.promise; });
    const credits = [], tokens = [];
    s.onEvent = async (event) => { if (event.kind === 'credits')
        credits.push(event.report.total); if (event.kind === 'tokens')
        tokens.push(event.report.counts.inputTokens); };
    let prompt;
    try {
        await s.start('Offline observer test', undefined);
        prompt = s.prompt('plain output').catch(error => error);
        await bounded(entered.promise);
        s.rpc.onNotification('session/update', { sessionId: s.sessionId, update: { sessionUpdate: 'session_info_update', _meta: { kiro: {
                        kind: 'turn_completion', promptTurnSummaries: [{ unit: 'credit', usage: 0.25 }], tokenUsage: { inputTokens: 10 },
                    } } } });
        await bounded(s.close());
        await bounded(prompt);
        assert.deepEqual(credits, [0.25]);
        assert.deepEqual(tokens, [10]);
    }
    finally {
        gate.resolve();
        await s.close();
        await prompt;
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('observer rejection preserves credit and token reports from the same frame', timeout, async () => {
    const c = config(), s = new V3Session(c, c.stateDir, new Catalog([]), async () => { throw new Error('Observer rejected'); });
    const credits = [], tokens = [];
    s.onEvent = async (event) => { if (event.kind === 'credits')
        credits.push(event.report.total); if (event.kind === 'tokens')
        tokens.push(event.report.counts.inputTokens); };
    let prompt;
    try {
        await s.start('Offline observer failure test', undefined);
        prompt = s.prompt('DELAY_RESPONSE').catch(error => error);
        s.rpc.onNotification('session/update', { sessionId: s.sessionId, update: { sessionUpdate: 'session_info_update', _meta: { kiro: {
                        kind: 'turn_completion', promptTurnSummaries: [{ unit: 'credit', usage: 0.25 }], tokenUsage: { inputTokens: 10 },
                    } } } });
        assert.match((await bounded(s.failed.promise)).message, /Observer rejected/);
        await bounded(s.close());
        await bounded(prompt);
        assert.deepEqual(credits, [0.25]);
        assert.deepEqual(tokens, [10]);
    }
    finally {
        await s.close();
        await prompt;
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('discovery waits for the delayed initial catalog without sending inference', timeout, async () => {
    const c = config();
    c.cli.prefixArgs.push('--delayed-catalog', '--tags-inventory');
    const r = new ProviderRuntime(c);
    try {
        const result = await r.discover();
        assert.deepEqual(result.models.map(m => m.id), ['auto', 'test-opus']);
        assert.equal(result.toolAudit, 'reported-tags-and-catalog');
        assert.equal(r.metrics.generations, 0);
    }
    finally {
        await cleanup(r, c);
    }
});
test('delayed model and effort confirmations are awaited without implicit fallback', timeout, async () => {
    const c = config();
    c.cli.prefixArgs.push('--delayed-selection');
    const s = new V3Session(c, c.stateDir, new Catalog([]));
    try {
        await s.start('Offline selection test', undefined);
        await s.select('test-opus', 'high');
        assert.equal(s.selected().model, 'test-opus');
        assert.equal(s.selected().effort, 'high');
        await assert.rejects(s.select('not-advertised'), /did not advertise/);
    }
    finally {
        await s.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('missing catalog readiness has a bounded timeout', timeout, async () => {
    const c = config();
    c.cli.prefixArgs.push('--missing-catalog');
    c.cli.rpcTimeoutMs = 1500;
    const s = new V3Session(c, c.stateDir, new Catalog([]));
    try {
        await assert.rejects(s.start('Offline timeout test', undefined), error => error instanceof BridgeError && error.code === 'TIMEOUT' && /catalog/.test(error.message));
    }
    finally {
        await s.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
for (const action of ['abort', 'close'])
    test(`catalog readiness is cancellable by ${action}`, timeout, async () => {
        const c = config();
        c.cli.prefixArgs.push('--missing-catalog');
        const s = new V3Session(c, c.stateDir, new Catalog([])), ctl = new AbortController(), activated = deferred();
        const request = s.rpc.request.bind(s.rpc);
        s.rpc.request = async (method, params, options) => { const result = await request(method, params, options); if (method === 'session/set_mode')
            activated.resolve(); return result; };
        const started = s.start('Offline cancellation test', undefined, ctl.signal);
        const rejected = assert.rejects(started, error => error instanceof BridgeError && ['CANCELLED', 'TRANSPORT'].includes(error.code));
        try {
            await bounded(activated.promise);
            if (action === 'abort')
                ctl.abort();
            else
                await bounded(s.close());
            await bounded(rejected);
        }
        finally {
            ctl.abort();
            await s.close();
            await rejected;
            fs.rmSync(c.stateDir, { recursive: true, force: true });
        }
    });
for (const bound of ['count', 'bytes'])
    test(`ACP notification backlog enforces its ${bound} bound with a slow observer`, timeout, async () => {
        const c = config();
        c.limits.maxQueuedEvents = bound === 'count' ? 2 : 8;
        c.limits.maxPromptBytes = 1024;
        c.limits.maxFrameBytes = 131072;
        const gate = deferred(), entered = deferred();
        const s = new V3Session(c, c.stateDir, new Catalog([]), async () => { entered.resolve(); await gate.promise; });
        const send = () => s.rpc.onNotification('session/update', { sessionId: s.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: bound === 'bytes' ? 'x'.repeat(80000) : 'x' } } });
        try {
            await s.start('Offline backlog test', undefined);
            send();
            await bounded(entered.promise);
            send();
            send();
            const failure = await bounded(s.failed.promise);
            assert.match(failure.message, /backlog/);
            await bounded(s.close());
        }
        finally {
            gate.resolve();
            await s.close();
            fs.rmSync(c.stateDir, { recursive: true, force: true });
        }
    });
for (const bound of ['count', 'bytes'])
    for (const corrected of [false, true])
        test(`ACP ${bound} overflow preserves ${corrected ? 'corrected' : 'received'} accounting and enforces the budget`, timeout, async () => {
            const c = config();
            c.limits.maxQueuedEvents = bound === 'count' ? 2 : 8;
            c.limits.maxPromptBytes = 1024;
            c.limits.maxFrameBytes = 131072;
            c.budget.dailyCredits = 0.25;
            const journal = new Journal(c.stateDir), ledger = new CreditLedger(journal, c.admission.scope, c.budget);
            const gate = deferred(), entered = deferred();
            let observed = 0, promptId = '';
            const credits = [], tokens = [];
            const s = new V3Session(c, c.stateDir, new Catalog([]), async () => { observed++; entered.resolve(); await gate.promise; });
            s.onEvent = async (event) => {
                if (event.kind === 'prompt_start') {
                    promptId = event.promptId;
                    ledger.start(promptId, 'auto', event.startedAt);
                }
                if (event.kind === 'prompt_end')
                    ledger.finish(event.promptId);
                if (event.kind === 'credits') {
                    ledger.record(event.report);
                    credits.push(event.report.total);
                }
                if (event.kind === 'tokens') {
                    ledger.recordTokens(event.report);
                    tokens.push(event.report.counts.inputTokens);
                }
            };
            const report = (total, inputTokens, padded = false) => s.rpc.onNotification('session/update', {
                sessionId: s.sessionId, update: { sessionUpdate: 'session_info_update', _meta: { kiro: {
                            kind: 'turn_completion', promptTurnSummaries: [{ unit: 'credit', usage: total }],
                            ...(inputTokens === undefined ? {} : { tokenUsage: { inputTokens } }),
                            ...(padded ? { extra: 'x'.repeat(80000) } : {}),
                        } } },
            });
            let prompt;
            try {
                await s.start('Offline accounting overflow test', undefined);
                prompt = s.prompt('DELAY_RESPONSE').catch(error => error);
                s.rpc.onNotification('session/update', { sessionId: s.sessionId, update: {
                        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: bound === 'bytes' ? 'x'.repeat(80000) : 'x' },
                    } });
                await bounded(entered.promise);
                report(0.125); // This older accounting event is queued behind the stalled observer.
                report(1, 10, bound === 'bytes'); // The received completion exceeds the backlog bound.
                // Corrections arriving during teardown must replace totals, without growing a new queue.
                if (corrected)
                    for (let i = 0; i < 32; i++)
                        report(0.75, 7);
                await bounded(s.close());
                const failure = await bounded(prompt);
                assert.ok(failure instanceof BridgeError && failure.code === 'LIMIT');
                assert.equal(observed, 1, 'closing must stop observer delivery');
                assert.deepEqual(credits, [0.125, corrected ? 0.75 : 1], 'older queued totals must drain before the final report');
                assert.deepEqual(tokens, [corrected ? 7 : 10]);
                assert.equal(ledger.snapshot().reportedCredits, corrected ? 0.75 : 1);
                assert.equal(ledger.snapshot().unreportedPrompts, 0);
                assert.equal(ledger.snapshot().pendingPrompts, 0);
                assert.equal(ledger.promptTokens(promptId).fields.inputTokens?.tokens, corrected ? 7 : 10);
                assert.throws(() => ledger.assertAvailable(), { code: 'LIMIT' });
            }
            finally {
                gate.resolve();
                await s.close();
                await prompt;
                ledger.close();
                journal.close();
                fs.rmSync(c.stateDir, { recursive: true, force: true });
            }
        });
test('adapter enforces the configured queue limit around a host-provided stream', timeout, async () => {
    const c = config();
    c.limits.maxQueuedEvents = 2;
    const r = new ProviderRuntime(c, undefined, () => new LocalStream(100000));
    try {
        const stream = r.generate(model(c), context('plain output'));
        const result = await stream.result();
        assert.equal(result.stopReason, 'error');
        assert.match(result.errorMessage, /queue/);
        const events = [];
        for await (const event of stream)
            events.push(event);
        assert.equal(events.filter(e => e.type === 'error' || e.type === 'done').length, 1);
        assert.ok(events.length <= c.limits.maxQueuedEvents + 1);
    }
    finally {
        await cleanup(r, c);
    }
});
test('completion queue overflow ends the stream and releases admission for the next generation', timeout, async () => {
    const c = config();
    c.limits.maxQueuedEvents = 3;
    c.admission.maxActive = 1;
    const r = new ProviderRuntime(c, undefined, () => new LocalStream(100000));
    try {
        // The single text chunk fills the queue with start/text_start/text_delta.
        // Leave it unread so completion, rather than chunk delivery, overflows it.
        const stream = r.generate(model(c), context('plain output'), { sessionId: 'completion-overflow' });
        const result = await bounded(stream.result());
        assert.equal(result.stopReason, 'error');
        assert.match(result.errorMessage, /LIMIT:.*queue/);
        const events = [];
        for await (const event of stream)
            events.push(event);
        assert.deepEqual(events.map(event => event.type), ['start', 'text_start', 'text_delta', 'error']);
        assert.equal(r.metrics.failures, 1);
        assert.deepEqual(r.admission.status(), [], 'failed completion must release its active slot');
        // A consumer that drains events can immediately reuse the conversation and
        // the only admission slot, rebuilding the failed binding without hanging.
        const next = await bounded(collect(r.generate(model(c), context('follow-up output'), { sessionId: 'completion-overflow' })));
        assert.equal(next.stopReason, 'stop');
        assert.deepEqual(r.admission.status(), []);
        await bounded(r.close());
    }
    finally {
        await cleanup(r, c);
    }
});
test('bounded host streams release capacity as events are consumed', timeout, async () => {
    const c = config(), stream = new BoundedStream(new LocalStream(100000), 4), writer = new StreamWriter(stream, model(c), 1000);
    try {
        const consumed = (async () => { const events = []; for await (const event of stream)
            events.push(event); return events; })();
        for (let i = 0; i < 20; i++) {
            writer.chunk('text', 'x');
            await tick();
        }
        writer.finish();
        const events = await consumed;
        assert.equal(events.filter(e => e.type === 'text_delta').length, 20);
        assert.equal((await stream.result()).stopReason, 'stop');
        assert.equal(events.filter(e => e.type === 'done').length, 1);
    }
    finally {
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=lifecycle-limits.test.js.map
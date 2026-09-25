import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ProviderRuntime } from '../src/provider/runtime.js';
import { BridgeError } from '../src/errors.js';
import { config, context, model, collect, addResult, cleanup } from './helpers.js';
const timeout = { timeout: 15000 };
const outputContext = (prompt = 'CALL_TOOL', name = 'decision_output') => ({
    messages: [{ role: 'user', content: prompt }], systemPrompt: 'Return the requested data through the output tool.',
    tools: [{ name, description: 'Return data only.', parameters: { type: 'object', properties: { value: { type: 'string' }, iteration: { type: 'number' } } } }],
});
test('structured completion shares task attribution but never takes over a held main conversation', timeout, async () => {
    const c = config();
    c.admission.maxActive = 1;
    const r = new ProviderRuntime(c), ctx = context(), sessionId = 'main-with-classifier';
    try {
        const first = await collect(r.generate(model(c), ctx, { sessionId }));
        assert.equal(first.stopReason, 'toolUse');
        const before = r.journal.unresolved()[0];
        const result = await r.completeStructured(model(c), outputContext(), { sessionId });
        assert.equal(result.stopReason, 'toolUse');
        assert.equal(result.content.find(b => b.type === 'toolCall').name, 'decision_output');
        assert.deepEqual(r.journal.unresolved(), [before], 'only the real host effect remains pending');
        assert.deepEqual(r.admission.status(), [], 'the auxiliary session is closed before its result is returned');
        assert.equal(r.journal.db.prepare('SELECT COUNT(*) AS n FROM binding_reservations').get()?.n, 0);
        assert.equal(r.journal.db.prepare('SELECT COUNT(DISTINCT task_id) AS n FROM credit_prompts').get()?.n, 1);
        assert.equal(r.status().sessions.length, 1, 'the parent session survives');
        addResult(ctx, first);
        const next = await collect(r.generate(model(c), ctx, { sessionId }));
        assert.equal(next.stopReason, 'stop', next.errorMessage);
        assert.equal(r.metrics.rebuilds, 0);
        assert.equal(r.metrics.toolCalls, 1, 'structured output is not counted as a host action');
        assert.equal(r.journal.db.prepare('SELECT COUNT(*) AS n FROM credit_prompts').get()?.n, 2, 'the parent resumes its original ACP prompt');
    }
    finally {
        await cleanup(r, c);
    }
});
test('repeated result-only completions leave no held effects, resident sessions or admission slots', timeout, async () => {
    const c = config();
    c.sessions.maxResident = 1;
    const r = new ProviderRuntime(c);
    try {
        for (let i = 0; i < 3; i++) {
            const result = await r.completeStructured(model(c), outputContext(i === 0 ? 'CALL_TOOL DUPLICATE_TOOL_REQUEST' : 'CALL_TOOL'), { sessionId: 'same-session' });
            assert.equal(result.stopReason, 'toolUse');
            assert.deepEqual(result.content.find(b => b.type === 'toolCall').arguments, { value: 'hello', iteration: 0 });
            assert.equal(r.status().sessions.length, 0);
            assert.deepEqual(r.admission.status(), []);
            assert.equal(r.journal.db.prepare('SELECT COUNT(*) AS n FROM handoffs').get()?.n, 0);
            assert.equal(r.journal.db.prepare('SELECT COUNT(*) AS n FROM credit_prompts WHERE finished=0').get()?.n, 0);
        }
        const next = await collect(r.generate(model(c), context('Normal user request'), { sessionId: 'same-session' }));
        assert.equal(next.stopReason, 'stop', next.errorMessage);
    }
    finally {
        await cleanup(r, c);
    }
});
test('an ordinary tool named classify_result still requires an authoritative host result', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c);
    try {
        const first = await collect(r.generate(model(c), outputContext('CALL_TOOL', 'classify_result')));
        assert.equal(first.stopReason, 'toolUse');
        assert.equal(r.journal.unresolved()[0]?.tool_name, 'classify_result');
        assert.equal(r.journal.unresolved()[0]?.phase, 'EXPOSED_TO_PI');
    }
    finally {
        await cleanup(r, c);
    }
});
test('structured completion rejects ambiguous schemas and invalid deadlines before inference', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c);
    try {
        for (const tools of [[], [...outputContext().tools, { ...outputContext().tools[0], name: 'another' }]])
            await assert.rejects(r.completeStructured(model(c), { ...outputContext(), tools }), /exactly one/);
        await assert.rejects(r.completeStructured(model(c), outputContext(), { toolChoice: 'none' }), /exactly one/);
        for (const timeoutMs of [0, -1, Infinity, NaN, '30'])
            await assert.rejects(r.completeStructured(model(c), outputContext(), { timeoutMs }), /timeoutMs/);
        assert.equal(r.credits.snapshot().prompts, 0);
        assert.equal(r.status().sessions.length, 0);
    }
    finally {
        await cleanup(r, c);
    }
});
for (const action of ['abort', 'shutdown', 'timeout'])
    test(`structured completion cleans up on ${action} without an effect journal record`, timeout, async () => {
        const c = config(), r = new ProviderRuntime(c), controller = new AbortController();
        try {
            const completion = r.completeStructured(model(c), outputContext('DELAY_RESPONSE'), { signal: controller.signal, timeoutMs: action === 'timeout' ? 1000 : 10000 });
            const rejected = assert.rejects(completion, error => error instanceof BridgeError && error.code === 'CANCELLED');
            if (action !== 'timeout') {
                const deadline = Date.now() + 4000;
                while (r.metrics.generations === 0) {
                    assert.ok(Date.now() < deadline);
                    await delay(10);
                }
                if (action === 'abort')
                    controller.abort();
                else
                    await r.close();
            }
            await rejected;
            if (!r.journal.closed) {
                assert.deepEqual(r.journal.unresolved(), []);
                assert.deepEqual(r.admission.status(), []);
                assert.equal(r.status().sessions.length, 0);
            }
        }
        finally {
            await cleanup(r, c);
        }
    });
test('a failed cleanup cannot return a successful structured decision', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c);
    const acquire = r.admission.acquire.bind(r.admission);
    r.admission.acquire = async (signal) => {
        const lease = await acquire(signal);
        return { ...lease, release: () => { lease.release(); throw new Error('Injected lease cleanup failure'); } };
    };
    try {
        await assert.rejects(r.completeStructured(model(c), outputContext()), /Injected lease cleanup failure/);
        assert.deepEqual(r.journal.unresolved(), []);
        assert.deepEqual(r.admission.status(), []);
        assert.equal(r.status().sessions.length, 0);
    }
    finally {
        await cleanup(r, c);
    }
});
test('structured output bytes are bounded without publishing a partial decision', timeout, async () => {
    const c = config();
    c.limits.maxOutputBytes = 30;
    const r = new ProviderRuntime(c);
    try {
        const result = await r.completeStructured(model(c), outputContext());
        assert.equal(result.stopReason, 'error');
        assert.match(result.errorMessage, /byte limit/);
        assert.ok(!result.content.some(b => b.type === 'toolCall'));
        assert.deepEqual(r.journal.unresolved(), []);
    }
    finally {
        await cleanup(r, c);
    }
});
//# sourceMappingURL=structured-output.test.js.map
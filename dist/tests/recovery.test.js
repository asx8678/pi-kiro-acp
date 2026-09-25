import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { ProviderRuntime } from '../src/provider/runtime.js';
import { Journal } from '../src/storage/journal.js';
import { V3Session } from '../src/kiro/v3.js';
import { Catalog } from '../src/tools/catalog.js';
import { alive, deferred } from '../src/util.js';
import { config, model, context, collect, addResult, cleanup } from './helpers.js';
const timeout = { timeout: 15000 };
for (const owner of ['active', 'restarted'])
    test(`budget cutoff records the ${owner} owner's completed tool before refusing continuation`, timeout, async () => {
        const c = config();
        c.budget.dailyCredits = 1;
        let r = new ProviderRuntime(c);
        const ctx = context(), sessionId = 'budget-with-completed-effect';
        try {
            const first = await collect(r.generate(model(c), ctx, { sessionId }));
            assert.equal(first.stopReason, 'toolUse');
            const row = r.journal.unresolved()[0];
            const task = r.credits.ensureTask({ sessionId: 'worker', summary: 'Offline worker accounting' });
            r.credits.start('worker-prompt', 'auto', Date.now(), task);
            r.credits.record({ promptId: 'worker-prompt', total: 1, delta: 1, reports: 1, source: 'turn_completion' });
            r.credits.finish('worker-prompt');
            addResult(ctx, first);
            if (owner === 'restarted') {
                await r.close();
                r = new ProviderRuntime(c);
            }
            // A model/context change must not rebuild and infer before the budget veto.
            const response = await collect(r.generate(model(c, 'auto'), ctx, { sessionId }));
            assert.equal(response.stopReason, 'error');
            assert.match(response.errorMessage, /Daily Kiro budget reached/);
            const retired = r.journal.get(row.id);
            assert.equal(retired.phase, 'CANCELLED');
            assert.ok(retired.result_hash, 'the authoritative result remains durable');
            assert.deepEqual(r.journal.unresolved(), []);
            assert.deepEqual(r.admission.status(), []);
            assert.equal(r.journal.db.prepare('SELECT COUNT(*) AS n FROM credit_prompts').get()?.n, 2, 'no further inference was admitted');
            await r.abortActive();
            await r.reset();
            // Fresh requests also fail before inspecting or starting the configured CLI.
            c.cli.binary = '/nonexistent/review-fixture-cli';
            const fresh = await collect(r.generate(model(c), context('New task'), { sessionId: 'new-session' }));
            assert.match(fresh.errorMessage, /Daily Kiro budget reached/);
        }
        finally {
            await cleanup(r, c);
        }
    });
test('an exhausted budget cannot silently reconcile a missing host result', timeout, async () => {
    const c = config();
    c.budget.dailyCredits = 1;
    const r = new ProviderRuntime(c), ctx = context();
    try {
        const first = await collect(r.generate(model(c), ctx));
        assert.equal(first.stopReason, 'toolUse');
        const prompt = r.journal.db.prepare('SELECT id FROM credit_prompts').get();
        r.credits.record({ promptId: String(prompt.id), total: 1, delta: 1, reports: 1, source: 'turn_completion' });
        ctx.messages.push(first);
        const response = await collect(r.generate(model(c), ctx));
        assert.match(response.errorMessage, /UNCERTAIN/);
        assert.equal(r.journal.unresolved()[0]?.phase, 'UNCERTAIN');
        assert.equal(r.journal.unresolved()[0]?.result_hash, null);
    }
    finally {
        await cleanup(r, c);
    }
});
const tick = () => new Promise(resolve => setImmediate(resolve));
test('cancel then reset cannot bypass an unrecorded host effect', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c), ctx = context();
    try {
        const first = await collect(r.generate(model(c), ctx, { sessionId: 'reset' }));
        assert.equal(first.stopReason, 'toolUse');
        fs.writeFileSync(c.stateDir + '/effect', 'applied once');
        await r.abortActive();
        await assert.rejects(r.reset(), /refuses pending/);
        const refused = await collect(r.generate(model(c), ctx, { sessionId: 'reset' }));
        assert.match(refused.errorMessage, /UNCERTAIN/);
        addResult(ctx, first);
        assert.equal((await collect(r.generate(model(c), ctx, { sessionId: 'reset' }))).stopReason, 'stop');
        await tick();
        await r.reset();
        assert.equal(r.metrics.toolCalls, 1);
        assert.equal(r.journal.unresolved().length, 0);
        assert.equal(fs.readFileSync(c.stateDir + '/effect', 'utf8'), 'applied once');
    }
    finally {
        await cleanup(r, c);
    }
});
test('a clean reset followed by restart preserves unresolved recovery identity', timeout, async () => {
    const c = config(), first = new ProviderRuntime(c), ctx = context();
    let second;
    try {
        await first.reset();
        const answer = await collect(first.generate(model(c), ctx, { sessionId: 'restart-after-reset' }));
        assert.equal(answer.stopReason, 'toolUse');
        await first.close();
        second = new ProviderRuntime(c);
        const refused = await collect(second.generate(model(c), ctx, { sessionId: 'restart-after-reset' }));
        assert.match(refused.errorMessage, /UNCERTAIN/);
        addResult(ctx, answer);
        assert.equal((await collect(second.generate(model(c), ctx, { sessionId: 'restart-after-reset' }))).stopReason, 'stop');
        assert.equal(second.metrics.toolCalls, 0);
    }
    finally {
        await first.close();
        await second?.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('opaque legacy handoffs block dispatch and require one exact Pi result', timeout, async () => {
    const c = config(), old = new Journal(c.stateDir), ctx = context();
    const row = old.receive({ binding: 'unrecoverable-old-reset-hash', generation: 'old-generation', requestId: '1', toolName: 'fabric_exec', argsHash: 'old-args' }).row;
    old.transition(row.id, 'EXPOSED_TO_PI');
    // Simulate a pre-upgrade writer: the old handoff row has no stable-key marker.
    old.db.prepare('DELETE FROM stable_handoffs WHERE id=?').run(row.id);
    old.close();
    const r = new ProviderRuntime(c);
    try {
        assert.match((await collect(r.generate(model(c), ctx, { sessionId: 'legacy' }))).errorMessage, /UNCERTAIN/);
        const result = { role: 'toolResult', toolCallId: row.pi_call_id, toolName: row.tool_name, isError: false, content: [{ type: 'text', text: 'HOST_OK' }] };
        ctx.messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: row.pi_call_id, name: row.tool_name, arguments: {} }] }, result, result);
        assert.match((await collect(r.generate(model(c), ctx, { sessionId: 'legacy' }))).errorMessage, /ambiguous/);
        ctx.messages.pop();
        assert.equal((await collect(r.generate(model(c), ctx, { sessionId: 'legacy' }))).stopReason, 'stop');
        assert.equal(r.journal.get(row.id)?.phase, 'CANCELLED');
        assert.equal(r.metrics.toolCalls, 0);
    }
    finally {
        await cleanup(r, c);
    }
});
test('legacy live owners block recovery while marked unrelated handoffs do not', () => {
    const c = config(), first = new Journal(c.stateDir), second = new Journal(c.stateDir);
    try {
        const row = first.receive({ binding: 'other', generation: 'other-gen', requestId: '1', toolName: 'fabric_exec', argsHash: 'x' }).row;
        first.transition(row.id, 'EXPOSED_TO_PI');
        assert.equal(second.recoveryCandidates('current').length, 0);
        first.db.prepare('DELETE FROM stable_handoffs WHERE id=?').run(row.id);
        assert.equal(second.recoveryCandidates('current').length, 1);
        assert.equal(second.ownerLive(row.owner_instance, row.owner_pid), true);
    }
    finally {
        first.close();
        second.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('a live legacy owner blocks the provider before a new prompt is sent', timeout, async () => {
    const c = config(), old = new Journal(c.stateDir);
    const row = old.receive({ binding: 'old-epoch', generation: 'live-old', requestId: '1', toolName: 'fabric_exec', argsHash: 'x' }).row;
    old.transition(row.id, 'EXPOSED_TO_PI');
    old.db.prepare('DELETE FROM stable_handoffs WHERE id=?').run(row.id);
    const r = new ProviderRuntime(c);
    try {
        const refused = await collect(r.generate(model(c), context(), { sessionId: 'new' }));
        assert.match(refused.errorMessage, /BUSY.*live process/);
        assert.equal(r.metrics.generations, 0);
        old.close();
        assert.match((await collect(r.generate(model(c), context(), { sessionId: 'new' }))).errorMessage, /UNCERTAIN/);
        assert.equal(r.metrics.toolCalls, 0);
    }
    finally {
        old.close();
        await cleanup(r, c);
    }
});
test('competing result-only continuations preserve the winning generation', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c), ctx = context();
    try {
        const first = await r.generate(model(c), ctx, { sessionId: 'racing' }).result();
        addResult(ctx, first);
        const answers = await Promise.all(Array.from({ length: 3 }, () => r.generate(model(c), ctx, { sessionId: 'racing' }).result()));
        assert.deepEqual(answers.map(answer => answer.stopReason), ['stop', 'error', 'error']);
        assert.match(answers[1].errorMessage, /BUSY/);
        assert.match(answers[2].errorMessage, /BUSY/);
        assert.equal(r.metrics.toolCalls, 1);
    }
    finally {
        await cleanup(r, c);
    }
});
test('an aborted continuation waiter never closes the current binding', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c), ctx = context(), ctl = new AbortController();
    try {
        const first = await r.generate(model(c), ctx, { sessionId: 'waiter' }).result();
        addResult(ctx, first);
        const cancelled = r.generate(model(c), ctx, { sessionId: 'waiter', signal: ctl.signal });
        ctl.abort();
        assert.equal((await cancelled.result()).stopReason, 'aborted');
        assert.equal((await collect(r.generate(model(c), ctx, { sessionId: 'waiter' }))).stopReason, 'stop');
        assert.equal(r.metrics.toolCalls, 1);
    }
    finally {
        await cleanup(r, c);
    }
});
test('reset excludes both asynchronous starters and new generations during eviction', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c), entered = deferred(), release = deferred();
    try {
        const starting = r.generate(model(c), context('first'), { sessionId: 'idle', onPayload: async () => { entered.resolve(); await release.promise; } });
        await entered.promise;
        await assert.rejects(r.reset(), /idle provider/);
        release.resolve();
        assert.equal((await collect(starting)).stopReason, 'stop');
        await tick();
        const resetting = r.reset();
        const refused = await collect(r.generate(model(c), context('racing reset'), { sessionId: 'idle' }));
        assert.match(refused.errorMessage, /reset is in progress/);
        await resetting;
        assert.equal((await collect(r.generate(model(c), context('after reset'), { sessionId: 'idle' }))).stopReason, 'stop');
    }
    finally {
        release.resolve();
        await cleanup(r, c);
    }
});
test('cancellation kills an initialized CLI with blocked stdin and ignored SIGTERM', timeout, async () => {
    const c = config();
    c.cli.prefixArgs.push('--stall-after-select');
    c.cli.cancelGraceMs = 150;
    const session = new V3Session(c, c.stateDir, new Catalog([]));
    let prompt;
    try {
        await session.start('Offline cancellation test', undefined);
        await session.select('test-opus');
        const pid = session.rpc.pid;
        prompt = session.prompt('x'.repeat(4 * 1024 * 1024)).catch(error => error);
        await delay(30);
        const closed = await Promise.race([session.close().then(() => true), delay(1500).then(() => false)]);
        assert.equal(closed, true, 'shutdown must not wait indefinitely for stdin');
        assert.equal(alive(pid), false);
        await prompt;
    }
    finally {
        const pid = session.rpc.pid;
        if (pid && alive(pid)) {
            try {
                process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
            }
            catch { /* gone */ }
        }
        await session.close();
        await prompt;
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=recovery.test.js.map
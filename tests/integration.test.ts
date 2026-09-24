import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ProviderRuntime } from '../src/provider/runtime.js';
import { config, model, context, collect, addResult, cleanup } from './helpers.js';
import type { ToolCall } from '../src/types.js';
const timeout = { timeout: 15000 };
test('native handoff produces ordinary Pi tool events and resumes the same ACP prompt', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c), ctx = context();
    try {
        const a = await collect(r.generate(model(c), ctx, { sessionId: 'main' }));
        assert.equal(a.stopReason, 'toolUse');
        assert.equal(a.content.filter(x => x.type === 'toolCall').length, 1);
        assert.equal(r.metrics.toolCalls, 1);
        addResult(ctx, a);
        const b = await collect(r.generate(model(c), ctx, { sessionId: 'main' }));
        assert.equal(b.stopReason, 'stop');
        assert.match(JSON.stringify(b.content), /HOST_OK/);
        assert.equal(r.metrics.rebuilds, 0);
        assert.equal(r.journal.unresolved().length, 0);
    }
    finally {
        await cleanup(r, c);
    }
});
test('a Pi tool denial is returned as a real MCP error', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c), ctx = context();
    try {
        const a = await collect(r.generate(model(c), ctx, { sessionId: 'main' }));
        addResult(ctx, a, true);
        const b = await collect(r.generate(model(c), ctx, { sessionId: 'main' }));
        assert.match(JSON.stringify(b.content), /error HOST_DENIED/);
    }
    finally {
        await cleanup(r, c);
    }
});
test('one ACP prompt can span more than two Pi generations', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c), ctx = context('CALL_TOOL TWO_TOOLS');
    try {
        const a = await collect(r.generate(model(c), ctx, { sessionId: 'main' }));
        addResult(ctx, a);
        const b = await collect(r.generate(model(c), ctx, { sessionId: 'main' }));
        assert.equal(b.stopReason, 'toolUse');
        addResult(ctx, b);
        const end = await collect(r.generate(model(c), ctx, { sessionId: 'main' }));
        assert.equal(end.stopReason, 'stop');
        assert.equal(r.metrics.toolCalls, 2);
        assert.equal(r.metrics.rebuilds, 0);
    }
    finally {
        await cleanup(r, c);
    }
});
test('Fovea-like appended context triggers safe rebuild when steering is unqualified', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c), ctx = context();
    try {
        const a = await collect(r.generate(model(c), ctx, { sessionId: 'main' }));
        addResult(ctx, a);
        ctx.messages.push({ role: 'user', content: 'Fovea: handler signature changed while the tool ran.', timestamp: Date.now() });
        const b = await collect(r.generate(model(c), ctx, { sessionId: 'main' }));
        assert.equal(b.stopReason, 'stop');
        assert.equal(r.metrics.rebuilds, 1);
        assert.equal(r.metrics.toolCalls, 1);
        assert.match(JSON.stringify(b.content), /without repeating/);
    }
    finally {
        await cleanup(r, c);
    }
});
test('Fovea system section replacements rebuild even with the same message count', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c), ctx = context();
    try {
        const a = await collect(r.generate(model(c), ctx, { sessionId: 'main' }));
        addResult(ctx, a);
        const system = ctx.messages[0] as Record<string, unknown>;
        system.sections = { fovea: 'new exact source locations' };
        const b = await collect(r.generate(model(c), ctx, { sessionId: 'main' }));
        assert.equal(b.stopReason, 'stop');
        assert.equal(r.metrics.rebuilds, 1);
        assert.equal(r.metrics.toolCalls, 1);
    }
    finally {
        await cleanup(r, c);
    }
});
test('explicitly qualified steering version preserves the persistent session', timeout, async () => {
    const c = config();
    c.compatibility.orderedSteeringVersions = ['mock-kiro 0.1.0'];
    const r = new ProviderRuntime(c), ctx = context();
    try {
        const a = await collect(r.generate(model(c), ctx, { sessionId: 'main' }));
        addResult(ctx, a);
        ctx.messages.push({ role: 'user', content: 'NEW_FOVEA_CONTEXT', timestamp: Date.now() });
        const b = await collect(r.generate(model(c), ctx, { sessionId: 'main' }));
        assert.equal(b.stopReason, 'stop');
        assert.equal(r.metrics.rebuilds, 0);
        assert.match(JSON.stringify(b.content), /NEW_FOVEA_CONTEXT/);
    }
    finally {
        await cleanup(r, c);
    }
});
test('tool catalog changes rebuild without replaying the previous action', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c), ctx = context();
    try {
        const a = await collect(r.generate(model(c), ctx, { sessionId: 'main' }));
        addResult(ctx, a);
        ctx.messages.push({ role: 'system', content: '', toolsRemoved: [{ name: 'fabric_exec' }], toolsAdded: [{ name: 'read_only', description: 'No writes', parameters: { type: 'object' } }] });
        const b = await collect(r.generate(model(c), ctx, { sessionId: 'main' }));
        assert.equal(b.stopReason, 'stop');
        assert.equal(r.metrics.rebuilds, 1);
        assert.equal(r.metrics.toolCalls, 1);
    }
    finally {
        await cleanup(r, c);
    }
});
test('missing authoritative tool result fails uncertain instead of executing again', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c), ctx = context();
    try {
        const a = await collect(r.generate(model(c), ctx, { sessionId: 'main' }));
        ctx.messages.push(a);
        const b = await collect(r.generate(model(c), ctx, { sessionId: 'main' }));
        assert.equal(b.stopReason, 'error');
        assert.match(b.errorMessage!, /UNCERTAIN/);
        assert.equal(r.metrics.toolCalls, 1);
        assert.equal(r.journal.unresolved()[0]!.phase, 'UNCERTAIN');
    }
    finally {
        await cleanup(r, c);
    }
});
test('model switch keeps exact attribution and does not inherit Opus for Auto', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c), ctx = context('ordinary text');
    try {
        const a = await collect(r.generate(model(c), ctx, { sessionId: 'main' }));
        ctx.messages.push(a, { role: 'user', content: 'next', timestamp: 3 });
        const b = await collect(r.generate(model(c, 'auto'), ctx, { sessionId: 'main' }));
        assert.equal(b.model, 'auto');
        assert.match(JSON.stringify(b.content), /\[auto\]/);
        assert.equal(r.metrics.rebuilds, 1);
    }
    finally {
        await cleanup(r, c);
    }
});
test('unavailable planner never falls back', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c);
    try {
        const a = await collect(r.generate(model(c, 'unavailable'), context('ordinary'), { sessionId: 'main' }));
        assert.equal(a.stopReason, 'error');
        assert.match(a.errorMessage!, /MODEL_UNAVAILABLE/);
        assert.equal(r.metrics.generations, 0);
    }
    finally {
        await cleanup(r, c);
    }
});
test('cancellation during model output has one aborted terminal event', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c), ctl = new AbortController();
    try {
        const s = r.generate(model(c), context('DELAY_RESPONSE'), { sessionId: 'main', signal: ctl.signal });
        setTimeout(() => ctl.abort(), 700);
        const events = [];
        for await (const e of s)
            events.push(e);
        const a = await s.result();
        assert.equal(a.stopReason, 'aborted');
        assert.equal(events.filter(e => e.type === 'done' || e.type === 'error').length, 1);
    }
    finally {
        await cleanup(r, c);
    }
});
test('abort during a suspended handoff marks uncertainty and does not resume Kiro', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c), ctl = new AbortController();
    try {
        const a = await collect(r.generate(model(c), context(), { sessionId: 'main', signal: ctl.signal }));
        assert.equal(a.stopReason, 'toolUse');
        ctl.abort();
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(r.journal.unresolved()[0]!.phase, 'UNCERTAIN');
    }
    finally {
        await cleanup(r, c);
    }
});
test('Kiro 2.24 tags and early client catalog support a host tool round trip', timeout, async () => {
    const c = config();
    c.cli.prefixArgs.push('--tags-inventory');
    const r = new ProviderRuntime(c), ctx = context();
    try {
        const a = await collect(r.generate(model(c), ctx));
        assert.equal(a.stopReason, 'toolUse', a.errorMessage);
        addResult(ctx, a);
        const b = await collect(r.generate(model(c), ctx));
        assert.equal(b.stopReason, 'stop', b.errorMessage);
        assert.match(JSON.stringify(b.content), /HOST_OK/);
        assert.equal(r.metrics.toolCalls, 1);
    }
    finally {
        await cleanup(r, c);
    }
});
test('Kiro 2.24 native tool tags stop generation before a host action', timeout, async () => {
    const c = config();
    c.cli.prefixArgs.push('--tags-inventory', '--extra-tool');
    const r = new ProviderRuntime(c);
    try {
        const answer = await collect(r.generate(model(c), context()));
        assert.equal(answer.stopReason, 'error');
        assert.match(answer.errorMessage!, /Unexpected tool group/);
        assert.equal(r.metrics.toolCalls, 0);
    }
    finally {
        await cleanup(r, c);
    }
});
test('tool-less auxiliary inference does not consume a paused Main session', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c), ctx = context();
    try {
        const a = await collect(r.generate(model(c), ctx, { sessionId: 'main' }));
        const aux = await collect(r.generate(model(c, 'auto'), context('Summarize a sentence.'), { sessionId: 'main', toolChoice: 'none' }));
        assert.equal(aux.stopReason, 'stop');
        addResult(ctx, a);
        const b = await collect(r.generate(model(c), ctx, { sessionId: 'main' }));
        assert.equal(b.stopReason, 'stop');
        assert.equal(r.metrics.toolCalls, 1);
    }
    finally {
        await cleanup(r, c);
    }
});
test('parent blocked on a tool releases admission so a child can run at capacity one', timeout, async () => {
    const c = config();
    c.admission.maxActive = 1;
    const parent = new ProviderRuntime(c), child = new ProviderRuntime(c), ctx = context();
    try {
        const a = await collect(parent.generate(model(c), ctx, { sessionId: 'parent' }));
        assert.equal(a.stopReason, 'toolUse');
        const childResult = await collect(child.generate(model(c, 'auto'), context('child implementation'), { sessionId: 'child' }));
        assert.equal(childResult.stopReason, 'stop');
        addResult(ctx, a);
        assert.equal((await collect(parent.generate(model(c), ctx, { sessionId: 'parent' }))).stopReason, 'stop');
    }
    finally {
        await parent.close();
        await child.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('parallel sessions in the same working directory never mix model selections', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c);
    try {
        const [a, b] = await Promise.all([collect(r.generate(model(c), context('alpha'), { sessionId: 'a' })), collect(r.generate(model(c, 'auto'), context('beta'), { sessionId: 'b' }))]);
        assert.match(JSON.stringify(a.content), /test-opus/);
        assert.match(JSON.stringify(b.content), /auto/);
        assert.doesNotMatch(JSON.stringify(a.content), /beta/);
    }
    finally {
        await cleanup(r, c);
    }
});
test('unexpected native tool surfaces fail before a paid prompt', timeout, async () => {
    const c = config();
    c.cli.prefixArgs.push('--extra-tool');
    const r = new ProviderRuntime(c);
    try {
        const a = await collect(r.generate(model(c), context(), { sessionId: 'main' }));
        assert.equal(a.stopReason, 'error');
        assert.match(a.errorMessage!, /Unexpected tool/);
        assert.equal(r.metrics.generations, 0);
    }
    finally {
        await cleanup(r, c);
    }
});
test('unexpected client filesystem request is denied, never executed', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c);
    try {
        const a = await collect(r.generate(model(c), context('NATIVE_EFFECT'), { sessionId: 'main' }));
        assert.equal(a.stopReason, 'error');
        assert.match(a.errorMessage!, /Unexpected Kiro client action/);
        assert.equal(r.metrics.toolCalls, 0);
    }
    finally {
        await cleanup(r, c);
    }
});
test('malformed stdout terminates rather than being rendered as assistant text', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c);
    try {
        const a = await collect(r.generate(model(c), context('MALFORMED_FRAME'), { sessionId: 'main' }));
        assert.equal(a.stopReason, 'error');
        assert.match(a.errorMessage!, /Malformed/);
        assert.equal(a.content.length, 0);
    }
    finally {
        await cleanup(r, c);
    }
});
test('reset refuses unresolved host effects', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c);
    try {
        await collect(r.generate(model(c), context(), { sessionId: 'main' }));
        await assert.rejects(r.reset(), /refuses pending/);
    }
    finally {
        await cleanup(r, c);
    }
});
test('onPayload cannot change the selected model or inference transport', async () => {
    const c = config(), r = new ProviderRuntime(c);
    try {
        const a = await collect(r.generate(model(c), context(), { onPayload: () => ({ transport: 'other', modelId: 'bad', context: context() }) }));
        assert.equal(a.stopReason, 'error');
        assert.match(a.errorMessage!, /re-routed/);
    }
    finally {
        await cleanup(r, c);
    }
});
test('usage stays explicitly unknown rather than fabricated billing', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c);
    try {
        const a = await collect(r.generate(model(c), context('ordinary'), { sessionId: 'main' }));
        assert.equal(a.usage.cost.total, 0);
        assert.match(r.metrics.usageProvenance, /not free/);
    }
    finally {
        await cleanup(r, c);
    }
});
test('result-only consumers can immediately start the next Pi generation', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c), ctx = context();
    try {
        const a = await r.generate(model(c), ctx, { sessionId: 'direct-result' }).result();
        assert.equal(a.stopReason, 'toolUse');
        addResult(ctx, a);
        const b = await r.generate(model(c), ctx, { sessionId: 'direct-result' }).result();
        assert.equal(b.stopReason, 'stop');
    }
    finally {
        await cleanup(r, c);
    }
});
test('recorded Pi results recover across an extension reload in the same host PID', timeout, async () => {
    const c = config(), first = new ProviderRuntime(c), ctx = context();
    let second: ProviderRuntime | undefined;
    try {
        const a = await collect(first.generate(model(c), ctx, { sessionId: 'restart' }));
        addResult(ctx, a);
        await first.close();
        second = new ProviderRuntime(c);
        const b = await collect(second.generate(model(c), ctx, { sessionId: 'restart' }));
        assert.equal(b.stopReason, 'stop');
        assert.match(JSON.stringify(b.content), /without repeating/);
        assert.equal(second.metrics.toolCalls, 0);
        assert.equal(second.journal.unresolved().length, 0);
    }
    finally {
        await first.close();
        await second?.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('a held HTTP timeout becomes uncertain rather than a duplicate effect', timeout, async () => {
    const c = config();
    c.limits.maxHandoffMs = 150;
    const r = new ProviderRuntime(c), ctx = context();
    try {
        const a = await collect(r.generate(model(c), ctx, { sessionId: 'timeout' }));
        assert.equal(a.stopReason, 'toolUse');
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(r.journal.unresolved()[0]!.phase, 'UNCERTAIN');
        addResult(ctx, a);
        const b = await collect(r.generate(model(c), ctx, { sessionId: 'timeout' }));
        assert.equal(b.stopReason, 'stop');
        assert.equal(r.metrics.toolCalls, 1);
    }
    finally {
        await cleanup(r, c);
    }
});
test('a real host-side file effect runs once and survives context reconstruction', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c), ctx = context();
    let effects = 0;
    try {
        const a = await collect(r.generate(model(c), ctx, { sessionId: 'file-effect' }));
        for (const call of a.content.filter((x): x is ToolCall => x.type === 'toolCall')) {
            assert.equal(call.name, 'fabric_exec');
            effects++;
            fs.writeFileSync(c.stateDir + '/host-marker', 'applied');
        }
        addResult(ctx, a);
        ctx.messages.push({ role: 'user', content: 'Fovea observed marker change.', timestamp: Date.now() });
        const b = await collect(r.generate(model(c), ctx, { sessionId: 'file-effect' }));
        assert.equal(b.stopReason, 'stop');
        assert.equal(effects, 1);
        assert.equal(fs.readFileSync(c.stateDir + '/host-marker', 'utf8'), 'applied');
    }
    finally {
        await cleanup(r, c);
    }
});
test('concurrent calls to one active conversation are rejected without corrupting it', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c), ctl = new AbortController();
    try {
        const first = r.generate(model(c), context('DELAY_RESPONSE'), { sessionId: 'same', signal: ctl.signal });
        const second = await collect(r.generate(model(c), context('other request'), { sessionId: 'same' }));
        assert.equal(second.stopReason, 'error');
        assert.match(second.errorMessage!, /BUSY/);
        ctl.abort();
        assert.equal((await collect(first)).stopReason, 'aborted');
    }
    finally {
        await cleanup(r, c);
    }
});
test('discovery obtains model effort metadata without sending a prompt', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c);
    try {
        const result = await r.discover();
        assert.ok(result.models.find(m => m.id === 'test-opus')!.efforts!.includes('high'));
        assert.equal(r.metrics.generations, 0);
    }
    finally {
        await cleanup(r, c);
    }
});
test('provider shutdown during startup leaves no active generation', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c);
    try {
        const s = r.generate(model(c), context('DELAY_RESPONSE'), { sessionId: 'shutdown' });
        const close = r.close();
        const a = await collect(s);
        await close;
        assert.ok(['error', 'aborted'].includes(a.stopReason));
    }
    finally {
        await cleanup(r, c);
    }
});
test('shutdown during an asynchronous payload hook never starts Kiro', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c);
    try {
        const s = r.generate(model(c), context(), { onPayload: () => new Promise(() => { }) });
        await r.close();
        assert.equal((await collect(s)).stopReason, 'aborted');
    }
    finally {
        await cleanup(r, c);
    }
});
test('shutdown during catalog discovery cancels the unbilled subprocess', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c);
    try {
        const p = r.discover();
        const outcome = p.then(() => false, () => true);
        await r.close();
        assert.ok(await outcome);
    }
    finally {
        await cleanup(r, c);
    }
});
test('unexpected selected-model changes are not accepted as silent fallback', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c);
    try {
        const a = await collect(r.generate(model(c), context('MODEL_FALLBACK'), { sessionId: 'pinned' }));
        assert.equal(a.stopReason, 'error');
        assert.match(a.errorMessage!, /changed the selected model/);
    }
    finally {
        await cleanup(r, c);
    }
});
test('retransmitted MCP IDs expose exactly one Pi tool call', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c), ctx = context('CALL_TOOL DUPLICATE_TOOL_REQUEST');
    try {
        const a = await collect(r.generate(model(c), ctx, { sessionId: 'duplicate' }));
        assert.equal(a.stopReason, 'toolUse');
        addResult(ctx, a);
        const b = await collect(r.generate(model(c), ctx, { sessionId: 'duplicate' }));
        assert.equal(b.stopReason, 'stop');
        assert.equal(r.metrics.toolCalls, 1);
    }
    finally {
        await cleanup(r, c);
    }
});

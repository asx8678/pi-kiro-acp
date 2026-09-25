import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { ProviderRuntime } from '../src/provider/runtime.js';
import { Binding } from '../src/sessions/coordinator.js';
import { Journal, type HandoffPhase } from '../src/storage/journal.js';
import { V3Session } from '../src/kiro/v3.js';
import { inspectCli } from '../src/kiro/jsonrpc.js';
import { Catalog } from '../src/tools/catalog.js';
import { alive, deferred } from '../src/util.js';
import { cancelled } from '../src/errors.js';
import { config, context, model, collect, addResult } from './helpers.js';

const timeout = { timeout: 15000 };
async function bounded<T>(promise: Promise<T>, ms = 2500): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Test deadline exceeded')), ms); })]); }
    finally { clearTimeout(timer); }
}
async function until(ready: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!ready()) { assert.ok(Date.now() < deadline, 'Fixture readiness deadline exceeded'); await delay(10); }
}
function bindingOf(r: ProviderRuntime): Binding {
    return [...(r as unknown as { bindings: Map<string, Binding> }).bindings.values()][0]!;
}
// Only needed to clean up a pre-fix regression failure; normal tests use public close.
async function rescue(r: ProviderRuntime, b?: Binding): Promise<void> {
    if (b) {
        await bounded(b.kiro.close()).catch(() => {}); await b.bridge.close();
        const stalled = b as unknown as { writer?: { fail(error: Error): void }; complete: ReturnType<typeof deferred<void>> };
        stalled.writer?.fail(cancelled()); stalled.complete.resolve();
    }
    await bounded(r.close()).catch(() => {});
    if (!r.journal.closed) r.journal.close();
}

for (const action of ['abort', 'close', 'failure'] as const) test(`SQLite contention cannot prevent ${action} from stopping a generation`, timeout, async () => {
    const c = config(), r = new ProviderRuntime(c), other = new Journal(c.stateDir);
    r.journal.db.exec('PRAGMA busy_timeout=20');
    let locked = false, b: Binding | undefined;
    try {
        const answer = collect(r.generate(model(c), context('DELAY_RESPONSE'), { sessionId: 'locked-cancel' }));
        await until(() => r.journal.db.prepare('SELECT COUNT(*) AS n FROM credit_prompts').get()?.n === 1);
        b = bindingOf(r); const pid = b.kiro.rpc.pid!;
        other.db.exec('BEGIN IMMEDIATE'); locked = true;
        if (action === 'failure') {
            assert.doesNotThrow(() => b!.kiro.rpc.onNotification('session/update', { sessionId: b!.kiro.sessionId, update: {
                sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', category: 'model', currentValue: 'auto', options: [{ value: 'auto', name: 'Auto' }] }],
            } }));
        } else {
            await assert.rejects(bounded(action === 'abort' ? r.abortActive() : r.close()), /locked/);
        }
        const result = await bounded(answer);
        assert.equal(alive(pid), false, 'owned CLI survived cleanup');
        if (action === 'failure') assert.match(result.errorMessage!, /POLICY:.*selected model/);
        else assert.equal(result.stopReason, 'aborted');
        assert.match(result.errorMessage!, /cleanup failed.*locked/i);
        other.db.exec('ROLLBACK'); locked = false;
        await bounded(r.close()).catch(error => assert.doesNotMatch(String(error), /Test deadline/));
        assert.equal(r.journal.closed, true);
    } finally {
        if (locked) other.db.exec('ROLLBACK'); other.close();
        await rescue(r, b); fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});

for (const timing of ['reply-received', 'rpc-pending'] as const) test(`prompt deadline covers stalled observers with ${timing}`, timeout, async () => {
    const c = config(); c.cli.promptTimeoutMs = 300; c.limits.maxHandoffMs = 200; c.admission.maxActive = 1;
    const r = new ProviderRuntime(c), entered = deferred<void>(), gate = deferred<void>();
    let callbacks = 0;
    try {
        const answer = collect(r.generate(model(c), context(timing === 'rpc-pending' ? 'DELAY_RESPONSE' : 'plain output'), {
            sessionId: 'observer-deadline', onProviderStreamEvent: async () => { callbacks++; entered.resolve(); await gate.promise; },
        }));
        if (timing === 'rpc-pending') {
            await until(() => r.journal.db.prepare('SELECT COUNT(*) AS n FROM credit_prompts').get()?.n === 1);
            const s = bindingOf(r).kiro;
            s.rpc.onNotification('session/update', { sessionId: s.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'synthetic progress' } } });
        }
        await bounded(entered.promise);
        const result = await bounded(answer, 1500);
        assert.match(result.errorMessage!, /TIMEOUT/);
        assert.deepEqual(r.admission.status(), []);
        const count = callbacks; gate.reject(new Error('Late hook rejection')); await delay(20); assert.equal(callbacks, count);
        assert.equal((await collect(r.generate(model(c), context('next conversation'), { sessionId: 'next' }))).stopReason, 'stop');
    } finally { gate.resolve(); await r.close(); fs.rmSync(c.stateDir, { recursive: true, force: true }); }
});

test('abort closes every active binding even when lease bookkeeping fails', timeout, async () => {
    const c = config(); c.admission.maxActive = 2;
    const r = new ProviderRuntime(c), other = new Journal(c.stateDir);
    r.journal.db.exec('PRAGMA busy_timeout=20');
    let locked = false;
    try {
        const answers = ['a', 'b'].map(sessionId => collect(r.generate(model(c), context('DELAY_RESPONSE'), { sessionId })));
        await until(() => r.journal.db.prepare('SELECT COUNT(*) AS n FROM credit_prompts').get()?.n === 2);
        const bindings = [...(r as unknown as { bindings: Map<string, Binding> }).bindings.values()];
        const pids = bindings.map(binding => binding.kiro.rpc.pid!);
        other.db.exec('BEGIN IMMEDIATE'); locked = true;
        await assert.rejects(bounded(r.abortActive()), /locked/);
        assert.deepEqual(pids.map(alive), [false, false]);
        for (const answer of await bounded(Promise.all(answers))) {
            assert.equal(answer.stopReason, 'aborted'); assert.match(answer.errorMessage!, /cleanup failed.*locked/i);
        }
        other.db.exec('ROLLBACK'); locked = false;
        await r.close(); assert.equal(r.journal.closed, true);
    } finally {
        if (locked) other.db.exec('ROLLBACK'); other.close(); await rescue(r);
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});

test('blocked handoff retirement preserves uncertainty and never replays a host effect', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c), other = new Journal(c.stateDir), ctx = context();
    r.journal.db.exec('PRAGMA busy_timeout=20');
    let locked = false, next: ProviderRuntime | undefined;
    try {
        const first = await collect(r.generate(model(c), ctx, { sessionId: 'blocked-effect' }));
        assert.equal(first.stopReason, 'toolUse');
        const b = bindingOf(r), pid = b.kiro.rpc.pid!, row = r.journal.unresolved()[0]!;
        other.db.exec('BEGIN IMMEDIATE'); locked = true;
        await assert.rejects(bounded(r.abortActive()), /locked/);
        assert.equal(alive(pid), false);
        assert.equal(r.journal.get(row.id)?.phase, 'EXPOSED_TO_PI');
        other.db.exec('ROLLBACK'); locked = false;
        await r.close();
        next = new ProviderRuntime(c);
        assert.equal(next.journal.get(row.id)?.phase, 'UNCERTAIN');
        const refused = await collect(next.generate(model(c), ctx, { sessionId: 'blocked-effect' }));
        assert.match(refused.errorMessage!, /UNCERTAIN/);
        addResult(ctx, first);
        assert.equal((await collect(next.generate(model(c), ctx, { sessionId: 'blocked-effect' }))).stopReason, 'stop');
        assert.equal(next.metrics.toolCalls, 0);
    } finally {
        if (locked) other.db.exec('ROLLBACK'); other.close(); await next?.close(); await rescue(r);
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});

test('one prompt deadline spans multiple Pi handoffs and accepts a late authoritative result', timeout, async () => {
    const c = config(); c.cli.promptTimeoutMs = 2000; c.limits.maxHandoffMs = 1900;
    const r = new ProviderRuntime(c), ctx = context('CALL_TOOL TWO_TOOLS');
    try {
        const first = await collect(r.generate(model(c), ctx, { sessionId: 'one-deadline' }));
        assert.equal(first.stopReason, 'toolUse');
        const b = bindingOf(r);
        await delay(1100); addResult(ctx, first);
        const second = await collect(r.generate(model(c), ctx, { sessionId: 'one-deadline' }));
        assert.equal(second.stopReason, 'toolUse');
        assert.equal(r.journal.db.prepare('SELECT COUNT(*) AS n FROM credit_prompts').get()?.n, 1);
        assert.match((await bounded(b.kiro.failed.promise, 1500)).message, /deadline/);
        await b.close(); assert.deepEqual(r.admission.status(), []);
        assert.equal(r.journal.unresolved()[0]?.phase, 'UNCERTAIN');
        addResult(ctx, second);
        const end = await collect(r.generate(model(c), ctx, { sessionId: 'one-deadline' }));
        assert.equal(end.stopReason, 'stop', end.errorMessage);
        assert.equal(r.metrics.toolCalls, 2); assert.equal(r.journal.unresolved().length, 0);
    } finally { await r.close(); fs.rmSync(c.stateDir, { recursive: true, force: true }); }
});

test('prompt deadline also cancels a stalled pre-send hook', timeout, async () => {
    const c = config(); c.cli.promptTimeoutMs = 100;
    const s = new V3Session(c, c.stateDir, new Catalog([])), gate = deferred<void>();
    s.onEvent = async event => { if (event.kind === 'prompt_start') await gate.promise; };
    try {
        await s.start('Offline pre-send deadline', undefined); await s.select('test-opus', undefined);
        const pid = s.rpc.pid!;
        await assert.rejects(bounded(s.prompt('No prompt should be sent')), { code: 'TIMEOUT' });
        await bounded(s.close()); assert.equal(alive(pid), false);
        gate.reject(new Error('Late pre-send rejection')); await delay(10);
    } finally { gate.resolve(); await s.close(); fs.rmSync(c.stateDir, { recursive: true, force: true }); }
});

test('failed runtime initialization closes the journal without masking the startup error', () => {
    const c = config(), other = new Journal(c.stateDir), reconcile = Journal.prototype.reconcileDeadOwners;
    const failure = new Error('Injected startup failure'); let opened: Journal | undefined, locked = false;
    Journal.prototype.reconcileDeadOwners = function () {
        opened = this; this.db.exec('PRAGMA busy_timeout=20');
        other.db.exec('BEGIN IMMEDIATE'); locked = true; throw failure;
    };
    try {
        assert.throws(() => new ProviderRuntime(c), error => error === failure);
        assert.equal(opened?.closed, true);
        assert.throws(() => opened!.db.prepare('SELECT 1'), /not open/);
    } finally {
        Journal.prototype.reconcileDeadOwners = reconcile;
        if (locked) other.db.exec('ROLLBACK'); other.close(); opened?.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});

test('inspection spawn failures remove the abort listener and settle cleanup', timeout, async () => {
    const c = config(), ctl = new AbortController(); c.cli.binary = c.stateDir + '/nonexistent-kiro';
    try {
        await assert.rejects(bounded(inspectCli(c, ctl.signal)), { code: 'TRANSPORT' });
        assert.equal(getEventListeners(ctl.signal, 'abort').length, 0);
    } finally { ctl.abort(); fs.rmSync(c.stateDir, { recursive: true, force: true }); }
});

test('owned abandonment re-reads a concurrently recorded result before retiring it', () => {
    const c = config(), j = new Journal(c.stateDir), other = new Journal(c.stateDir);
    const row = j.receive({ binding: 'abandon-race', generation: 'now', requestId: '1', toolName: 'fabric_exec', argsHash: 'args' }).row;
    j.transition(row.id, 'EXPOSED_TO_PI'); const unresolved = j.unresolved.bind(j);
    j.unresolved = binding => {
        const rows = unresolved(binding); other.transition(row.id, 'RESULT_RECORDED', 'real-result'); return rows;
    };
    try {
        j.abandonOwned(); assert.equal(j.get(row.id)?.phase, 'RESULT_RECORDED'); assert.equal(j.get(row.id)?.result_hash, 'real-result');
    } finally { j.close(); other.close(); fs.rmSync(c.stateDir, { recursive: true, force: true }); }
});

interface InspectionProcess { parent: number; child: number; marker: string }
function processes(dir: string): InspectionProcess[] {
    const file = dir + '/inspect-pids.jsonl';
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as InspectionProcess) : [];
}
async function stopped(rows: InspectionProcess[]): Promise<void> {
    await delay(40); const before = rows.map(row => fs.readFileSync(row.marker, 'utf8'));
    await delay(100); assert.deepEqual(rows.map(row => fs.readFileSync(row.marker, 'utf8')), before, 'inspection descendant continued running');
}
function killInspection(dir: string): void {
    for (const row of processes(dir)) for (const pid of [row.child, row.parent]) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
}
for (const action of ['abort', 'timeout', 'parent-exit', 'oversized'] as const) test(`inspection cleans its process tree after ${action}`, { ...timeout, skip: process.platform === 'win32' }, async () => {
    const c = config(), ctl = new AbortController(); c.cli.rpcTimeoutMs = 600; c.cli.cancelGraceMs = 100;
    c.cli.prefixArgs = [fileURLToPath(new URL('../../fixtures/inspection-tree.mjs', import.meta.url)), c.stateDir, action];
    const pending = inspectCli(c, ctl.signal);
    const result: Promise<unknown> = action === 'parent-exit' ? pending : assert.rejects(pending, { code: action === 'abort' ? 'CANCELLED' : action === 'timeout' ? 'TIMEOUT' : 'LIMIT' });
    try {
        await until(() => processes(c.stateDir).length > 0);
        if (action === 'abort') ctl.abort();
        await bounded(result);
        assert.equal(getEventListeners(ctl.signal, 'abort').length, 0);
        assert.equal(processes(c.stateDir).length, action === 'parent-exit' ? 2 : 1);
        await stopped(processes(c.stateDir));
    } finally { ctl.abort(); await pending.catch(() => {}); killInspection(c.stateDir); fs.rmSync(c.stateDir, { recursive: true, force: true }); }
});

test('session close drains an in-progress inspection even without a caller signal', { ...timeout, skip: process.platform === 'win32' }, async () => {
    const c = config(); c.cli.rpcTimeoutMs = 1000; c.cli.cancelGraceMs = 100;
    c.cli.prefixArgs = [fileURLToPath(new URL('../../fixtures/inspection-tree.mjs', import.meta.url)), c.stateDir, 'hang'];
    const s = new V3Session(c, c.stateDir, new Catalog([])), start = s.start('Offline inspection cancellation', undefined);
    const rejected = assert.rejects(start, { code: 'CANCELLED' });
    try {
        await until(() => processes(c.stateDir).length > 0);
        await bounded(s.close()); await bounded(rejected); await stopped(processes(c.stateDir));
    } finally { await s.close(); await start.catch(() => {}); await rejected.catch(() => {}); killInspection(c.stateDir); fs.rmSync(c.stateDir, { recursive: true, force: true }); }
});

for (const phase of ['RESULT_RECORDED', 'RETURNED_TO_KIRO', 'CANCELLED'] as const) test(`recovery preserves concurrently reconciled phase ${phase}`, () => {
    const c = config(), old = new Journal(c.stateDir);
    const row = old.receive({ binding: 'race', generation: 'old', requestId: '1', toolName: 'fabric_exec', argsHash: 'args' }).row;
    old.transition(row.id, 'EXPOSED_TO_PI'); old.close();
    const first = new Journal(c.stateDir), second = new Journal(c.stateDir), unresolved = first.unresolved.bind(first);
    let raced = false;
    first.unresolved = binding => {
        const rows = unresolved(binding);
        if (!raced) { raced = true; second.transition(row.id, 'RESULT_RECORDED', 'real-result'); if (phase !== 'RESULT_RECORDED') second.transition(row.id, phase); }
        return rows;
    };
    try {
        assert.doesNotThrow(() => first.reconcileDeadOwners());
        assert.equal(first.get(row.id)?.phase, phase);
        assert.equal(first.get(row.id)?.result_hash, 'real-result');
        first.reconcileDeadOwners(); assert.equal(first.get(row.id)?.phase, phase);
    } finally { first.close(); second.close(); fs.rmSync(c.stateDir, { recursive: true, force: true }); }
});

test('recovery checks liveness and phase under the same write transaction', () => {
    const c = config(), old = new Journal(c.stateDir);
    const rows = (['RECEIVED', 'EXPOSED_TO_PI'] as HandoffPhase[]).map((phase, i) => {
        const row = old.receive({ binding: 'dead', generation: 'old', requestId: String(i), toolName: 'fabric_exec', argsHash: 'args' }).row;
        if (phase !== 'RECEIVED') old.transition(row.id, phase); return row;
    });
    old.close(); const j = new Journal(c.stateDir), live = j.ownerLive.bind(j);
    j.ownerLive = (instance, pid) => { assert.equal(j.inTransaction, true); return live(instance, pid); };
    try {
        j.reconcileDeadOwners(); assert.deepEqual(rows.map(row => j.get(row.id)?.phase), ['CANCELLED', 'UNCERTAIN']);
        const own = j.receive({ binding: 'live', generation: 'now', requestId: '1', toolName: 'fabric_exec', argsHash: 'args' }).row;
        j.reconcileDeadOwners(); assert.equal(j.get(own.id)?.phase, 'RECEIVED');
    } finally { j.close(); fs.rmSync(c.stateDir, { recursive: true, force: true }); }
});
